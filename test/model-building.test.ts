import assert from "node:assert/strict";
import { test } from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";

import {
	buildProviderModels,
	compileModelApiOverrides,
	findModelApiOverride,
	resolveApiBaseUrl,
} from "../src/models.ts";
import type { Ratios } from "../src/types.ts";

const EMPTY_RATIOS: Ratios = {
	modelRatios: {},
	completionRatios: {},
	cacheRatios: {},
	createCacheRatios: {},
};

function build(models: Array<{ id: string; supportedEndpointTypes: string[] }>, overrides: Record<string, string> = {}) {
	return buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: models,
		ratios: EMPTY_RATIOS,
		modelApiOverrides: overrides,
	});
}

test("resolveApiBaseUrl: openai APIs get /v1 suffix", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "openai-completions"), "https://gw.example.com/v1");
	assert.equal(resolveApiBaseUrl("https://gw.example.com/", "openai-responses"), "https://gw.example.com/v1");
});

test("resolveApiBaseUrl: anthropic-messages keeps base URL", () => {
	assert.equal(resolveApiBaseUrl("https://gw.example.com", "anthropic-messages"), "https://gw.example.com");
});

test("buildProviderModels: unknown models use in-memory defaults", () => {
	const models = build([{ id: "totally-unknown-model-xyz", supportedEndpointTypes: [] }]);

	assert.equal(models.length, 1);
	assert.equal(models[0].id, "totally-unknown-model-xyz");
	assert.equal(models[0].api, "anthropic-messages");
	assert.equal(models[0].reasoning, false);
	assert.deepEqual(models[0].input, ["text"]);
	assert.equal(models[0].contextWindow, 128000);
	assert.equal(models[0].maxTokens, 32768);
	assert.equal(models[0].compat, undefined);
});

test("buildProviderModels: unknown model API follows supported endpoints", () => {
	const models = build([{ id: "unknown-openai-only", supportedEndpointTypes: ["openai"] }]);

	assert.equal(models[0].api, "openai-responses");
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("buildProviderModels: regex API override is authoritative", () => {
	const models = build(
		[{ id: "custom-model", supportedEndpointTypes: ["anthropic"] }],
		{ "^custom-": "openai-completions" },
	);

	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].baseUrl, "https://gw.example.com/v1");
});

test("compileModelApiOverrides: first matching regex wins", () => {
	const { rules, errors } = compileModelApiOverrides({
		"^gpt-": "openai-responses",
		"^gpt-special$": "openai-completions",
	});

	assert.deepEqual(errors, []);
	assert.equal(findModelApiOverride("gpt-special", rules), "openai-responses");
});

test("compileModelApiOverrides: invalid regex and API values are rejected", () => {
	const { rules, errors } = compileModelApiOverrides({
		"[": "openai-responses",
		"^model$": "unsupported-api",
	});

	assert.deepEqual(rules, []);
	assert.equal(errors.length, 2);
	assert.match(errors[0], /invalid regex/);
	assert.match(errors[1], /unsupported API/);
});

test("buildProviderModels: costs are derived from ratios", () => {
	const models = buildProviderModels({
		providerName: "gw",
		baseUrl: "https://gw.example.com",
		apiModels: [{ id: "unknown-cost-model", supportedEndpointTypes: [] }],
		ratios: {
			modelRatios: { "unknown-cost-model": 1 },
			completionRatios: { "unknown-cost-model": 4 },
			cacheRatios: {},
			createCacheRatios: {},
		},
		modelApiOverrides: {},
	});

	assert.equal(models[0].cost.input, 2);
	assert.equal(models[0].cost.output, 8);
	assert.equal(models[0].cost.cacheRead, 0);
});

test("buildProviderModels: enriched metadata and compatibility are preserved", () => {
	const base = getModels("deepseek")[0];
	assert.ok(base, "expected at least one built-in deepseek model");

	const models = build([{ id: base.id, supportedEndpointTypes: [] }]);

	assert.equal(models[0].reasoning, base.reasoning);
	assert.equal(models[0].contextWindow, base.contextWindow);
	assert.equal(models[0].maxTokens, base.maxTokens);
	assert.deepEqual(models[0].input, base.input);
	assert.deepEqual(models[0].compat, {
		...base.compat,
		supportsDeveloperRole: false,
	});
});
