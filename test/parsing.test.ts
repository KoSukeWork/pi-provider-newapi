import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelsResponse, parseRatioConfig } from "../src/models.ts";

test("parseModelsResponse: extracts ids and skips malformed entries", () => {
	const models = parseModelsResponse({ data: [{ id: "a" }, { foo: 1 }, { id: 2 }, { id: "b" }] });
	assert.deepEqual(models.map((model) => model.id), ["a", "b"]);
});

test("parseModelsResponse: captures owner and supported endpoint types", () => {
	const models = parseModelsResponse({
		data: [
			{
				id: "claude-opus-4-7",
				owned_by: "claude",
				supported_endpoint_types: ["anthropic", "openai", 42],
			},
			{ id: "legacy-no-endpoints" },
		],
	});

	assert.equal(models[0].ownedBy, "claude");
	assert.deepEqual(models[0].supportedEndpointTypes, ["anthropic", "openai"]);
	assert.equal(models[1].ownedBy, undefined);
	assert.deepEqual(models[1].supportedEndpointTypes, []);
});

test("parseModelsResponse: throws on non-object payload", () => {
	assert.throws(() => parseModelsResponse("nope"));
});

test("parseModelsResponse: throws when data is not an array", () => {
	assert.throws(() => parseModelsResponse({ data: { id: "a" } }));
});

test("parseRatioConfig: reads maps from data", () => {
	const ratios = parseRatioConfig({
		success: true,
		data: {
			model_ratio: { m: 2 },
			completion_ratio: { m: 3 },
			cache_ratio: { m: 0.5 },
			create_cache_ratio: { m: 1.25 },
		},
	});

	assert.equal(ratios.modelRatios.m, 2);
	assert.equal(ratios.completionRatios.m, 3);
	assert.equal(ratios.cacheRatios.m, 0.5);
	assert.equal(ratios.createCacheRatios.m, 1.25);
});

test("parseRatioConfig: success:false yields empty maps", () => {
	const ratios = parseRatioConfig({ success: false, data: { model_ratio: { m: 2 } } });
	assert.deepEqual(ratios.modelRatios, {});
});

test("parseRatioConfig: malformed input yields empty maps", () => {
	assert.deepEqual(parseRatioConfig(null).modelRatios, {});
	assert.deepEqual(parseRatioConfig("x").completionRatios, {});
});

test("parseRatioConfig: filters non-numeric ratio values", () => {
	const ratios = parseRatioConfig({ data: { model_ratio: { good: 2, bad: "x", nan: Number.NaN } } });
	assert.deepEqual(ratios.modelRatios, { good: 2 });
});
