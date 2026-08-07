/** Detects, archives, and migrates extension configuration paths and schema versions. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	deserializeVersionedConfig,
	detectConfigSchemaVersion,
	type ParsedConfig,
} from "./config-schema.ts";
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION } from "./constants.ts";
import type { NewAPIConfig, ProviderEntry } from "./types.ts";

export interface ConfigVersion {
	path: string;
	schemaVersion: number;
}

function getCurrentConfigPath(): string {
	return join(getAgentDir(), "extension-settings", CONFIG_FILENAME);
}

export function getLegacyConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

function parseConfig(path: string): ParsedConfig {
	return deserializeVersionedConfig(readFileSync(path, "utf-8"));
}

function readSchemaVersion(path: string): number {
	if (!existsSync(path)) return CONFIG_SCHEMA_VERSION;
	try {
		return detectConfigSchemaVersion(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch {
		return 0;
	}
}

/** Detect the active config location and its on-disk schema version as one value. */
export function getConfigVersion(configPath = getCurrentConfigPath()): ConfigVersion {
	const legacyPath = getLegacyConfigPath();
	const path = existsSync(configPath) || !existsSync(legacyPath) ? configPath : legacyPath;
	return { path, schemaVersion: readSchemaVersion(path) };
}

function formatBackupTimestamp(date: Date): string {
	const part = (value: number) => String(value).padStart(2, "0");
	return (
		part(date.getFullYear() % 100) +
		part(date.getMonth() + 1) +
		part(date.getDate()) +
		"-" +
		part(date.getHours()) +
		part(date.getMinutes()) +
		part(date.getSeconds())
	);
}

function nextBackupPath(configPath: string): string {
	const stem = CONFIG_FILENAME.endsWith(".json") ? CONFIG_FILENAME.slice(0, -5) : CONFIG_FILENAME;
	const timestamp = new Date();
	let backupPath: string;
	do {
		backupPath = join(dirname(configPath), `${stem}.${formatBackupTimestamp(timestamp)}.json.bak`);
		timestamp.setSeconds(timestamp.getSeconds() + 1);
	} while (existsSync(backupPath));
	return backupPath;
}

function archiveConfig(sourcePath: string, configPath: string): string {
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const backupPath = nextBackupPath(configPath);
	renameSync(sourcePath, backupPath);
	return backupPath;
}

function writeConfigAt(configPath: string, config: unknown): void {
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
	renameSync(tmpPath, configPath);
}

function emptyConfig(): NewAPIConfig {
	return { version: CONFIG_SCHEMA_VERSION, providers: {}, settings: {} };
}

function migrateCandidate(candidate: ParsedConfig): NewAPIConfig {
	if (candidate.kind === "v1") return candidate.data;
	if (candidate.kind !== "v0") {
		throw new Error(`cannot migrate future config schema v${candidate.schemaVersion}`);
	}

	const providers: Record<string, ProviderEntry> = {};
	for (const [name, entry] of Object.entries(candidate.data.providers)) {
		providers[name] = {
			baseUrl: entry.baseUrl ?? "",
			modelApiOverrides: entry.modelApiOverrides ?? {},
		};
	}
	return {
		version: CONFIG_SCHEMA_VERSION,
		providers,
		settings: {
			onboardingWarnCountdown: candidate.data.settings?.onboardingWarnCountdown,
		},
	};
}

function v0MigrationGuidance(): string {
	return (
		` Schema v0 modelOverrides are not copied: move model metadata and compatibility overrides into Pi's ` +
		`${join(getAgentDir(), "models.json")}, and move old API choices into modelApiOverrides.`
	);
}

/** Archive an invalid config and replace it with a valid empty canonical config. */
export function resetInvalidConfig(configPath = getCurrentConfigPath(), reason?: unknown): void {
	const detail = reason instanceof Error ? `: ${reason.message}` : reason === undefined ? "" : `: ${String(reason)}`;
	try {
		const backupPath = existsSync(configPath) ? archiveConfig(configPath, configPath) : undefined;
		writeConfigAt(configPath, emptyConfig());
		console.warn(
			`NewAPI: config at ${configPath} is invalid${detail}.` +
				(backupPath ? ` Moved it to ${backupPath}` : "") +
				" and created an empty config.",
		);
	} catch (error) {
		console.warn(
			`NewAPI: could not archive and reset invalid config at ${configPath}: ` +
				`${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}

function archiveLegacyPath(legacyPath: string, configPath: string): void {
	let candidate: ParsedConfig | undefined;
	let parseError: unknown;
	try {
		candidate = parseConfig(legacyPath);
	} catch (error) {
		parseError = error;
	}

	const backupPath = archiveConfig(legacyPath, configPath);
	if (existsSync(configPath)) {
		console.warn(
			`NewAPI: moved legacy config from ${legacyPath} to ${backupPath}; ` +
				`the existing config at ${configPath} remains authoritative.`,
		);
		return;
	}

	if (!candidate) {
		writeConfigAt(configPath, emptyConfig());
		console.warn(
			`NewAPI: legacy config at ${legacyPath} is invalid` +
				`${parseError instanceof Error ? `: ${parseError.message}` : ""}. ` +
				`Moved it to ${backupPath} and created an empty config at ${configPath}.`,
		);
		return;
	}

	if (candidate.schemaVersion > CONFIG_SCHEMA_VERSION) {
		throw new Error(
			`NewAPI: legacy config schema version ${candidate.schemaVersion} was moved to ${backupPath} and is newer ` +
				`than supported version ${CONFIG_SCHEMA_VERSION}. Upgrade the extension before migrating it.`,
		);
	}

	writeConfigAt(configPath, migrateCandidate(candidate));
	console.warn(
		`NewAPI: moved legacy config from ${legacyPath} to ${backupPath} and migrated it to ${configPath}.` +
			(candidate.kind === "v0" ? v0MigrationGuidance() : ""),
	);
}

/** Apply path and schema migrations, then return the effective config version. */
export function migrateConfig(configPath = getCurrentConfigPath()): ConfigVersion {
	const legacyPath = getLegacyConfigPath();
	if (existsSync(legacyPath)) archiveLegacyPath(legacyPath, configPath);
	if (!existsSync(configPath)) return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };

	let candidate: ParsedConfig;
	try {
		candidate = parseConfig(configPath);
	} catch (error) {
		resetInvalidConfig(configPath, error);
		return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
	}

	if (candidate.schemaVersion > CONFIG_SCHEMA_VERSION) {
		throw new Error(
			`NewAPI: config schema version ${candidate.schemaVersion} at ${configPath} is newer than supported ` +
				`version ${CONFIG_SCHEMA_VERSION}. Upgrade the extension before editing this configuration.`,
		);
	}

	if (candidate.schemaVersion < CONFIG_SCHEMA_VERSION) {
		const backupPath = archiveConfig(configPath, configPath);
		writeConfigAt(configPath, migrateCandidate(candidate));
		console.warn(
			`NewAPI: moved schema ${candidate.schemaVersion} config to ${backupPath} and migrated ${configPath} ` +
				`to schema ${CONFIG_SCHEMA_VERSION}.` +
				v0MigrationGuidance(),
		);
	}

	return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
}
