/** Discovers NewAPI models and maintains Pi's provider-scoped catalog cache. */

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { fetchWithTimeout, NewAPIError } from "./http.ts";
import { buildProviderModels, parseModelsResponse, parseRatioConfig } from "./models.ts";
import { EMPTY_RATIOS } from "./types.ts";

/** Refresh the provider catalog while retaining the last good cached result on failure. */
export async function refreshProviderModels(
	providerName: string,
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
	const config = readConfig();
	const entry = config.providers[providerName];
	if (!entry) return [];

	const cached = await context.store.read();
	const cachedModels = (cached?.models ?? []) as unknown as ProviderModelConfig[];
	// Offline startup and cancelled refreshes must never discard the last usable catalog.
	if (!context.allowNetwork || context.signal?.aborted) return cachedModels;

	const credential = context.credential;
	const apiKey = credential?.type === "api_key" && credential.key ? credential.key : undefined;

	try {
		const baseUrl = entry.baseUrl.replace(/\/+$/, "");
		// Ratio metadata improves cost reporting but is not required for model discovery.
		let ratios = EMPTY_RATIOS;
		try {
			const ratioResponse = await fetchWithTimeout(`${baseUrl}/api/ratio_config`, { signal: context.signal });
			if (ratioResponse.ok) ratios = parseRatioConfig(await ratioResponse.json());
		} catch (err) {
			if (err instanceof NewAPIError && err.code === "aborted") throw err;
			console.warn(
				`NewAPI [${providerName}]: /api/ratio_config unavailable — ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const modelsResponse = await fetchWithTimeout(`${baseUrl}/v1/models`, {
			headers,
			signal: context.signal,
		});
		if (modelsResponse.status === 401 || modelsResponse.status === 403) {
			throw new NewAPIError(
				"auth",
				`GET /v1/models: ${modelsResponse.status} ${modelsResponse.statusText} — check the API key`,
			);
		}
		if (!modelsResponse.ok) {
			throw new NewAPIError("http", `GET /v1/models: ${modelsResponse.status} ${modelsResponse.statusText}`);
		}

		const models = buildProviderModels({
			providerName,
			baseUrl,
			apiModels: parseModelsResponse(await modelsResponse.json()),
			ratios,
			modelApiOverrides: entry.modelApiOverrides ?? {},
		});

		// Treat a transient empty response as a failed refresh when a prior catalog exists.
		if (models.length === 0 && cachedModels.length > 0) {
			console.warn(`NewAPI [${providerName}]: /v1/models returned zero models — keeping cached catalog.`);
			return cachedModels;
		}

		await context.store.write({
			models: models as unknown as Model<Api>[],
			checkedAt: Date.now(),
		});
		return models;
	} catch (err) {
		// Discovery failures are isolated to this refresh; Pi can continue with cached models.
		if (err instanceof NewAPIError && err.code === "aborted") return cachedModels;
		console.warn(
			`NewAPI [${providerName}]: refresh failed — ${err instanceof Error ? err.message : String(err)}` +
				(cachedModels.length > 0 ? " (serving cached catalog)" : ""),
		);
		return cachedModels;
	}
}
