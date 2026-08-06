/** Parses, enriches, routes, and prices NewAPI model definitions for Pi. */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { NewAPIError } from "./http.ts";
import {
	API_PREFERENCE,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_GROUP_RATE,
	DEFAULT_MAX_TOKENS,
	DEFAULT_MODEL_API,
	ENDPOINT_TYPE_TO_APIS,
	ENRICHMENT_PROVIDERS,
	QUOTA_PER_USD,
	SUPPORTED_NEWAPI_MODEL_APIS,
	TOKENS_PER_COST,
} from "./constants.ts";
import { EMPTY_RATIOS } from "./types.ts";
import type { ModelLookupItem, NewAPIModelApi, NewAPIModelEntry, Ratios } from "./types.ts";

export function resolveApiBaseUrl(baseUrl: string, api: Api): string {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return `${baseUrl.replace(/\/+$/, "")}/v1`;
		default:
			return baseUrl;
	}
}

export function calcCacheCost(modelRate: number, ratio: number): number {
	return modelRate * ratio * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}

export function findRatio(modelId: string, ratios: Record<string, number>): number | undefined {
	// Prefer exact keys, then tolerate casing differences and dated model suffixes.
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
			if (!SUPPORTED_NEWAPI_MODEL_APIS.has(model.api as NewAPIModelApi)) continue;
			const stripped = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
			const normalizedId = stripped.replaceAll(".", "-").toLowerCase();
			// Provider order is intentional: the first matching built-in model supplies metadata.
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

export function isEnrichedModelId(modelId: string): boolean {
	return getEnrichmentLookup().has(modelId.replaceAll(".", "-").toLowerCase());
}

export interface ModelApiOverrideRule {
	pattern: string;
	regex: RegExp;
	api: NewAPIModelApi;
}

export function compileModelApiOverrides(overrides: Record<string, string>): {
	rules: ModelApiOverrideRule[];
	errors: string[];
} {
	const rules: ModelApiOverrideRule[] = [];
	const errors: string[] = [];
	// Object insertion order defines rule priority, so retain it while compiling regexes.
	for (const [pattern, api] of Object.entries(overrides)) {
		if (!SUPPORTED_NEWAPI_MODEL_APIS.has(api as NewAPIModelApi)) {
			errors.push(`pattern "${pattern}" uses unsupported API "${api}"`);
			continue;
		}
		try {
			rules.push({ pattern, regex: new RegExp(pattern), api: api as NewAPIModelApi });
		} catch (error) {
			errors.push(`invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { rules, errors };
}

function pickModelApi(preferred: Api | undefined, gatewayApis: Set<NewAPIModelApi>): NewAPIModelApi {
	// Keep enriched metadata when the gateway does not contradict it.
	if (
		preferred &&
		SUPPORTED_NEWAPI_MODEL_APIS.has(preferred as NewAPIModelApi) &&
		(gatewayApis.size === 0 || gatewayApis.has(preferred as NewAPIModelApi))
	) {
		return preferred as NewAPIModelApi;
	}
	// Otherwise select the best API explicitly advertised by NewAPI.
	for (const api of API_PREFERENCE) {
		if (gatewayApis.has(api)) return api;
	}
	return SUPPORTED_NEWAPI_MODEL_APIS.has(preferred as NewAPIModelApi)
		? (preferred as NewAPIModelApi)
		: DEFAULT_MODEL_API;
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
	modelApiOverrides: Record<string, string>;
}): ProviderModelConfig[] {
	const { providerName, baseUrl, apiModels, ratios, modelApiOverrides } = params;
	const enrichmentLookup = getEnrichmentLookup();
	const { rules, errors } = compileModelApiOverrides(modelApiOverrides);
	for (const error of errors) console.warn(`NewAPI [${providerName}]: modelApiOverrides ${error} — ignoring it.`);
	const models: ProviderModelConfig[] = [];

	for (const modelEntry of apiModels) {
		const normalizedId = modelEntry.id.replaceAll(".", "-").toLowerCase();
		const enriched = enrichmentLookup.get(normalizedId);
		const gatewayApis = new Set<NewAPIModelApi>();
		for (const type of modelEntry.supportedEndpointTypes) {
			for (const candidate of ENDPOINT_TYPE_TO_APIS[type] ?? []) gatewayApis.add(candidate);
		}
		// User regex routing is authoritative; enrichment and advertised endpoints are fallbacks.
		const apiOverride = rules.find((rule) => rule.regex.test(modelEntry.id))?.api;
		let name = modelEntry.id;
		let reasoning = false;
		let thinkingLevelMap = enriched?.model.thinkingLevelMap;
		let input: ("text" | "image")[] = ["text"];
		let contextWindow = DEFAULT_CONTEXT_WINDOW;
		let maxTokens = DEFAULT_MAX_TOKENS;
		let api: NewAPIModelApi;
		let compat: Model<Api>["compat"] | undefined;

		if (enriched) {
			// Known models inherit Pi's capabilities and compatibility metadata.
			name = enriched.model.name ?? modelEntry.id;
			compat = enriched.model.compat;
			reasoning = enriched.model.reasoning;
			input = enriched.model.input;
			contextWindow = enriched.model.contextWindow;
			maxTokens = enriched.model.maxTokens;

			api = apiOverride ?? pickModelApi(enriched.model.api, gatewayApis);
			if (apiOverride === undefined && enriched.model.api === undefined && gatewayApis.size === 0) {
				console.warn(
					`NewAPI [${providerName}]: enriched model "${modelEntry.id}" from ${enriched.source} has no api ` +
						`and the gateway advertised none — falling back to ${api}`,
				);
			}
		} else {
			// Unknown models remain usable with conservative defaults and generated override templates.
			api = apiOverride ?? pickModelApi(undefined, gatewayApis);
		}

		const modelRate = findRatio(modelEntry.id, ratios.modelRatios) ?? 0;
		const completionRate = findRatio(modelEntry.id, ratios.completionRatios) ?? 1;
		const cacheRatio = findRatio(modelEntry.id, ratios.cacheRatios) ?? 0;
		const createCacheRatio = findRatio(modelEntry.id, ratios.createCacheRatios) ?? 0;

		models.push({
			id: modelEntry.id,
			name,
			api,
			baseUrl: resolveApiBaseUrl(baseUrl, api),
			reasoning,
			thinkingLevelMap,
			input,
			cost: {
				input: modelRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD),
				output: modelRate * completionRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD),
				cacheRead: calcCacheCost(modelRate, cacheRatio),
				cacheWrite: calcCacheCost(modelRate, createCacheRatio),
			},
			contextWindow,
			maxTokens,
			compat,
		});
	}

	return models;
}
