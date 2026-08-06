import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface NewAPIModelInfo {
	api?: Api;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

export interface ProviderEntry {
	baseUrl: string;
	modelOverrides: Record<string, NewAPIModelInfo>;
}

export interface Settings {
	onboardingWarnCountdown?: number;
	sendSessionAffinityHeaders?: boolean;
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

export interface BuildModelsResult {
	models: ProviderModelConfig[];
	newOverrides: Record<string, NewAPIModelInfo>;
}

export interface ModelLookupItem {
	model: Model<Api>;
	source: string;
}
