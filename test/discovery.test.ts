/** Verifies Pi v0.84 dynamic-catalog restoration and publication behavior. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { writeConfigAtomic } from "../src/config.ts";
import { refreshProviderModels } from "../src/discovery.ts";

type ModelsPublication = Parameters<RefreshModelsContext["publish"]>[0];

function cachedModel(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://gw.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
	};
}

function storedModels(models: ProviderModelConfig[]): readonly Model<Api>[] {
	return models as unknown as readonly Model<Api>[];
}

async function withAgentDir(run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "newapi-discovery-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeConfigAtomic({
			version: 1,
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: {},
		});
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("refreshProviderModels: restores context.stored without network access", async () => {
	await withAgentDir(async () => {
		const cached = [cachedModel("cached-model")];
		const result = await refreshProviderModels("gw", {
			allowNetwork: false,
			signal: new AbortController().signal,
			stored: { models: storedModels(cached), checkedAt: 1 },
			publish: async () => {
				throw new Error("offline refresh must not publish");
			},
		});

		assert.deepEqual(result, cached);
	});
});

test("refreshProviderModels: persists fresh models through context.publish", async () => {
	await withAgentDir(async () => {
		const previousFetch = globalThis.fetch;
		const requestedUrls: string[] = [];
		const requestedOptions: RequestInit[] = [];
		const publications: ModelsPublication[] = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requestedUrls.push(url);
			requestedOptions.push(init ?? {});
			const payload = url.endsWith("/api/ratio_config")
				? { success: true, data: {} }
				: { data: [{ id: "fresh-model", supported_endpoint_types: ["openai"] }] };
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		try {
			const context: RefreshModelsContext = {
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async (publication) => {
					publications.push(publication);
					return true;
				},
			};
			const result = await refreshProviderModels("gw", context);

			assert.deepEqual(requestedUrls, [
				"https://gw.example.com/api/ratio_config",
				"https://gw.example.com/v1/models",
			]);
			assert.deepEqual(requestedOptions.map((options) => options.redirect), ["error", "error"]);
			assert.equal(result.length, 1);
			assert.equal(result[0].id, "fresh-model");
			assert.equal(publications.length, 1);
			assert.deepEqual(publications[0].persist?.models, storedModels(result));
			assert.equal(typeof publications[0].persist?.checkedAt, "number");
			assert.equal(publications[0].update, undefined);
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});
