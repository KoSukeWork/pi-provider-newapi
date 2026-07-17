/**
 * NewAPI Provider Extension for pi (v0.80.8+)
 *
 * Manages multiple named providers backed by self-hosted NewAPI AI gateways.
 * Each provider defined in provider-newapi.json is registered with an initial
 * empty catalog plus a dynamic `refreshModels(context)` callback. Pi owns the
 * API key (via /login) and drives discovery through its model runtime, so the
 * extension never reads or mutates credentials directly.
 *
 * Config:   <agentDir>/extensions/provider-newapi.json
 *           { providers: { <name>: { baseUrl, modelOverrides } }, settings: { ... } }
 * Keys:     owned by Pi's credential store (normally <agentDir>/auth.json).
 *           Enter/update via `/login <name>`; remove via `/logout <name>`.
 *
 * Commands:
 *   /newapi-provider-add [name]    — add a gateway config and register it
 *   /newapi-provider-remove [name] — remove a gateway config and unregister it
 *   /newapi-provider-list          — list configured providers and their status
 */

import {
	type Api,
	type Model,
	type ModelThinkingLevel,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import {
	getModels,
	getProviders,
	type BuiltinProvider,
} from "@earendil-works/pi-ai/compat";
import {
	getAgentDir,
	type ExtensionAPI,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "provider-newapi.json";
const QUOTA_PER_USD = 500_000;
const TOKENS_PER_COST = 1_000_000;
const DEFAULT_GROUP_RATE = 1.0;
const FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_MODEL_API: Api = "anthropic-messages";
const ONBOARDING_WARN_MAX = 3;

const SUPPORTED_NEWAPI_MODEL_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
]);

/**
 * NewAPI advertises the endpoint types it serves for each model in
 * `supported_endpoint_types` (e.g. ["anthropic", "openai"]). Map each endpoint
 * type to the Pi model APIs it can drive.
 */
const ENDPOINT_TYPE_TO_APIS: Record<string, readonly Api[]> = {
	anthropic: ["anthropic-messages"],
	openai: ["openai-completions", "openai-responses"],
};

/** Preferred order when a gateway advertises several usable APIs for a model. */
const API_PREFERENCE: readonly Api[] = [
	"anthropic-messages",
	"openai-responses",
	"openai-completions",
];

const ENRICHMENT_PROVIDERS = [
	"deepseek",
	"zai",
	"google",
	"anthropic",
	"minimax",
	"moonshotai",
	"xiaomi",
	"openai",
	// fallback
	"vercel-ai-gateway",
] as const;

// ---------------------------------------------------------------------------
// Errors — distinguish cancellation / timeout / auth / http / payload
// ---------------------------------------------------------------------------

type NewAPIErrorCode = "aborted" | "timeout" | "auth" | "http" | "payload" | "network";

class NewAPIError extends Error {
	readonly code: NewAPIErrorCode;

