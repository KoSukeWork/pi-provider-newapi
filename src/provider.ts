/** Registers configured NewAPI gateways as dynamic Pi model providers. */

import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshProviderModels } from "./discovery.ts";
import { DEFAULT_MODEL_API } from "./constants.ts";
import type { NewAPIConfig, ProviderEntry } from "./types.ts";
import { normalizeBaseUrl } from "./urls.ts";

export interface ProviderRuntimeState {
	registered: Set<string>;
}

export function registerNewAPIProvider(pi: ExtensionAPI, name: string, entry: ProviderEntry): void {
	const baseUrl = normalizeBaseUrl(entry.baseUrl);
	pi.registerProvider(name, {
		name: `NewAPI (${name})`,
		baseUrl,
		api: DEFAULT_MODEL_API,
		// The empty startup catalog makes /login available before authenticated discovery runs.
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
		// Invalid or colliding entries are isolated so other configured gateways still register.
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
		try {
			registerNewAPIProvider(pi, name, entry);
		} catch (error) {
			console.warn(
				`NewAPI: skipping provider "${name}" — invalid baseUrl (${error instanceof Error ? error.message : String(error)}).`,
			);
			continue;
		}
		state.registered.add(name);
	}
}
