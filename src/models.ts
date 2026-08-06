import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { NewAPIError } from "./http.ts";
import {
	API_PREFERENCE,
	DEFAULT_GROUP_RATE,
	DEFAULT_MODEL_API,
	ENDPOINT_TYPE_TO_APIS,
	ENRICHMENT_PROVIDERS,
	QUOTA_PER_USD,
	SUPPORTED_NEWAPI_MODEL_APIS,
	TOKENS_PER_COST,
} from "./constants.ts";
import { EMPTY_RATIOS } from "./types.ts";
import type {
	BuildModelsResult,
	ModelLookupItem,
	NewAPIModelEntry,
	NewAPIModelInfo,
	Ratios,
	Settings,
} from "./types.ts";

export function resolveApiBaseUrl(baseUrl: string, api: Api): string {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return `${baseUrl.replace(/\/+$/, "")}/v1`;
		default:
			return baseUrl;
	}
}

export function calcInputCost(modelRate: number): number {
	return modelRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function calcOutputCost(modelRate: number, completionRate: number): number {
	return modelRate * completionRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function calcCacheCost(modelRate: number, ratio: number): number {
	return modelRate * ratio * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function findRatio(modelId: string, ratios: Record<string, number>): number | undefined {
	if (modelId in ratios) return ratios[modelId];
	const lower = modelId.toLowerCase();
	for (const [key, value] of Object.entries(ratios)) {
		if (key.toLowerCase() === lower) return value;
	}
	for (const [key, value] of Object.entries(ratios)) {
		if (lower.startsWith(key.toLowerCase())) return value;
	}
	return undefined;
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

		for (const model of providerModels) {
			if (!SUPPORTED_NEWAPI_MODEL_APIS.has(model.api)) continue;
			const stripped = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
			const normalizedId = stripped.replaceAll(".", "-").toLowerCase();
			if (lookup.has(normalizedId)) continue;

			lookup.set(normalizedId, {
				model: {
					...model,
					compat: {
						...(model.compat as Record<string, unknown> | undefined),
						supportsDeveloperRole: provider === "anthropic" || provider === "openai",
					} as Model<Api>["compat"],
				},
				source: provider,
			});
		}
	}

	cachedEnrichmentLookup = lookup;
	return lookup;
}

function gatewayApisFor(entry: NewAPIModelEntry): Set<Api> {
	const apis = new Set<Api>();
	for (const type of entry.supportedEndpointTypes) {
		for (const api of ENDPOINT_TYPE_TO_APIS[type] ?? []) apis.add(api);
	}
	return apis;
}

function pickModelApi(preferred: Api | undefined, gatewayApis: Set<Api>): Api {
	if (preferred && (gatewayApis.size === 0 || gatewayApis.has(preferred))) return preferred;
	for (const api of API_PREFERENCE) {
		if (gatewayApis.has(api)) return api;
	}
	return preferred ?? DEFAULT_MODEL_API;
}

export function parseModelsResponse(json: unknown): NewAPIModelEntry[] {
	if (typeof json !== "object" || json === null) {
		throw new NewAPIError("payload", "/v1/models returned a non-object payload");
	}
	const data = (json as Record<string, unknown>).data;
	if (!Array.isArray(data)) throw new NewAPIError("payload", "/v1/models payload has no data array");

	const output: NewAPIModelEntry[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string") continue;
		output.push({
			id: record.id,
			ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined,
			supportedEndpointTypes: Array.isArray(record.supported_endpoint_types)
				? record.supported_endpoint_types.filter((type): type is string => typeof type === "string")
				: [],
		});
	}
	return output;
}

function asRatioMap(value: unknown): Record<string, number> {
	if (typeof value !== "object" || value === null) return {};
	const output: Record<string, number> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
	}
	return output;
}

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

export function buildProviderModels(params: {
	providerName: string;
	baseUrl: string;
	apiModels: NewAPIModelEntry[];
	ratios: Ratios;
	modelOverrides: Record<string, NewAPIModelInfo>;
	settings?: Settings;
}): BuildModelsResult {
	const { providerName, baseUrl, apiModels, ratios, modelOverrides, settings = {} } = params;
	const sendSessionAffinityHeaders = settings.sendSessionAffinityHeaders !== false;
	const enrichmentLookup = getEnrichmentLookup();
	const newOverrides: Record<string, NewAPIModelInfo> = {};
	const models: ProviderModelConfig[] = [];

	for (const modelEntry of apiModels) {
		const normalizedId = modelEntry.id.replaceAll(".", "-").toLowerCase();
		const enriched = enrichmentLookup.get(normalizedId);
		const gatewayApis = gatewayApisFor(modelEntry);
		let name = modelEntry.id;
		let reasoning: boolean;
		let thinkingLevelMap = enriched?.model.thinkingLevelMap;
		let input: ("text" | "image")[];
		let contextWindow: number;
		let maxTokens: number;
		let api: Api;
		let compat: Model<Api>["compat"] | undefined;

		if (enriched) {
			name = enriched.model.name ?? modelEntry.id;
			compat = enriched.model.compat;
			reasoning = enriched.model.reasoning;
			input = enriched.model.input;
			contextWindow = enriched.model.contextWindow;
			maxTokens = enriched.model.maxTokens;

			const override = modelOverrides[modelEntry.id];
			if (override) {
				if (override.reasoning !== undefined) reasoning = override.reasoning;
				if (override.input !== undefined) input = override.input;
				if (override.contextWindow !== undefined) contextWindow = override.contextWindow;
				if (override.maxTokens !== undefined) maxTokens = override.maxTokens;
				if (override.thinkingLevelMap !== undefined) thinkingLevelMap = override.thinkingLevelMap;
			}
			const preferredApi = override?.api ?? enriched.model.api;
			api = pickModelApi(preferredApi, gatewayApis);
			if (preferredApi === undefined && gatewayApis.size === 0) {
				console.warn(
					`NewAPI [${providerName}]: enriched model "${modelEntry.id}" from ${enriched.source} has no api ` +
						`and the gateway advertised none — falling back to ${api}`,
				);
			}
		} else {
			let override = modelOverrides[modelEntry.id];
			if (!override) {
				override = {
					api: pickModelApi(undefined, gatewayApis),
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 4096,
				};
				newOverrides[modelEntry.id] = override;
				console.warn(`NewAPI [${providerName}]: unknown model "${modelEntry.id}" — template added to modelOverrides`);
			}
			reasoning = override.reasoning ?? false;
			thinkingLevelMap = override.thinkingLevelMap;
			input = override.input ?? ["text"];
			contextWindow = override.contextWindow ?? 128000;
			maxTokens = override.maxTokens ?? 4096;
			api = override.api ?? DEFAULT_MODEL_API;
		}

		const modelRate = findRatio(modelEntry.id, ratios.modelRatios) ?? 0;
		const completionRate = findRatio(modelEntry.id, ratios.completionRatios) ?? 1;
		const cacheRatio = findRatio(modelEntry.id, ratios.cacheRatios) ?? 0;
		const createCacheRatio = findRatio(modelEntry.id, ratios.createCacheRatios) ?? 0;
		if (sendSessionAffinityHeaders && (api === "openai-completions" || api === "anthropic-messages")) {
			compat = {
				...(compat as Record<string, unknown> | undefined),
				sendSessionAffinityHeaders: true,
			} as Model<Api>["compat"];
		}

		models.push({
			id: modelEntry.id,
			name,
			api,
			baseUrl: resolveApiBaseUrl(baseUrl, api),
			reasoning,
			thinkingLevelMap,
			input,
			cost: {
				input: calcInputCost(modelRate),
				output: calcOutputCost(modelRate, completionRate),
				cacheRead: calcCacheCost(modelRate, cacheRatio),
				cacheWrite: calcCacheCost(modelRate, createCacheRatio),
			},
			contextWindow,
			maxTokens,
			compat,
		});
	}

	return { models, newOverrides };
}