	constructor(code: NewAPIErrorCode, message: string) {
		super(message);
		this.name = "NewAPIError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with a local timeout that also honors an upstream abort signal (e.g.
 * Pi's /model refresh or forced-refresh cancellation). The two signals are
 * combined so either one aborts the request.
 */
async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeoutMs?: number; signal?: AbortSignal | null } = {},
): Promise<Response> {
	const { timeoutMs = FETCH_TIMEOUT_MS, signal: upstream, ...fetchOptions } = options;

	if (upstream?.aborted) {
		throw new NewAPIError("aborted", `fetch(${url}) aborted before start`);
	}

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

	const signals: AbortSignal[] = [timeoutController.signal];
	if (upstream) signals.push(upstream);
	const combined =
		typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : timeoutController.signal;

	// Bridge: if AbortSignal.any is unavailable, forward the upstream abort.
	let bridge: (() => void) | undefined;
	if (typeof AbortSignal.any !== "function" && upstream) {
		bridge = () => timeoutController.abort();
		upstream.addEventListener("abort", bridge, { once: true });
	}

	try {
		return await fetch(url, { ...fetchOptions, signal: combined });
	} catch (err) {
		if (upstream?.aborted) {
			throw new NewAPIError("aborted", `fetch(${url}) cancelled`);
		}
		if (timeoutController.signal.aborted) {
			throw new NewAPIError("timeout", `fetch(${url}) timed out after ${timeoutMs / 1000}s`);
		}
		throw new NewAPIError(
			"network",
			`fetch(${url}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		clearTimeout(timer);
		if (bridge && upstream) upstream.removeEventListener("abort", bridge);
	}
}

export function resolveApiBaseUrl(baseUrl: string, api: Api): string {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return `${baseUrl.replace(/\/+$/, "")}/v1`;
		default:
			return baseUrl;
	}
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface NewAPIModelInfo {
	api?: Api;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

interface ProviderEntry {
	baseUrl: string;
	modelOverrides: Record<string, NewAPIModelInfo>;
}

interface Settings {
	onboardingWarnCountdown?: number;
}

interface NewAPIConfig {
	providers: Record<string, ProviderEntry>;
	settings: Settings;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function getConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

function readConfig(): NewAPIConfig {
	const configPath = getConfigPath();
	const empty: NewAPIConfig = { providers: {}, settings: {} };

	if (!existsSync(configPath)) return empty;

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		console.warn(
			`NewAPI: could not read config: ${err instanceof Error ? err.message : String(err)}`,
		);
		return empty;
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		invalidateConfig(configPath, raw);
		return { providers: {}, settings: {} };
	}

	if (
		typeof data !== "object" ||
		data === null ||
		!("providers" in data) ||
		typeof (data as Record<string, unknown>).providers !== "object" ||
		(data as Record<string, unknown>).providers === null
	) {
		invalidateConfig(configPath, raw);
		return { providers: {}, settings: {} };
	}

	const d = data as Record<string, unknown>;
	return {
		providers: (d.providers as Record<string, ProviderEntry>) ?? {},
		settings:
			typeof d.settings === "object" && d.settings !== null
				? (d.settings as Settings)
				: {},
	};
}

function invalidateConfig(configPath: string, raw: string): void {
	const backupPath = `${configPath}.bak`;
	console.warn(
		`NewAPI: config is invalid — backing up to ${backupPath} and starting with empty config.`,
	);
	try {
		writeFileSync(backupPath, raw, "utf-8");
	} catch (err) {
		console.warn(
			`NewAPI: could not write config backup: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	// Reset the original to a valid empty config so the next startup doesn't
	// hit the same validation error again.
	try {
		writeConfigAtomic({ providers: {}, settings: {} });
	} catch (err) {
		console.warn(
			`NewAPI: could not reset config file: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Atomic write: serialize to a temp file, then rename over the target. */
function writeConfigAtomic(config: NewAPIConfig): void {
	const configPath = getConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
	renameSync(tmpPath, configPath);
}

/**
 * Serialized read-modify-write of the config file. Concurrent refreshes each
 * re-read the latest config before merging their own changes, so no provider
 * entry is lost. The mutator returns `true` when it changed something.
 */
let configWriteQueue: Promise<void> = Promise.resolve();

function updateConfig(mutator: (config: NewAPIConfig) => boolean): Promise<void> {
	const run = configWriteQueue.then(async () => {
		const config = readConfig();
		if (mutator(config)) {
			writeConfigAtomic(config);
		}
	});
	// Keep the queue alive even if one update rejects.
	configWriteQueue = run.catch(() => {});
	return run;
}

// ---------------------------------------------------------------------------
// Cost helpers
//
// From NewAPI rate-settings.md:
//   Quota = (Input + Output × CompletionRate) × ModelRate × GroupRate
//   1 USD = 500,000 quota points
// ---------------------------------------------------------------------------

export function calcInputCost(modelRate: number): number {
	return modelRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function calcOutputCost(modelRate: number, completionRate: number): number {
	return modelRate * completionRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function calcCacheCost(modelRate: number, ratio: number): number {
	return modelRate * ratio * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

// ---------------------------------------------------------------------------
// Ratio matching — NewAPI may return model IDs with version tags or different
// casing than ratio_config keys.
// ---------------------------------------------------------------------------

export function findRatio(modelId: string, ratios: Record<string, number>): number | undefined {
	if (modelId in ratios) return ratios[modelId];
	const lower = modelId.toLowerCase();
	for (const [key, val] of Object.entries(ratios)) {
		if (key.toLowerCase() === lower) return val;
	}
	for (const [key, val] of Object.entries(ratios)) {
		if (lower.startsWith(key.toLowerCase())) return val;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Model enrichment — build a lookup keyed by stripped/normalised model ID.
// Earlier providers in ENRICHMENT_PROVIDERS take precedence.
//
// The lookup only depends on Pi's built-in catalog, which is immutable for the
// life of the process, so it is built once and reused across provider refreshes.
// ---------------------------------------------------------------------------

interface ModelLookupItem {
	model: Model<Api>;
	source: string;
}

let cachedEnrichmentLookup: Map<string, ModelLookupItem> | undefined;

function getEnrichmentLookup(): Map<string, ModelLookupItem> {
	if (cachedEnrichmentLookup) return cachedEnrichmentLookup;

	const lookup = new Map<string, ModelLookupItem>();

	for (const provider of ENRICHMENT_PROVIDERS) {
		let providerModels: Model<Api>[];
		try {
			providerModels = getModels(provider as BuiltinProvider) as Model<Api>[];
		} catch {
			continue;
		}

		for (const m of providerModels) {
			if (!SUPPORTED_NEWAPI_MODEL_APIS.has(m.api)) continue;

			const stripped = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
			const normalizedId = stripped.replaceAll(".", "-").toLowerCase();

			if (!lookup.has(normalizedId)) {
				const model: Model<Api> = {
					...m,
					compat: {
						...(m.compat as Record<string, unknown> | undefined),
						supportsDeveloperRole: provider === "anthropic" || provider === "openai",
					} as Model<Api>["compat"],
				};
				lookup.set(normalizedId, { model, source: provider });
			}
		}
	}

	cachedEnrichmentLookup = lookup;
	return lookup;
}

// ---------------------------------------------------------------------------
// NewAPI response types + defensive parsing
// ---------------------------------------------------------------------------

interface NewAPIModelEntry {
	/** Model ID, e.g. "claude-opus-4-7". */
	id: string;
	/** Upstream owner label reported by the gateway, e.g. "google gemini". */
	ownedBy?: string;
	/** Endpoint types the gateway serves for this model, e.g. ["anthropic", "openai"]. */
	supportedEndpointTypes: string[];
}

interface Ratios {
	modelRatios: Record<string, number>;
	completionRatios: Record<string, number>;
	cacheRatios: Record<string, number>;
	createCacheRatios: Record<string, number>;
}

const EMPTY_RATIOS: Ratios = {
	modelRatios: {},
	completionRatios: {},
	cacheRatios: {},
	createCacheRatios: {},
};

/** Parse a /v1/models payload defensively into NewAPI model entries. */
export function parseModelsResponse(json: unknown): NewAPIModelEntry[] {
	if (typeof json !== "object" || json === null) {
		throw new NewAPIError("payload", "/v1/models returned a non-object payload");
	}
	const data = (json as Record<string, unknown>).data;
	if (!Array.isArray(data)) {
		throw new NewAPIError("payload", "/v1/models payload has no data array");
	}
	const out: NewAPIModelEntry[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.id !== "string") continue;
		out.push({
			id: rec.id,
			ownedBy: typeof rec.owned_by === "string" ? rec.owned_by : undefined,
			supportedEndpointTypes: Array.isArray(rec.supported_endpoint_types)
				? rec.supported_endpoint_types.filter((t): t is string => typeof t === "string")
				: [],
		});
	}
	return out;
}

function asRatioMap(value: unknown): Record<string, number> {
	if (typeof value !== "object" || value === null) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
	}
	return out;
}

/** Parse a /api/ratio_config payload defensively. Returns empty maps on any issue. */
export function parseRatioConfig(json: unknown): Ratios {
	if (typeof json !== "object" || json === null) return EMPTY_RATIOS;
	const root = json as Record<string, unknown>;
	if (root.success === false) return EMPTY_RATIOS;
	const data = (root.data ?? root) as Record<string, unknown>;
	return {
		modelRatios: asRatioMap(data.model_ratio),
		completionRatios: asRatioMap(data.completion_ratio),
		cacheRatios: asRatioMap(data.cache_ratio),
		createCacheRatios: asRatioMap(data.create_cache_ratio),
	};
}

// ---------------------------------------------------------------------------
// Pure model construction — turns raw model IDs + ratios + config into the
// provider model definitions Pi expects. Produces any newly-generated
// unknown-model override templates as a separate map so the caller can merge
// them into config atomically.
// ---------------------------------------------------------------------------

interface BuildModelsResult {
	models: ProviderModelConfig[];
	newOverrides: Record<string, NewAPIModelInfo>;
}

/** Resolve the set of supported model APIs the gateway advertises for a model. */
function gatewayApisFor(entry: NewAPIModelEntry): Set<Api> {
	const apis = new Set<Api>();
	for (const type of entry.supportedEndpointTypes) {
		for (const api of ENDPOINT_TYPE_TO_APIS[type] ?? []) apis.add(api);
	}
	return apis;
}

/**
 * Choose a model API. A caller-preferred API (from built-in enrichment or a
 * configured override) is kept when the gateway advertises it, or when the
 * gateway advertised nothing usable. Otherwise the best gateway-advertised API
 * is used, falling back to the default.
 */
function pickModelApi(preferred: Api | undefined, gatewayApis: Set<Api>): Api {
	if (preferred && (gatewayApis.size === 0 || gatewayApis.has(preferred))) {
		return preferred;
	}
	for (const api of API_PREFERENCE) {
		if (gatewayApis.has(api)) return api;
	}
	return preferred ?? DEFAULT_MODEL_API;
}

export function buildProviderModels(params: {
	providerName: string;
	baseUrl: string;
	apiModels: NewAPIModelEntry[];
	ratios: Ratios;
	modelOverrides: Record<string, NewAPIModelInfo>;
}): BuildModelsResult {
	const { providerName, baseUrl, apiModels, ratios, modelOverrides } = params;
	const enrichmentLookup = getEnrichmentLookup();
	const newOverrides: Record<string, NewAPIModelInfo> = {};
	const models: ProviderModelConfig[] = [];

	for (const m of apiModels) {
		const normalizedId = m.id.replaceAll(".", "-").toLowerCase();
		const enriched = enrichmentLookup.get(normalizedId);
		const gatewayApis = gatewayApisFor(m);

		let name = m.id;
		let reasoning: boolean;
		let thinkingLevelMap: ThinkingLevelMap | undefined;
		let input: ("text" | "image")[];
		let contextWindow: number;
		let maxTokens: number;
		let api: Api;
		let compat: Model<Api>["compat"] | undefined;

		if (enriched) {
			name = enriched.model.name ?? m.id;
			compat = enriched.model.compat;
			reasoning = enriched.model.reasoning;
			thinkingLevelMap = enriched.model.thinkingLevelMap;
			input = enriched.model.input;
			contextWindow = enriched.model.contextWindow;
			maxTokens = enriched.model.maxTokens;

			// Apply the configured override patch on top of built-in metadata.
			// Only fields present in the override JSON are applied; everything
			// else keeps its enriched value.
			const mi = modelOverrides[m.id];
			if (mi) {
				if (mi.reasoning !== undefined) reasoning = mi.reasoning;
				if (mi.input !== undefined) input = mi.input;
				if (mi.contextWindow !== undefined) contextWindow = mi.contextWindow;
				if (mi.maxTokens !== undefined) maxTokens = mi.maxTokens;
				if (mi.thinkingLevelMap !== undefined) thinkingLevelMap = mi.thinkingLevelMap;
			}

			// A configured override api wins; otherwise use the enriched api. Either
			// way, prefer an API the gateway actually serves for this model.
			const preferredApi = mi?.api ?? enriched.model.api;
			api = pickModelApi(preferredApi, gatewayApis);
			if (preferredApi === undefined && gatewayApis.size === 0) {
				console.warn(
					`NewAPI [${providerName}]: enriched model "${m.id}" from ${enriched.source} has no api ` +
						`and the gateway advertised none — falling back to ${api}`,
				);
			}
		} else {
			// Unknown model — use an existing override, or generate a template whose
			// default api reflects the gateway's advertised endpoints.
			let mi = modelOverrides[m.id];
			if (!mi) {
				mi = {
					api: pickModelApi(undefined, gatewayApis),
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 4096,
				};
				newOverrides[m.id] = mi;
				console.warn(
					`NewAPI [${providerName}]: unknown model "${m.id}" — template added to modelOverrides`,
				);
			}
			reasoning = mi.reasoning ?? false;
			thinkingLevelMap = mi.thinkingLevelMap;
			input = mi.input ?? ["text"];
			contextWindow = mi.contextWindow ?? 128000;
			maxTokens = mi.maxTokens ?? 4096;
			api = mi.api ?? DEFAULT_MODEL_API;
		}

		const mr = findRatio(m.id, ratios.modelRatios) ?? 0;
		const cr = findRatio(m.id, ratios.completionRatios) ?? 1;
		const cacheR = findRatio(m.id, ratios.cacheRatios) ?? 0;
		const createCacheR = findRatio(m.id, ratios.createCacheRatios) ?? 0;

		models.push({
			id: m.id,
			name,
			api,
			baseUrl: resolveApiBaseUrl(baseUrl, api),
			reasoning,
			thinkingLevelMap,
			input,
			cost: {
				input: calcInputCost(mr),
				output: calcOutputCost(mr, cr),
				cacheRead: calcCacheCost(mr, cacheR),
				cacheWrite: calcCacheCost(mr, createCacheR),
			},
			contextWindow,
			maxTokens,
			compat,
		});
	}

	return { models, newOverrides };
}

// ---------------------------------------------------------------------------
// Network discovery — fetch ratio config (best-effort) and /v1/models
// (required). Returns provider model definitions; never registers a provider.
// ---------------------------------------------------------------------------

async function discoverModels(
	providerName: string,
	entry: ProviderEntry,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BuildModelsResult> {
	const baseUrl = entry.baseUrl.replace(/\/+$/, "");

	// ratio_config — best-effort; failure or malformed payload → empty ratios.
	let ratios: Ratios = EMPTY_RATIOS;
	try {
		const ratioRes = await fetchWithTimeout(`${baseUrl}/api/ratio_config`, { signal });
		if (ratioRes.ok) {
			ratios = parseRatioConfig(await ratioRes.json());
		}
	} catch (err) {
		if (err instanceof NewAPIError && err.code === "aborted") throw err;
		console.warn(
			`NewAPI [${providerName}]: /api/ratio_config unavailable — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// /v1/models — required for a fresh network result.
	const headers: Record<string, string> = {};
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	const modelsRes = await fetchWithTimeout(`${baseUrl}/v1/models`, { headers, signal });
	if (modelsRes.status === 401 || modelsRes.status === 403) {
		throw new NewAPIError(
			"auth",
			`GET /v1/models: ${modelsRes.status} ${modelsRes.statusText} — check the API key`,
		);
	}
	if (!modelsRes.ok) {
		throw new NewAPIError("http", `GET /v1/models: ${modelsRes.status} ${modelsRes.statusText}`);
	}

	const apiModels = parseModelsResponse(await modelsRes.json());

	return buildProviderModels({
		providerName,
		baseUrl,
		apiModels,
		ratios,
		modelOverrides: entry.modelOverrides ?? {},
	});
}

// ---------------------------------------------------------------------------
// Provider registration + dynamic refresh
// ---------------------------------------------------------------------------

/**
 * Dynamic refresh callback handed to Pi. Restores the cached catalog offline,
 * fetches fresh models when network + auth allow, persists successful catalogs
 * to the provider-scoped store, and retains the last good catalog on failure.
 */
async function refreshProviderModels(
	providerName: string,
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
	// Always read the latest config so user edits to baseUrl/overrides apply.
	const config = readConfig();
	const entry = config.providers[providerName];
	if (!entry) return [];

	const cached = await context.store.read();
	// Round-trip cast: stored models were written as provider model configs.
	const cachedModels = (cached?.models ?? []) as unknown as ProviderModelConfig[];

	// Offline or cancelled: serve cache without touching the network.
	if (!context.allowNetwork || context.signal?.aborted) {
		return cachedModels;
	}

	const credential = context.credential;
	const apiKey =
		credential?.type === "api_key" && credential.key ? credential.key : undefined;

	try {
		const { models, newOverrides } = await discoverModels(
			providerName,
			entry,
			apiKey,
			context.signal,
		);

		if (models.length === 0 && cachedModels.length > 0) {
			// Never replace a good cached catalog with an empty one.
			console.warn(
				`NewAPI [${providerName}]: /v1/models returned zero models — keeping cached catalog.`,
			);
			return cachedModels;
		}

		// Merge any newly generated unknown-model templates into config safely.
		if (Object.keys(newOverrides).length > 0) {
			await updateConfig((cfg) => {
				const e = cfg.providers[providerName];
				if (!e) return false;
				e.modelOverrides = e.modelOverrides ?? {};
				let changed = false;
				for (const [id, info] of Object.entries(newOverrides)) {
					if (!e.modelOverrides[id]) {
						e.modelOverrides[id] = info;
						changed = true;
					}
				}
				return changed;
			});
		}

		// Persist the successful catalog for offline restoration. No API key is
		// ever written to the store.
		await context.store.write({
			models: models as unknown as Model<Api>[],
			checkedAt: Date.now(),
		});

		return models;
	} catch (err) {
		if (err instanceof NewAPIError && err.code === "aborted") {
			return cachedModels;
		}
		console.warn(
			`NewAPI [${providerName}]: refresh failed — ${err instanceof Error ? err.message : String(err)}` +
				(cachedModels.length > 0 ? " (serving cached catalog)" : ""),
		);
		return cachedModels;
	}
}

/**
 * Register a NewAPI provider once with an empty initial catalog plus a dynamic
 * refresh callback. The empty catalog is intentional: it declares a new
 * extension-owned dynamic provider that is immediately selectable in /login so
 * Pi can bootstrap credential entry, then drive discovery through refreshModels.
 */
function registerNewAPIProvider(pi: ExtensionAPI, name: string, entry: ProviderEntry): void {
	pi.registerProvider(name, {
		name,
		baseUrl: entry.baseUrl.replace(/\/+$/, ""),
		api: DEFAULT_MODEL_API,
		models: [],
		async refreshModels(context) {
			return refreshProviderModels(name, context);
		},
	});
}

// ---------------------------------------------------------------------------
// Default export — startup registration + commands
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const builtinProviderIds = getProviders() as unknown as string[];

	// Track which providers this session has registered (used by the list
	// command and by add/remove after live registration).
	const registered = new Set<string>();

	// -------------------------------------------------------------------------
	// Startup: register every configured provider (no network needed here — Pi
	// drives discovery via refreshModels).
	// -------------------------------------------------------------------------

	for (const [name, entry] of Object.entries(config.providers)) {
		if (builtinProviderIds.includes(name)) {
			console.warn(
				`NewAPI: skipping provider "${name}" — name collides with a built-in pi provider.`,
			);
			continue;
		}
		if (registered.has(name)) {
			console.warn(`NewAPI: skipping duplicate provider key "${name}" in config.`);
			continue;
		}
		if (!entry || typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) {
			console.warn(`NewAPI: skipping provider "${name}" — missing baseUrl.`);
			continue;
		}
		registerNewAPIProvider(pi, name, entry);
		registered.add(name);
	}

	// Onboarding nudge — shown at most ONBOARDING_WARN_MAX times when zero
	// providers are configured. Countdown is persisted in config.settings.
	if (registered.size === 0) {
		const countdown = config.settings.onboardingWarnCountdown ?? ONBOARDING_WARN_MAX;
		if (countdown > 0) {
			console.warn(
				"NewAPI: no providers configured. Run /newapi-provider-add to add a NewAPI gateway.",
			);
			void updateConfig((cfg) => {
				cfg.settings.onboardingWarnCountdown = countdown - 1;
				return true;
			});
		}
	}

	// -------------------------------------------------------------------------
	// /newapi-provider-add [name]
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-add", {
		description: "Add a new NewAPI provider (prompts for base URL; login via /login)",
		handler: async (args, ctx) => {
			// 1. Resolve provider name
			let name = args.trim();
			if (!name) {
				const input = await ctx.ui.input("Provider name", "my_gateway");
				if (input === undefined) return;
				name = input.trim();
			}

			if (!name) {
				ctx.ui.notify("Provider name cannot be empty.", "error");
				return;
			}
			if (/[\s/\\]/.test(name)) {
				ctx.ui.notify("Provider name must not contain spaces or slashes.", "error");
				return;
			}

			// 2. Validate against built-ins and existing config
			const builtins = getProviders() as unknown as string[];
			if (builtins.includes(name)) {
				ctx.ui.notify(
					`Cannot add "${name}": name collides with a built-in pi provider.`,
					"error",
				);
				return;
			}

			const current = readConfig();
			if (current.providers[name]) {
				ctx.ui.notify(
					`Provider "${name}" already exists. Run /newapi-provider-remove "${name}" first.`,
					"error",
				);
				return;
			}

			// 3. Prompt base URL
			const baseUrlRaw = await ctx.ui.input("Base URL", "https://ai.example.com");
			if (baseUrlRaw === undefined) return;
			const baseUrl = baseUrlRaw.trim().replace(/\/+$/, "");
			if (!baseUrl) {
				ctx.ui.notify("Base URL cannot be empty.", "error");
				return;
			}

			// 4. Optional unauthenticated reachability check (best-effort). Auth
			// verification happens later in refreshModels once Pi owns the key.
			try {
				const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { signal: ctx.signal });
				// 401/403 still means the gateway is reachable — that's fine here.
				if (!res.ok && res.status !== 401 && res.status !== 403) {
					ctx.ui.notify(
						`Warning: ${baseUrl} responded ${res.status} ${res.statusText}. Saving anyway.`,
						"warning",
					);
				}
			} catch (err) {
				ctx.ui.notify(
					`Warning: could not reach ${baseUrl} (${err instanceof Error ? err.message : String(err)}). Saving anyway.`,
					"warning",
				);
			}

			// 5. Persist config (no API key — Pi owns credentials).
			const entry: ProviderEntry = { baseUrl, modelOverrides: {} };
			await updateConfig((cfg) => {
				cfg.providers[name] = entry;
				return true;
			});

			// 6. Register live so /login <name> is immediately available.
			registerNewAPIProvider(pi, name, entry);
			registered.add(name);

			ctx.ui.notify(
				`Provider "${name}" added. Run /login ${name} to enter its API key; ` +
					"Pi will then discover its models.",
				"info",
			);
		},
	});

	// -------------------------------------------------------------------------
	// /newapi-provider-remove [name]
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-remove", {
		description: "Remove a configured NewAPI provider (run /logout <name> first)",
		handler: async (args, ctx) => {
			const current = readConfig();
			const providerNames = Object.keys(current.providers);

			if (providerNames.length === 0) {
				ctx.ui.notify("No NewAPI providers are configured.", "info");
				return;
			}

			// Accept name from args or let user pick from a selector
			let name = args.trim();
			if (!name) {
				const selected = await ctx.ui.select("Select provider to remove", providerNames);
				if (selected === undefined) return;
				name = selected;
			}

			if (!current.providers[name]) {
				ctx.ui.notify(`Provider "${name}" not found in config.`, "error");
				return;
			}

			// Pi v0.80.8 exposes no extension-safe credential deletion, so warn
			// the user to remove the credential via /logout separately.
			const status = ctx.modelRegistry.getProviderAuthStatus(name);
			const credentialNote = status.configured
				? `A Pi credential is still configured for "${name}". Run /logout ${name} to remove it — ` +
					"this command does not edit auth.json.\n\n"
				: "";

			const confirmed = await ctx.ui.confirm(
				`Remove provider "${name}"?`,
				`${credentialNote}This will unregister "${name}" and delete its config entry.`,
			);
			if (!confirmed) return;

			pi.unregisterProvider(name);
			await updateConfig((cfg) => {
				if (!cfg.providers[name]) return false;
				delete cfg.providers[name];
				return true;
			});
			registered.delete(name);

			ctx.ui.notify(
				status.configured
					? `Provider "${name}" removed. Run /logout ${name} to delete its stored credential.`
					: `Provider "${name}" removed.`,
				"info",
			);
		},
	});

	// -------------------------------------------------------------------------
	// /newapi-provider-list
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-list", {
		description: "List all configured NewAPI providers and their status",
		handler: async (_args, ctx) => {
			const current = readConfig();
			const names = Object.keys(current.providers);

			if (names.length === 0) {
				ctx.ui.notify(
					"No NewAPI providers configured. Run /newapi-provider-add to add one.",
					"info",
				);
				return;
			}

			const lines = names.map((name) => {
				const entry = current.providers[name];
				const status = ctx.modelRegistry.getProviderAuthStatus(name);
				const overrideCount = Object.keys(entry.modelOverrides ?? {}).length;
				const state = registered.has(name) ? "active" : "inactive";
				return (
					`  ${name}  |  ${entry.baseUrl}  |  ` +
					`auth: ${status.configured ? "✓" : "✗"}  |  overrides: ${overrideCount}  |  ${state}`
				);
			});

			ctx.ui.notify(`NewAPI providers (${names.length}):\n${lines.join("\n")}`, "info");
		},
	});
}
