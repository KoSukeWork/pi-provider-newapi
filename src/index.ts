/**
 * NewAPI Provider Extension for pi
 *
 * Registers a single "newapi" provider that discovers models from a self-hosted
 * NewAPI AI gateway and routes requests using the API recommended by enriched
 * built-in model metadata.
 *
 * Config:  <agentDir>/extensions/provider-newapi.json  (baseUrl, modelInfo)
 * Key:     <agentDir>/auth.json                         (api_key, via /login)
 * Env:     NEWAPI_BASE_URL, NEWAPI_API_KEY              (manually sourced for dev)
 *
 * Usage:
 *   source .env && pi --list-models
 *   /login               -- interactively persist API key to auth.json
 *   /model newapi/<id>   -- select a model
 */

import {
	getModels,
	type Api,
	type Model,
	type ModelThinkingLevel,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNCONFIGURED_URL = "http://newapi.localhost/unconfigured";
const CONFIG_FILENAME = "provider-newapi.json";
const PROVIDER_NAME = "newapi";
const QUOTA_PER_USD = 500_000;
const TOKENS_PER_COST = 1_000_000;
const DEFAULT_GROUP_RATE = 1.0;
const FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_MODEL_API: Api = "anthropic-messages";
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
		if ((err as Error).name === 'AbortError') {
			throw new Error(`fetch(${url}) timed out after ${timeoutMs / 1000}s`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function joinBaseUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
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
// Config persistence
// ---------------------------------------------------------------------------

interface NewAPIModelInfo {
	api?: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

interface NewAPIConfig {
	baseUrl: string;
	modelInfo: Record<string, NewAPIModelInfo>;
}

function getConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

function readConfig(): NewAPIConfig {
	try {
		const raw = readFileSync(getConfigPath(), "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return {
			baseUrl: String(data.baseUrl ?? ""),
			modelInfo: (data.modelInfo as Record<string, NewAPIModelInfo>) ?? {},
		};
	} catch {
		return { baseUrl: "", modelInfo: {} };
	}
}

function writeConfig(config: NewAPIConfig): void {
	const path = getConfigPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function readAuthKey(): string {
	try {
		const authPath = join(getAgentDir(), "auth.json");
		const raw = readFileSync(authPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const cred = data[PROVIDER_NAME] as Record<string, unknown> | undefined;
		if (cred?.type === "api_key" && typeof cred.key === "string") {
			return cred.key;
		}
	} catch {
		// auth.json may not exist yet
	}
	return "";
}

// ---------------------------------------------------------------------------
// Cost helpers
//
// From NewAPI rate-settings.md:
//   Quota = (Input Tokens + Output Tokens × CompletionRate) × ModelRate × GroupRate
//   1 USD = 500,000 quota points
//
// Group rate defaults to 1.0 (standard); we cannot fetch it without auth.
//   cost.input  = ModelRate × GroupRate × 1,000,000 / 500,000 = ModelRate × 2
//   cost.output = ModelRate × CompletionRate × GroupRate × 2
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
// casing than ratio_config keys
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
// Model enrichment — build a lookup from multiple providers by
// stripping the "provider/" prefix from model IDs.
// Earlier providers take precedence over later ones.
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
			providerModels = getModels(provider) as Model<Api>[];
		} catch {
			continue;
		}

		for (const m of providerModels) {
			if (!isSupportedNewAPIModelApi(m.api)) continue;

			const stripped = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
			const normalizedId = stripped.replaceAll(".", "-").toLowerCase();
			if (!lookup.has(normalizedId)) {
				const model = {
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
// Main
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const envBaseUrl = (process.env.NEWAPI_BASE_URL ?? "").replace(/\/+$/, "");

	let resolvedBaseUrl = config.baseUrl || "";

	// Reconcile baseUrl on load
	if (envBaseUrl) {
		if (resolvedBaseUrl !== envBaseUrl) {
			resolvedBaseUrl = envBaseUrl;
			writeConfig({ baseUrl: resolvedBaseUrl, modelInfo: config.modelInfo });
		}
	} else if (!resolvedBaseUrl) {
		console.warn("NewAPI: baseUrl not configured. Set NEWAPI_BASE_URL environment variable.");
	}

	// -----------------------------------------------------------------------
	// Discover models
	// -----------------------------------------------------------------------

	const modelConfigMap = new Map<string, EnrichedModel>();

	if (resolvedBaseUrl) {
		const envKey = process.env.NEWAPI_API_KEY ?? "";
		const authKey = readAuthKey();
		const resolvedKey = envKey || authKey || "";

		try {
			// ratio_config (best-effort, no auth required)
			let modelRatios: Record<string, number> = {};
			let completionRatios: Record<string, number> = {};
			let cacheRatios: Record<string, number> = {};
			let createCacheRatios: Record<string, number> = {};

			try {
				const ratioRes = await fetchWithTimeout(`${resolvedBaseUrl}/api/ratio_config`);
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
					`NewAPI: /api/ratio_config failed — ${err instanceof Error ? err.message : String(err)}`,
				);
				// ratio_config is optional — proceed without costs
			}

			// /v1/models
			const headers: Record<string, string> = {};
			if (resolvedKey) headers["Authorization"] = `Bearer ${resolvedKey}`;

			const modelsRes = await fetchWithTimeout(`${resolvedBaseUrl}/v1/models`, { headers });
			if (!modelsRes.ok) {
				throw new Error(
					`Failed to fetch /v1/models: ${modelsRes.status} ${modelsRes.statusText}`,
				);
			}

			const modelsJson = (await modelsRes.json()) as OpenAIModelsResponse;
			const apiModels = modelsJson.data ?? [];

			if (apiModels.length === 0) {
				console.warn(
					"NewAPI: /v1/models returned zero models. " +
						"The gateway may have no models assigned, or the API key may lack access.",
				);
			}

			// Enrich from vercel-ai-gateway MODELS (lowercase lookup)
			const enrichmentLookup = buildEnrichmentLookup();
			let configDirty = false;

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
					if (config.modelInfo[m.id]) {
						const mi = config.modelInfo[m.id];
						const diffs: string[] = [];
						if (mi.api !== undefined && mi.api !== enriched.model.api) {
							diffs.push(`api ${mi.api} → ${enriched.model.api}`);
						}
						if (mi.reasoning !== enriched.model.reasoning) {
							diffs.push(`reasoning ${mi.reasoning} → ${enriched.model.reasoning}`);
						}
						if (JSON.stringify(mi.input ?? ["text"]) !== JSON.stringify(enriched.model.input)) {
							diffs.push(`input ${JSON.stringify(mi.input ?? ["text"])} → ${JSON.stringify(enriched.model.input)}`);
						}
						if (mi.contextWindow !== enriched.model.contextWindow) {
							diffs.push(`contextWindow ${mi.contextWindow} → ${enriched.model.contextWindow}`);
						}
						if (mi.maxTokens !== enriched.model.maxTokens) {
							diffs.push(`maxTokens ${mi.maxTokens} → ${enriched.model.maxTokens}`);
						}
						if (JSON.stringify(mi.thinkingLevelMap) !== JSON.stringify(enriched.model.thinkingLevelMap)) {
							diffs.push(`thinkingLevelMap ${JSON.stringify(mi.thinkingLevelMap)} → ${JSON.stringify(enriched.model.thinkingLevelMap)}`);
						}
						const diffStr = diffs.length > 0 ? diffs.join(", ") : "none";
						console.warn(
							`NewAPI: model "${m.id}" now found in known models (from ${enriched.source}) — using upstream values (config removed). Differences: ${diffStr}`,
						);
						delete config.modelInfo[m.id];
						configDirty = true;
					}
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
							`NewAPI: enriched model "${m.id}" from ${enriched.source} has no api value — ` +
								`falling back to ${DEFAULT_MODEL_API}`,
						);
					}
				} else {
					if (!config.modelInfo[m.id]) {
						config.modelInfo[m.id] = {
							api: DEFAULT_MODEL_API,
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 4096,
						};
						configDirty = true;
						console.warn(
							`NewAPI: unknown model "${m.id}" — added template to modelInfo in config`,
						);
					}
					const mi = config.modelInfo[m.id];
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
					provider: enriched?.model.provider ?? PROVIDER_NAME,
					modelInfoSource: enriched ? `built-in:${enriched.source}` : "config:modelInfo",
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
				writeConfig(config);
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			console.warn(
				`NewAPI: model discovery failed — ${err.message}\n` +
					"Falling back to unconfigured. Run /login to authenticate or set NEWAPI_API_KEY.",
			);
			resolvedBaseUrl = UNCONFIGURED_URL;
		}
	}

	// -----------------------------------------------------------------------
	// Register provider
	// -----------------------------------------------------------------------

	const providerModels = Array.from(modelConfigMap.values(), (m) => ({
		id: m.id,
		name: m.name,
		api: m.api,
		baseUrl: resolveApiBaseUrl(resolvedBaseUrl, m.api),
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: m.compat,
	}));

	if (resolvedBaseUrl === UNCONFIGURED_URL || providerModels.length === 0) {
		pi.registerProvider(PROVIDER_NAME, {
			name: "NewAPI",
			baseUrl: UNCONFIGURED_URL,
			apiKey: "$NEWAPI_API_KEY",
			api: PROVIDER_NAME as Api,
			models: [
				{
					id: "unconfigured",
					name: "NewAPI (unconfigured)",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1,
					maxTokens: 1,
				},
			],
			streamSimple: () => {
				const errorMessage = readAuthKey()
					? "NewAPI provider pending reload. Run /reload, then /model to select an available NewAPI model."
					: "NewAPI is not configured. Run /login to authenticate.";
				throw new Error(errorMessage);
			},
		});
		return;
	}

	pi.registerProvider(PROVIDER_NAME, {
		name: "NewAPI",
		baseUrl: resolvedBaseUrl,
		apiKey: "$NEWAPI_API_KEY",
		models: providerModels,
	});
}
