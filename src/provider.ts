import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshProviderModels } from "./discovery.ts";
import { DEFAULT_MODEL_API } from "./constants.ts";
import type { NewAPIConfig, ProviderEntry } from "./types.ts";

export interface ProviderRuntimeState {
	registered: Set<string>;
}

export function registerNewAPIProvider(pi: ExtensionAPI, name: string, entry: ProviderEntry): void {
	pi.registerProvider(name, {
		name: `NewAPI (${name})`,
		baseUrl: entry.baseUrl.replace(/\/+$/, ""),
		api: DEFAULT_MODEL_API,
		models: [],
		async refreshModels(context) {
			return refreshProviderModels(name, context);
		},
	});
}

export function registerConfiguredProviders(
	pi: ExtensionAPI,
	config: NewAPIConfig,
	state: ProviderRuntimeState,
): void {
	const builtinProviderIds = getProviders() as unknown as string[];
	for (const [name, entry] of Object.entries(config.providers)) {
		if (builtinProviderIds.includes(name)) {
			console.warn(`NewAPI: skipping provider "${name}" — name collides with a built-in pi provider.`);
			continue;
		}
		if (state.registered.has(name)) {
			console.warn(`NewAPI: skipping duplicate provider key "${name}" in config.`);
			continue;
		}
		if (!entry || typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) {
			console.warn(`NewAPI: skipping provider "${name}" — missing baseUrl.`);
			continue;
		}
		registerNewAPIProvider(pi, name, entry);
		state.registered.add(name);
	}
}
