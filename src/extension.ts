import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig, updateConfig } from "./config.ts";
import { ONBOARDING_WARN_MAX } from "./constants.ts";
import { registerCommands } from "./commands.ts";
import { registerConfiguredProviders } from "./provider.ts";
import type { ProviderRuntimeState } from "./provider.ts";

export default async function newApiExtension(pi: ExtensionAPI): Promise<void> {
	const config = readConfig();
	const state: ProviderRuntimeState = { registered: new Set<string>() };
	registerConfiguredProviders(pi, config, state);

	if (state.registered.size === 0) {
		const countdown = config.settings.onboardingWarnCountdown ?? ONBOARDING_WARN_MAX;
		if (countdown > 0) {
			console.warn("NewAPI: no providers configured. Run /newapi-provider-add to add a NewAPI gateway.");
			void updateConfig((latestConfig) => {
				latestConfig.settings.onboardingWarnCountdown = countdown - 1;
				return true;
			});
		}
	}

	registerCommands(pi, state);
}
