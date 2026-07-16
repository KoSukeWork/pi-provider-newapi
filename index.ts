/**
 * NewAPI Provider Extension for pi
 *
 * Manages multiple named providers backed by self-hosted NewAPI AI gateways.
 * On startup, each provider defined in provider-newapi.json is discovered,
 * enriched, and registered with pi. No providers are registered if the config
 * is empty — run /newapi-provider-add to get started.
 *
 * Config:   <agentDir>/extensions/provider-newapi.json
 *           { providers: { <name>: { baseUrl, modelOverrides } }, settings: { ... } }
 * Keys:     <agentDir>/auth.json  (one entry per provider name, managed by /newapi-provider-add)
 *
 * Commands:
 *   /newapi-provider-add [name]    — add and verify a new provider interactively
 *   /newapi-provider-remove [name] — remove a provider (config + credentials + unregister)
 *   /newapi-provider-list          — list configured providers and their status
 */

import { type Api, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
	getModels,
	getProviders,
	type BuiltinProvider,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchOptions } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...fetchOptions, signal: controller.signal });
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw new Error(`fetch(${url}) timed out after ${timeoutMs / 1000}s`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function joinBaseUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}${path}`;
}

function isSupportedNewAPIModelApi(api: Api): boolean {
	return SUPPORTED_NEWAPI_MODEL_APIS.has(api);
}

function resolveApiBaseUrl(baseUrl: string, api: Api): string {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return joinBaseUrl(baseUrl, "/v1");
		default:
			return baseUrl;
	}
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface NewAPIModelInfo {
	api?: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
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
		const dir = dirname(configPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ providers: {}, settings: {} }, null, 2),
			"utf-8",
		);
	} catch (err) {
		console.warn(
			`NewAPI: could not reset config file: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function writeConfig(config: NewAPIConfig): void {
	const configPath = getConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function readAuthKey(providerName: string): string {
	try {
		const authPath = join(getAgentDir(), "auth.json");
		const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
		const cred = data[providerName] as Record<string, unknown> | undefined;
		if (cred?.type === "api_key" && typeof cred.key === "string") return cred.key;
	} catch {
		// auth.json may not exist yet — not an error
	}
	return "";
}

// ---------------------------------------------------------------------------
// Cost helpers
//
// From NewAPI rate-settings.md:
//   Quota = (Input + Output × CompletionRate) × ModelRate × GroupRate
//   1 USD = 500,000 quota points
// ---------------------------------------------------------------------------

function calcInputCost(modelRate: number): number {
	return modelRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

function calcOutputCost(modelRate: number, completionRate: number): number {
	return modelRate * completionRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

function calcCacheCost(modelRate: number, ratio: number): number {
	return modelRate * ratio * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

// ---------------------------------------------------------------------------
// Ratio matching — NewAPI may return model IDs with version tags or different
// casing than ratio_config keys.
// ---------------------------------------------------------------------------

function findRatio(modelId: string, ratios: Record<string, number>): number | undefined {
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
// ---------------------------------------------------------------------------

interface ModelLookupItem {
	model: Model<Api>;
	source: string;
}

interface EnrichedModel {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	api: Api;
	compat?: Model<Api>["compat"];
	modelInfoSource: string;
}

function buildEnrichmentLookup(): Map<string, ModelLookupItem> {
	const lookup = new Map<string, ModelLookupItem>();

	for (const provider of ENRICHMENT_PROVIDERS) {
		let providerModels: Model<Api>[];
		try {
			providerModels = getModels(provider as BuiltinProvider) as Model<Api>[];
		} catch {
			continue;
		}

		for (const m of providerModels) {
			if (!isSupportedNewAPIModelApi(m.api)) continue;

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

	return lookup;
}

// ---------------------------------------------------------------------------
// NewAPI response types
// ---------------------------------------------------------------------------

interface OpenAIModelEntry {
	id: string;
	object: "model";
	created: number;
	owned_by: string;
}

interface OpenAIModelsResponse {
	object: "list";
	data: OpenAIModelEntry[];
}

interface RatioConfigResponse {
	success: boolean;
	data: {
		model_ratio: Record<string, number>;
		completion_ratio: Record<string, number>;
		cache_ratio: Record<string, number>;
		create_cache_ratio: Record<string, number>;
	};
}

// ---------------------------------------------------------------------------
// Core: fetch models from a NewAPI gateway, enrich them, and register with pi.
// Returns the number of models registered.
// Throws on unrecoverable errors (e.g. /v1/models request fails).
// ---------------------------------------------------------------------------

async function discoverAndRegister(
	pi: ExtensionAPI,
	name: string,
	entry: ProviderEntry,
	config: NewAPIConfig,
): Promise<number> {
	const baseUrl = entry.baseUrl.replace(/\/+$/, "");
	const apiKey = readAuthKey(name);

	// ratio_config — best-effort, no auth required on most instances
	let modelRatios: Record<string, number> = {};
	let completionRatios: Record<string, number> = {};
	let cacheRatios: Record<string, number> = {};
	let createCacheRatios: Record<string, number> = {};

	try {
		const ratioRes = await fetchWithTimeout(`${baseUrl}/api/ratio_config`);
		if (ratioRes.ok) {
			const ratioJson = (await ratioRes.json()) as RatioConfigResponse;
			if (ratioJson.success) {
				modelRatios = ratioJson.data.model_ratio ?? {};
				completionRatios = ratioJson.data.completion_ratio ?? {};
				cacheRatios = ratioJson.data.cache_ratio ?? {};
				createCacheRatios = ratioJson.data.create_cache_ratio ?? {};
			}
		}
	} catch (err) {
		console.warn(
			`NewAPI [${name}]: /api/ratio_config unavailable — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// /v1/models — required; throw on failure so the startup loop can skip this provider
	const fetchHeaders: Record<string, string> = {};
	if (apiKey) fetchHeaders["Authorization"] = `Bearer ${apiKey}`;

	const modelsRes = await fetchWithTimeout(`${baseUrl}/v1/models`, { headers: fetchHeaders });
	if (!modelsRes.ok) {
		throw new Error(`GET /v1/models: ${modelsRes.status} ${modelsRes.statusText}`);
	}

	const modelsJson = (await modelsRes.json()) as OpenAIModelsResponse;
	const apiModels = modelsJson.data ?? [];

	if (apiModels.length === 0) {
		console.warn(
			`NewAPI [${name}]: /v1/models returned zero models — ` +
				"the gateway may have no models assigned or the API key may lack access.",
		);
	}

	const enrichmentLookup = buildEnrichmentLookup();
	const modelOverrides = entry.modelOverrides ?? {};
	let configDirty = false;
	const modelConfigMap = new Map<string, EnrichedModel>();

	for (const m of apiModels) {
		const normalizedId = m.id.replaceAll(".", "-").toLowerCase();
		const enriched = enrichmentLookup.get(normalizedId);

		let reasoning: boolean;
		let thinkingLevelMap: ThinkingLevelMap | undefined;
		let input: ("text" | "image")[];
		let contextWindow: number;
		let maxTokens: number;
		let api: Api;

		if (enriched) {
			// Start from enriched built-in values
			reasoning = enriched.model.reasoning;
			thinkingLevelMap = enriched.model.thinkingLevelMap;
			input = enriched.model.input;
			contextWindow = enriched.model.contextWindow;
			maxTokens = enriched.model.maxTokens;
			if (enriched.model.api) {
				api = enriched.model.api;
			} else {
				api = DEFAULT_MODEL_API;
				console.warn(
					`NewAPI [${name}]: enriched model "${m.id}" from ${enriched.source} has no api — ` +
						`falling back to ${DEFAULT_MODEL_API}`,
				);
			}

			// Apply modelOverrides patch on top (optional api/thinkingLevelMap only when
			// explicitly set; required fields always applied when the entry is present)
			if (modelOverrides[m.id]) {
				const mi = modelOverrides[m.id];
				if (mi.api !== undefined) api = mi.api;
				reasoning = mi.reasoning;
				input = mi.input;
				contextWindow = mi.contextWindow;
				maxTokens = mi.maxTokens;
				if (mi.thinkingLevelMap !== undefined) thinkingLevelMap = mi.thinkingLevelMap;
			}
		} else {
			// Unknown model — use existing override or create a template entry
			if (!modelOverrides[m.id]) {
				modelOverrides[m.id] = {
					api: DEFAULT_MODEL_API,
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 4096,
				};
				configDirty = true;
				console.warn(
					`NewAPI [${name}]: unknown model "${m.id}" — template added to modelOverrides`,
				);
			}
			const mi = modelOverrides[m.id];
			reasoning = mi.reasoning ?? false;
			thinkingLevelMap = mi.thinkingLevelMap;
			input = mi.input ?? ["text"];
			contextWindow = mi.contextWindow ?? 128000;
			maxTokens = mi.maxTokens ?? 4096;
			api = mi.api ?? DEFAULT_MODEL_API;
		}

		const mr = findRatio(m.id, modelRatios) ?? 0;
		const cr = findRatio(m.id, completionRatios) ?? 1;
		const cacheR = findRatio(m.id, cacheRatios) ?? 0;
		const createCacheR = findRatio(m.id, createCacheRatios) ?? 0;

		modelConfigMap.set(m.id, {
			id: m.id,
			name: enriched?.model.name ?? m.id,
			provider: enriched?.model.provider ?? name,
			modelInfoSource: enriched ? `built-in:${enriched.source}` : "config:modelOverrides",
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
			api,
			compat: enriched?.model.compat,
		});
	}

	if (configDirty) {
		entry.modelOverrides = modelOverrides;
		writeConfig(config);
	}

	const providerModels = Array.from(modelConfigMap.values(), (m) => ({
		id: m.id,
		name: m.name,
		api: m.api,
		baseUrl: resolveApiBaseUrl(baseUrl, m.api),
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: m.compat,
	}));

	pi.registerProvider(name, {
		baseUrl,
		apiKey,
		models: providerModels,
	});

	return providerModels.length;
}

// ---------------------------------------------------------------------------
// Onboarding nudge — shown at most ONBOARDING_WARN_MAX times when zero
// providers are configured. Countdown is persisted in config.settings.
// ---------------------------------------------------------------------------

function maybeWarnOnboarding(config: NewAPIConfig): void {
	const countdown = config.settings.onboardingWarnCountdown ?? ONBOARDING_WARN_MAX;
	if (countdown <= 0) return;

	console.warn(
		"NewAPI: no providers configured. Run /newapi-provider-add to add a NewAPI gateway.",
	);

	config.settings.onboardingWarnCountdown = countdown - 1;
	writeConfig(config);
}

// ---------------------------------------------------------------------------
// Default export — startup loop + commands
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const builtinProviderIds = getProviders() as unknown as string[];

	// Track which providers we successfully register this session (used by the
	// list command and by /newapi-provider-add after live registration).
	const registered: string[] = [];

	// -------------------------------------------------------------------------
	// Startup: discover and register every configured provider
	// -------------------------------------------------------------------------

	for (const [name, entry] of Object.entries(config.providers)) {
		if (builtinProviderIds.includes(name)) {
			console.warn(
				`NewAPI: skipping provider "${name}" — name collides with a built-in pi provider.`,
			);
			continue;
		}
		if (registered.includes(name)) {
			console.warn(`NewAPI: skipping duplicate provider key "${name}" in config.`);
			continue;
		}
		try {
			const count = await discoverAndRegister(pi, name, entry, config);
			console.log(`NewAPI [${name}]: registered ${count} model${count !== 1 ? "s" : ""}.`);
			registered.push(name);
		} catch (err) {
			console.warn(
				`NewAPI [${name}]: discovery failed — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (registered.length === 0) {
		maybeWarnOnboarding(config);
	}

	// -------------------------------------------------------------------------
	// /newapi-provider-add [name]
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-add", {
		description: "Add a new NewAPI provider (prompts for base URL and API key)",
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

			const config = readConfig();
			if (config.providers[name]) {
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

			// 4. Prompt API key
			const apiKey = await ctx.ui.input("API Key", "sk-...");
			if (apiKey === undefined) return;
			if (!apiKey.trim()) {
				ctx.ui.notify("API key cannot be empty.", "error");
				return;
			}

			// 5. Verify connectivity + auth before saving anything
			try {
				const verifyHeaders: Record<string, string> = { "Authorization": `Bearer ${apiKey}` };

				const res = await fetchWithTimeout(`${baseUrl}/v1/models`, {
					headers: verifyHeaders,
				});

				if (res.status === 401) {
					ctx.ui.notify(
						"Authentication failed (401). Check your API key and try again.",
						"error",
					);
					return;
				}
				if (!res.ok) {
					ctx.ui.notify(
						`Connection failed: ${res.status} ${res.statusText}. Provider not added.`,
						"error",
					);
					return;
				}

				const json = (await res.json()) as OpenAIModelsResponse;
				if ((json.data?.length ?? 0) === 0) {
					ctx.ui.notify(
						`Connected to "${name}", but /v1/models returned 0 models. ` +
							"The API key may have limited access. Saving anyway.",
						"warning",
					);
				}
			} catch (err) {
				ctx.ui.notify(
					`Verification failed: ${err instanceof Error ? err.message : String(err)}. Provider not added.`,
					"error",
				);
				return;
			}

			// 6. Persist — key to auth.json, entry to config
			ctx.modelRegistry.authStorage.set(name, { type: "api_key", key: apiKey });
			const entry: ProviderEntry = { baseUrl, modelOverrides: {} };
			config.providers[name] = entry;
			writeConfig(config);

			// 7. Discover and register live — no /reload needed
			try {
				const count = await discoverAndRegister(pi, name, entry, config);
				registered.push(name);
				ctx.ui.notify(
					`Provider "${name}" added with ${count} model${count !== 1 ? "s" : ""}.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Provider "${name}" saved, but model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// /newapi-provider-remove [name]
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-remove", {
		description: "Remove a configured NewAPI provider",
		handler: async (args, ctx) => {
			const config = readConfig();
			const providerNames = Object.keys(config.providers);

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

			if (!config.providers[name]) {
				ctx.ui.notify(`Provider "${name}" not found in config.`, "error");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				`Remove provider "${name}"?`,
				`This will unregister "${name}", delete its config entry, and remove its stored credentials.`,
			);
			if (!confirmed) return;

			pi.unregisterProvider(name);
			delete config.providers[name];
			writeConfig(config);
			ctx.modelRegistry.authStorage.remove(name);

			const idx = registered.indexOf(name);
			if (idx !== -1) registered.splice(idx, 1);

			ctx.ui.notify(`Provider "${name}" removed.`, "info");
		},
	});

	// -------------------------------------------------------------------------
	// /newapi-provider-list
	// -------------------------------------------------------------------------

	pi.registerCommand("newapi-provider-list", {
		description: "List all configured NewAPI providers and their status",
		handler: async (_args, ctx) => {
			const config = readConfig();
			const names = Object.keys(config.providers);

			if (names.length === 0) {
				ctx.ui.notify(
					"No NewAPI providers configured. Run /newapi-provider-add to add one.",
					"info",
				);
				return;
			}

			const lines = names.map((name) => {
				const entry = config.providers[name];
				const hasKey = ctx.modelRegistry.authStorage.has(name);
				const overrideCount = Object.keys(entry.modelOverrides ?? {}).length;
				const status = registered.includes(name) ? "active" : "inactive";
				return (
					`  ${name}  |  ${entry.baseUrl}  |  ` +
					`auth: ${hasKey ? "✓" : "✗"}  |  overrides: ${overrideCount}  |  ${status}`
				);
			});

			ctx.ui.notify(`NewAPI providers (${names.length}):\n${lines.join("\n")}`, "info");
		},
	});
}
