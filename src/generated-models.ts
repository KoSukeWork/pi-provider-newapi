/** Builds and writes copy-ready Pi modelOverrides templates for unknown NewAPI models. */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./constants.ts";
import { isEnrichedModelId } from "./models.ts";

export interface GeneratedModelOverride {
	reasoning: false;
	input: ["text"];
	contextWindow: number;
	maxTokens: number;
}

export interface GeneratedModelsJson {
	providers: Record<
		string,
		{
			modelOverrides: Record<string, GeneratedModelOverride>;
		}
	>;
}

export function buildGeneratedModelsJson(
	providerNames: readonly string[],
	models: readonly Model<Api>[],
): GeneratedModelsJson {
	const providers: GeneratedModelsJson["providers"] = {};
	const configured = new Set(providerNames);
	const modelsByProvider = new Map<string, Set<string>>();

	// Enriched models already inherit Pi metadata; only unknown models need editable templates.
	for (const model of models) {
		if (!configured.has(model.provider) || isEnrichedModelId(model.id)) continue;
		const ids = modelsByProvider.get(model.provider) ?? new Set<string>();
		ids.add(model.id);
		modelsByProvider.set(model.provider, ids);
	}

	// Stable provider and model ordering keeps regenerated files easy to compare and merge.
	for (const providerName of [...configured].sort()) {
		const ids = modelsByProvider.get(providerName);
		if (!ids || ids.size === 0) continue;
		const modelOverrides: Record<string, GeneratedModelOverride> = {};
		for (const id of [...ids].sort()) {
			modelOverrides[id] = {
				reasoning: false,
				input: ["text"],
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
			};
		}
		providers[providerName] = { modelOverrides };
	}

	return { providers };
}

export function getGeneratedModelsPath(): string {
	return join(getAgentDir(), "models-generated.json");
}

export function writeGeneratedModelsJson(config: GeneratedModelsJson, outputPath = getGeneratedModelsPath()): void {
	const outputDir = dirname(outputPath);
	if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
	const tmpPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, outputPath);
}
