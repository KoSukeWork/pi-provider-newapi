import assert from "node:assert/strict";
import { test } from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";

import {
	buildProviderModels,
	calcCacheCost,
	calcInputCost,
	calcOutputCost,
	findRatio,
	parseModelsResponse,
	parseRatioConfig,
	resolveApiBaseUrl,
} from "./index.ts";

// ---------------------------------------------------------------------------
// findRatio: exact, case-insensitive, and prefix matching
// ---------------------------------------------------------------------------

test("findRatio: exact match wins", () => {
	assert.equal(findRatio("gpt-4o", { "gpt-4o": 2.5, "gpt": 1 }), 2.5);
});

test("findRatio: case-insensitive match", () => {
	assert.equal(findRatio("GPT-4O", { "gpt-4o": 3 }), 3);
});

test("findRatio: prefix match as fallback", () => {
	assert.equal(findRatio("claude-3-5-sonnet-20241022", { "claude-3-5-sonnet": 4 }), 4);
});

test("findRatio: no match returns undefined", () => {
	assert.equal(findRatio("unknown", { "other": 1 }), undefined);
});

// ---------------------------------------------------------------------------
// Cost conversion from NewAPI quota ratios (1 USD = 500,000 quota, per 1M tok)
// ---------------------------------------------------------------------------

test("calcInputCost: modelRate 1 => $2 per 1M tokens", () => {
	assert.equal(calcInputCost(1), 2);
});

test("calcOutputCost applies completion ratio", () => {
	// 1 * 3 * 1 * (1_000_000 / 500_000) = 6
	assert.equal(calcOutputCost(1, 3), 6);
});

test("calcCacheCost applies cache ratio", () => {
	// 2 * 0.25 * 1 * 2 = 1
	assert.equal(calcCacheCost(2, 0.25), 1);
});

// ---------------------------------------------------------------------------
// Per-model API + base URL routing
// ---------------------------------------------------------------------------

test("resolveApiBaseUrl: openai APIs get /v1 suffix", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "openai-completions"), "https://gw.example.com/v1");
	assert.equal(resolveApiBaseUrl("https://gw.example.com/", "openai-responses"), "https://gw.example.com/v1");
});

test("resolveApiBaseUrl: anthropic-messages keeps base URL", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "anthropic-messages"), "https://gw.example.com");
});

// ---------------------------------------------------------------------------
// Defensive parsing of /v1/models
// ---------------------------------------------------------------------------

test("parseModelsResponse: extracts ids, skips malformed entries", () => {
	const out = parseModelsResponse({ data: [{ id: "a" }, { foo: 1 }, { id: 2 }, { id: "b" }] });
	assert.deepEqual(out.map((m) => m.id), ["a", "b"]);
});

test("parseModelsResponse: captures owned_by and supported_endpoint_types", () => {
	const out = parseModelsResponse({
		data: [
			{
				id: "claude-opus-4-7",
				owned_by: "claude",
				supported_endpoint_types: ["anthropic", "openai", 42],
			},
			{ id: "legacy-no-endpoints" },
		],
	});
	assert.equal(out[0].ownedBy, "claude");
	assert.deepEqual(out[0].supportedEndpointTypes, ["anthropic", "openai"]);
	// Missing fields degrade gracefully.
	assert.equal(out[1].ownedBy, undefined);
	assert.deepEqual(out[1].supportedEndpointTypes, []);
});

test("parseModelsResponse: throws on non-object payload", () => {
	assert.throws(() => parseModelsResponse("nope"));
});

test("parseModelsResponse: throws when data is not an array", () => {
	assert.throws(() => parseModelsResponse({ data: { id: "a" } }));
});

// ---------------------------------------------------------------------------
// Defensive parsing of /api/ratio_config
// ---------------------------------------------------------------------------

test("parseRatioConfig: reads maps from data", () => {
	const r = parseRatioConfig({
		success: true,
		data: {
			model_ratio: { "m": 2 },
			completion_ratio: { "m": 3 },
			cache_ratio: { "m": 0.5 },
			create_cache_ratio: { "m": 1.25 },
		},
	});
	assert.equal(r.modelRatios.m, 2);
	assert.equal(r.completionRatios.m, 3);
	assert.equal(r.cacheRatios.m, 0.5);
	assert.equal(r.createCacheRatios.m, 1.25);
});

test("parseRatioConfig: success:false yields empty maps", () => {
	const r = parseRatioConfig({ success: false, data: { model_ratio: { m: 2 } } });
	assert.deepEqual(r.modelRatios, {});
});

test("parseRatioConfig: malformed input yields empty maps", () => {
	assert.deepEqual(parseRatioConfig(null).modelRatios, {});
	assert.deepEqual(parseRatioConfig("x").completionRatios, {});
});

