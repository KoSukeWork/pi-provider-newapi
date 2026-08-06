import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME, SUPPORTED_NEWAPI_MODEL_APIS } from "./constants.ts";
import type { NewAPIConfig, NewAPIModelApi, ProviderEntry } from "./types.ts";

export function getConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

const emittedConfigWarnings = new Set<string>();

function warnConfigOnce(key: string, message: string): void {
	if (emittedConfigWarnings.has(key)) return;
	emittedConfigWarnings.add(key);
	console.warn(message);
}

function parseProviders(value: Record<string, unknown>): Record<string, ProviderEntry> {
	const providers: Record<string, ProviderEntry> = {};
	for (const [name, rawEntry] of Object.entries(value)) {
		if (typeof rawEntry !== "object" || rawEntry === null) continue;
		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.modelOverrides === "object" && entry.modelOverrides !== null) {
			warnConfigOnce(
				`legacy-model-overrides:${name}`,
				`NewAPI [${name}]: modelOverrides is no longer supported. Move API routing to modelApiOverrides ` +
					`and metadata/compat overrides to Pi's models.json.`,
			);
		}

		const modelApiOverrides: Record<string, NewAPIModelApi> = {};
		if (typeof entry.modelApiOverrides === "object" && entry.modelApiOverrides !== null) {
			for (const [pattern, api] of Object.entries(entry.modelApiOverrides as Record<string, unknown>)) {
				if (typeof api === "string" && SUPPORTED_NEWAPI_MODEL_APIS.has(api as NewAPIModelApi)) {
					modelApiOverrides[pattern] = api as NewAPIModelApi;
				} else {
					warnConfigOnce(
						`unsupported-api:${name}:${pattern}`,
						`NewAPI [${name}]: modelApiOverrides pattern "${pattern}" has unsupported API "${String(api)}" — ignoring it.`,
					);
				}
			}
		}

		providers[name] = {
			baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
			modelApiOverrides,
		};
	}
	return providers;
}

export function readConfig(): NewAPIConfig {
	const configPath = getConfigPath();
	const empty: NewAPIConfig = { providers: {}, settings: {} };

	if (!existsSync(configPath)) return empty;

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		console.warn(`NewAPI: could not read config: ${err instanceof Error ? err.message : String(err)}`);
		return empty;
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		invalidateConfig(configPath, raw);
		return empty;
	}

	if (
		typeof data !== "object" ||
		data === null ||
		!("providers" in data) ||
		typeof (data as Record<string, unknown>).providers !== "object" ||
		(data as Record<string, unknown>).providers === null
	) {
		invalidateConfig(configPath, raw);
		return empty;
	}

	const parsed = data as Record<string, unknown>;
	const rawSettings =
		typeof parsed.settings === "object" && parsed.settings !== null
			? (parsed.settings as Record<string, unknown>)
			: {};
	return {
		providers: parseProviders(parsed.providers as Record<string, unknown>),
		settings: {
			onboardingWarnCountdown:
				typeof rawSettings.onboardingWarnCountdown === "number"
					? rawSettings.onboardingWarnCountdown
					: undefined,
		},
	};
}

function invalidateConfig(configPath: string, raw: string): void {
	const backupPath = `${configPath}.bak`;
	console.warn(`NewAPI: config is invalid — backing up to ${backupPath} and starting with empty config.`);
	try {
		writeFileSync(backupPath, raw, "utf-8");
	} catch (err) {
		console.warn(`NewAPI: could not write config backup: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		writeConfigAtomic({ providers: {}, settings: {} });
	} catch (err) {
		console.warn(`NewAPI: could not reset config file: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Write configuration through a temporary file so readers never see a partial JSON document. */
export function writeConfigAtomic(config: NewAPIConfig): void {
	const configPath = getConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
	renameSync(tmpPath, configPath);
}

let configWriteQueue: Promise<void> = Promise.resolve();

/** Serialize read-modify-write operations so concurrent provider refreshes cannot clobber entries. */
export function updateConfig(mutator: (config: NewAPIConfig) => boolean): Promise<void> {
	const run = configWriteQueue.then(async () => {
		const config = readConfig();
		if (mutator(config)) writeConfigAtomic(config);
	});
	configWriteQueue = run.catch(() => {});
	return run;
}
