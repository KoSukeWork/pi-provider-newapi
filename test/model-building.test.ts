import assert from "node:assert/strict";
import { test } from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";

import { buildProviderModels, resolveApiBaseUrl } from "../src/models.ts";
import type { NewAPIModelInfo, Ratios } from "../src/types.ts";

const EMPTY_RATIOS: Ratios = {
	modelRatios: {},
	completionRatios: {},
	cacheRatios: {},
	createCacheRatios: {},
};

test("resolveApiBaseUrl: openai APIs get /v1 suffix", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "openai-completions"), "https://gw.example.com/v1");
	assert.equal(resolveApiBaseUrl("https://gw.example.com/", "openai-responses"), "https://gw.example.com/v1");
});

test("resolveApiBaseUrl: anthropic-messages keeps base URL", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "anthropic-messages"), "https://gw.example.com");
});

test("buildProviderModels: unknown model generates a template override", () => {
	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "totally-unknown-model-xyz", supportedEndpointTypes: [] }],
		ratios: EMPTY_RATIOS,
		modelOverrides: {},
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
		ratios: EMPTY_RATIOS,
		modelOverrides: {},
	});

	assert.equal(models[0].api, "openai-responses");
	assert.equal(newOverrides["unknown-openai-only"].api, "openai-responses");
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("buildProviderModels: existing override takes precedence without a new template", () => {
	const modelOverrides = {
		"custom-model": {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 64000,
			maxTokens: 8192,
		},
	} satisfies Record<string, NewAPIModelInfo>;
	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "custom-model", supportedEndpointTypes: ["openai"] }],
		ratios: EMPTY_RATIOS,
		modelOverrides,
	});

	assert.deepEqual(newOverrides, {});
	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].reasoning, true);
	assert.equal(models[0].contextWindow, 64000);
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("buildProviderModels: costs are derived from ratios", () => {
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

	assert.equal(models[0].cost.input, 2);
	assert.equal(models[0].cost.output, 8);
	assert.equal(models[0].cost.cacheRead, 0);
});

test("buildProviderModels: partial override only patches specified fields", () => {
	const base = getModels("anthropic")[0];
	assert.ok(base, "expected at least one built-in anthropic model");

	const { models, newOverrides } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: base.id, supportedEndpointTypes: [] }],
		ratios: EMPTY_RATIOS,
		modelOverrides: { [base.id]: { reasoning: !base.reasoning } },
	});

	assert.deepEqual(newOverrides, {});
	assert.equal(models[0].reasoning, !base.reasoning);
	assert.equal(models[0].contextWindow, base.contextWindow);
	assert.equal(models[0].maxTokens, base.maxTokens);
	assert.deepEqual(models[0].input, base.input);
});

test("buildProviderModels: session affinity is enabled for supported APIs only", () => {
	const modelOverrides = {
		"openai-compatible": { api: "openai-completions" },
		"anthropic-compatible": { api: "anthropic-messages" },
		"responses-compatible": { api: "openai-responses" },
	} satisfies Record<string, NewAPIModelInfo>;
	const { models } = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [
			{ id: "openai-compatible", supportedEndpointTypes: ["openai"] },
			{ id: "anthropic-compatible", supportedEndpointTypes: ["anthropic"] },
			{ id: "responses-compatible", supportedEndpointTypes: ["openai"] },
		],
		ratios: EMPTY_RATIOS,
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
		ratios: EMPTY_RATIOS,
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
		ratios: EMPTY_RATIOS,
		modelOverrides: {},
		settings: { sendSessionAffinityHeaders: false },
	});

	assert.equal(models[0].compat, undefined);
});