test("parseRatioConfig: filters non-numeric ratio values", () => {
	const r = parseRatioConfig({ data: { model_ratio: { good: 2, bad: "x", nan: NaN } } });
	assert.deepEqual(r.modelRatios, { good: 2 });
});

// ---------------------------------------------------------------------------
// buildProviderModels: unknown-model templates, overrides, routing
// ---------------------------------------------------------------------------

test("buildProviderModels: unknown model generates a template override", () => {
	const modelOverrides: Record<string, any> = {};
	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "totally-unknown-model-xyz", supportedEndpointTypes: [] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides,
	});

	assert.equal(models.length, 1);
	assert.equal(models[0].id, "totally-unknown-model-xyz");
	assert.equal(models[0].api, "anthropic-messages");
	assert.ok(newOverrides["totally-unknown-model-xyz"]);
	assert.equal(newOverrides["totally-unknown-model-xyz"].contextWindow, 128000);
	assert.deepEqual(models[0].compat, { sendSessionAffinityHeaders: true });
});

test("buildProviderModels: unknown model template api follows supported endpoints", () => {
	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "unknown-openai-only", supportedEndpointTypes: ["openai"] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides: {},
	});

	// "openai" endpoint prefers openai-responses per API_PREFERENCE.
	assert.equal(models[0].api, "openai-responses");
	assert.equal(newOverrides["unknown-openai-only"].api, "openai-responses");
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("buildProviderModels: existing override takes precedence, no new template", () => {
	const modelOverrides: Record<string, any> = {
		"custom-model": {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 64000,
			maxTokens: 8192,
		},
	};
	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "custom-model", supportedEndpointTypes: ["openai"] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides,
	});

	assert.deepEqual(newOverrides, {});
	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].reasoning, true);
	assert.equal(models[0].contextWindow, 64000);
	// openai-completions routes to /v1
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("buildProviderModels: costs derived from ratios", () => {
	const { models } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "unknown-cost-model", supportedEndpointTypes: [] }],
		ratios: {
			modelRatios: { "unknown-cost-model": 1 },
			completionRatios: { "unknown-cost-model": 4 },
			cacheRatios: {},
			createCacheRatios: {},
		},
		modelOverrides: {},
	});

	assert.equal(models[0].cost.input, 2); // 1 * 2
	assert.equal(models[0].cost.output, 8); // 1 * 4 * 2
	assert.equal(models[0].cost.cacheRead, 0);
});

test("buildProviderModels: partial override only patches specified fields", () => {
	// Use a real built-in model so the enrichment path is exercised.
	const base = getModels("anthropic")[0];
	assert.ok(base, "expected at least one built-in anthropic model");

	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: base.id, supportedEndpointTypes: [] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		// Only `reasoning` is specified — everything else must come from enrichment.
		modelOverrides: { [base.id]: { reasoning: !base.reasoning } },
	});

	assert.deepEqual(newOverrides, {}); // known model, no template generated
	assert.equal(models[0].reasoning, !base.reasoning); // overridden field applied
	assert.equal(models[0].contextWindow, base.contextWindow); // preserved from enrichment
	assert.equal(models[0].maxTokens, base.maxTokens); // preserved from enrichment
	assert.deepEqual(models[0].input, base.input); // preserved from enrichment
});

test("buildProviderModels: session affinity is enabled for supported APIs only", () => {
	const modelOverrides: Record<string, any> = {
		"openai-compatible": { api: "openai-completions" },
		"anthropic-compatible": { api: "anthropic-messages" },
		"responses-compatible": { api: "openai-responses" },
	};
	const { models } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [
			{ id: "openai-compatible", supportedEndpointTypes: ["openai"] },
			{ id: "anthropic-compatible", supportedEndpointTypes: ["anthropic"] },
			{ id: "responses-compatible", supportedEndpointTypes: ["openai"] },
		],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides,
		settings: { sendSessionAffinityHeaders: true },
	});

	assert.deepEqual(models[0].compat, { sendSessionAffinityHeaders: true });
	assert.deepEqual(models[1].compat, { sendSessionAffinityHeaders: true });
	assert.equal(models[2].compat, undefined);
});

test("buildProviderModels: session affinity preserves enriched compatibility", () => {
	const base = getModels("deepseek")[0];
	assert.ok(base, "expected at least one built-in deepseek model");

	const { models } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: base.id, supportedEndpointTypes: [] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides: {},
		settings: { sendSessionAffinityHeaders: true },
	});

	assert.deepEqual(models[0].compat, {
		...base.compat,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
	});
});

test("buildProviderModels: session affinity can be disabled", () => {
	const { models } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "disabled-affinity", supportedEndpointTypes: [] }],
		ratios: { modelRatios: {}, completionRatios: {}, cacheRatios: {}, createCacheRatios: {} },
		modelOverrides: {},
		settings: { sendSessionAffinityHeaders: false },
	});

	assert.equal(models[0].compat, undefined);
});
