/**
 * NewAPI Provider Extension for pi
 *
 * Registers a single "newapi" provider that discovers models from a self-hosted
 * NewAPI AI gateway and routes requests to the appropriate backend (Anthropic or
 * OpenAI) based on model ID prefix matching.
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
	createAssistantMessageEventStream,
	getModels,
	streamSimpleAnthropic,
	streamSimpleOpenAIResponses,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"];
const UNCONFIGURED_URL = "http://newapi.localhost/unconfigured";
const CONFIG_FILENAME = "provider-newapi.json";
const PROVIDER_NAME = "newapi";
const QUOTA_PER_USD = 500_000;
const TOKENS_PER_COST = 1_000_000;
const DEFAULT_GROUP_RATE = 1.0;
const FETCH_TIMEOUT_MS = 15_000;

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

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

interface NewAPIModelInfo {
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
// Model enrichment — build a lookup from vercel-ai-gateway MODELS by
// stripping the "provider/" prefix from model IDs
// ---------------------------------------------------------------------------

interface EnrichedModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	isOpenAI: boolean;
}

function buildEnrichmentLookup(): Map<string, Model<Api>> {
	const lookup = new Map<string, Model<Api>>();
	let vercelModels: Model<Api>[];
	try {
		vercelModels = getModels("vercel-ai-gateway") as Model<Api>[];
	} catch {
		return lookup;
	}
	for (const m of vercelModels) {
		const stripped = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
		lookup.set(stripped.replaceAll(".", "-").toLowerCase(), m);
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

				if (enriched) {
					if (config.modelInfo[m.id]) {
						delete config.modelInfo[m.id];
						configDirty = true;
						console.warn(
							`NewAPI: model "${m.id}" now found in known models — removed from modelInfo`,
						);
					}
					reasoning = enriched.reasoning;
					thinkingLevelMap = enriched.thinkingLevelMap;
					input = enriched.input;
					contextWindow = enriched.contextWindow;
					maxTokens = enriched.maxTokens;
				} else {
					if (!config.modelInfo[m.id]) {
						config.modelInfo[m.id] = {
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
				}

				const mr = findRatio(m.id, modelRatios) ?? 0;
				const cr = findRatio(m.id, completionRatios) ?? 1;
				const cacheR = findRatio(m.id, cacheRatios) ?? 0;
				const createCacheR = findRatio(m.id, createCacheRatios) ?? 0;
				const isOpenAI = OPENAI_MODEL_PREFIXES.some((p) => m.id.startsWith(p));

				modelConfigMap.set(m.id, {
					id: m.id,
					name: enriched?.name ?? m.id,
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
					isOpenAI,
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
	// Custom stream handler — routes to Anthropic or OpenAI based on model
	// prefix matching
	// -----------------------------------------------------------------------

	function streamNewAPI(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				const apiKey = options?.apiKey;
				if (!apiKey)
					throw new Error("No API key. Run /login or set NEWAPI_API_KEY.");

				const cfg = modelConfigMap.get(model.id)!;

				const streamOptions = { ...options, apiKey };

				const innerStream = cfg.isOpenAI
					? streamSimpleOpenAIResponses(
							{
								...model,
								baseUrl: `${resolvedBaseUrl}/v1`,
								api: "openai-responses",
							} as Model<"openai-responses">,
							context,
							streamOptions,
						)
					: streamSimpleAnthropic(
							{
								...model,
								baseUrl: resolvedBaseUrl,
								api: "anthropic-messages",
							} as Model<"anthropic-messages">,
							context,
							streamOptions,
						);

				for await (const event of innerStream) stream.push(event);
				stream.end();
			} catch (error) {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					},
				});
				stream.end();
			}
		})();

		return stream;
	}

	// -----------------------------------------------------------------------
	// Register provider
	// -----------------------------------------------------------------------

	const providerModels = Array.from(modelConfigMap.values(), (m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
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
		api: PROVIDER_NAME as Api,
		models: providerModels,
		streamSimple: streamNewAPI,
	});
}
