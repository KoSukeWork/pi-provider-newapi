/** Shared constants for configuration, discovery, API routing, and model defaults. */

import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { NewAPIModelApi } from "./types.ts";

export const CONFIG_FILENAME = "provider-newapi.json";
export const CONFIG_SCHEMA_VERSION = 1;
export const QUOTA_PER_USD = 500_000;
export const TOKENS_PER_COST = 1_000_000;
export const DEFAULT_GROUP_RATE = 1.0;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const RATIO_CONFIG_FETCH_TIMEOUT_MS = 10_000;
export const REACHABILITY_FETCH_TIMEOUT_MS = 5_000;
export const DEFAULT_MODEL_API: NewAPIModelApi = "anthropic-messages";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 32_768;
export const ONBOARDING_WARN_MAX = 3;

export const SUPPORTED_NEWAPI_MODEL_APIS = new Set<NewAPIModelApi>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
]);

/** Map NewAPI endpoint types to the Pi APIs that can serve them. */
export const ENDPOINT_TYPE_TO_APIS: Record<string, readonly NewAPIModelApi[]> = {
	anthropic: ["anthropic-messages"],
	openai: ["openai-completions", "openai-responses"],
};

/** Preferred order when a gateway advertises several usable APIs. */
export const API_PREFERENCE: readonly NewAPIModelApi[] = [
	"anthropic-messages",
	"openai-responses",
	"openai-completions",
];

export const ENRICHMENT_PROVIDERS: readonly BuiltinProvider[] = [
	"deepseek",
	"zai",
	"google",
	"anthropic",
	"minimax",
	"moonshotai",
	"xiaomi",
	"openai",
	"vercel-ai-gateway",
];
