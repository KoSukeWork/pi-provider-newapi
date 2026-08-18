/** Reads, normalizes, and atomically updates extension-owned provider configuration. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { deserializeVersionedConfig } from "./config-schema.ts";
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION } from "./constants.ts";
import { migrateConfig, resetInvalidConfig } from "./migration.ts";
import type { NewAPIConfig } from "./types.ts";
import { normalizeBaseUrl } from "./urls.ts";

export function getConfigPath(): string {
	return join(getAgentDir(), "extension-settings", CONFIG_FILENAME);
}

/** Parse JSON and validate every field represented by the current config schema. */
export function deserializeConfig(raw: string): NewAPIConfig {
	const parsed = deserializeVersionedConfig(raw);
	if (parsed.kind !== "v1") {
		throw new Error(`expected config schema v${CONFIG_SCHEMA_VERSION}, received schema v${parsed.schemaVersion}`);
	}
	const providers = Object.fromEntries(
		Object.entries(parsed.data.providers).map(([name, entry]) => {
			try {
				return [name, { ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) }];
			} catch (error) {
				throw new Error(
					`config.providers.${name}.baseUrl is invalid: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	);
	return { ...parsed.data, providers };
}

export function readConfig(): NewAPIConfig {
	// Resolve legacy path and schema versions before interpreting the current config shape.
	const { path: configPath } = migrateConfig(getConfigPath());
	const empty: NewAPIConfig = { version: CONFIG_SCHEMA_VERSION, providers: {}, settings: {} };

	if (!existsSync(configPath)) return empty;

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		console.warn(`NewAPI: could not read config: ${err instanceof Error ? err.message : String(err)}`);
		return empty;
	}

	try {
		return deserializeConfig(raw);
	} catch (error) {
		resetInvalidConfig(configPath, error);
		return empty;
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
