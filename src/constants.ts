import type { Api } from "@earendil-works/pi-ai";
import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";

export const CONFIG_FILENAME = "provider-newapi.json";
export const QUOTA_PER_USD = 500_000;
export const TOKENS_PER_COST = 1_000_000;
export const DEFAULT_GROUP_RATE = 1.0;
export const FETCH_TIMEOUT_MS = 3_000;
export const DEFAULT_MODEL_API: Api = "anthropic-messages";
export const ONBOARDING_WARN_MAX = 3;

export const SUPPORTED_NEWAPI_MODEL_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
]);

/** Map NewAPI endpoint types to the Pi APIs that can serve them. */
export const ENDPOINT_TYPE_TO_APIS: Record<string, readonly Api[]> = {
	anthropic: ["anthropic-messages"],
	openai: ["openai-completions", "openai-responses"],
};

/** Preferred order when a gateway advertises several usable APIs. */
export const API_PREFERENCE: readonly Api[] = [
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
