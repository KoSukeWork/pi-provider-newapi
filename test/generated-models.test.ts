/** Verifies unknown-model template generation and atomic generated-file output. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

import { buildGeneratedModelsJson, writeGeneratedModelsJson } from "../src/generated-models.ts";

function model(provider: string, id: string): Model<Api> {
	const base = getModels("anthropic")[0];
	assert.ok(base, "expected at least one built-in anthropic model");
	return { ...base, provider, id, name: id };
}

test("buildGeneratedModelsJson: emits only unknown models for configured providers", () => {
	const known = getModels("anthropic")[0];
	assert.ok(known, "expected at least one built-in anthropic model");
	const generated = buildGeneratedModelsJson(
		["gw"],
		[
			model("gw", "unknown-z"),
			model("gw", known.id),
			model("other", "unknown-other"),
			model("gw", "unknown-a"),
		],
	);

	assert.deepEqual(Object.keys(generated.providers), ["gw"]);
	assert.deepEqual(Object.keys(generated.providers.gw.modelOverrides), ["unknown-a", "unknown-z"]);
	assert.deepEqual(generated.providers.gw.modelOverrides["unknown-a"], {
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 32768,
	});
	assert.equal(Object.keys(generated.providers.gw.modelOverrides).length, 2);
});

test("writeGeneratedModelsJson: writes valid formatted JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "newapi-generated-models-"));
	const outputPath = join(dir, "models-generated.json");
	try {
		const generated = buildGeneratedModelsJson(["gw"], [model("gw", "unknown-model")]);
		writeGeneratedModelsJson(generated, outputPath);
		assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), generated);
		assert.equal(readFileSync(outputPath, "utf-8").endsWith("\n"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
