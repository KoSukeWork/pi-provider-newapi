import type { Api, Model } from "@earendil-works/pi-ai";

export type NewAPIModelApi = Extract<Api, "anthropic-messages" | "openai-completions" | "openai-responses">;

export interface ProviderEntry {
	baseUrl: string;
	modelApiOverrides: Record<string, NewAPIModelApi>;
}

export interface Settings {
	onboardingWarnCountdown?: number;
}

export interface NewAPIConfig {
	providers: Record<string, ProviderEntry>;
	settings: Settings;
}

export interface NewAPIModelEntry {
	/** Model ID, e.g. "claude-opus-4-7". */
	id: string;
	/** Upstream owner label reported by the gateway, e.g. "google gemini". */
	ownedBy?: string;
	/** Endpoint types the gateway serves for each model, e.g. ["anthropic", "openai"]. */
	supportedEndpointTypes: string[];
}

export interface Ratios {
	modelRatios: Record<string, number>;
	completionRatios: Record<string, number>;
	cacheRatios: Record<string, number>;
	createCacheRatios: Record<string, number>;
}

export const EMPTY_RATIOS: Ratios = {
	modelRatios: {},
	completionRatios: {},
	cacheRatios: {},
	createCacheRatios: {},
};

export interface ModelLookupItem {
	model: Model<Api>;
	source: string;
}
