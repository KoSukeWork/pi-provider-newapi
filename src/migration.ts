/** Detects and migrates extension configuration paths and schema versions. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION } from "./constants.ts";

export interface ConfigVersion {
	path: string;
	schemaVersion: number;
}

const emittedMigrationWarnings = new Set<string>();

function warnMigrationOnce(key: string, message: string): void {
	if (emittedMigrationWarnings.has(key)) return;
	emittedMigrationWarnings.add(key);
	console.warn(message);
}

function getCurrentConfigPath(): string {
	return join(getAgentDir(), "extension-settings", CONFIG_FILENAME);
}

export function getLegacyConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

function readSchemaVersion(path: string): number {
	if (!existsSync(path)) return CONFIG_SCHEMA_VERSION;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return 0;
		const version = (parsed as Record<string, unknown>).version;
		return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
	} catch {
		return 0;
	}
}

/** Detect the active config location and its on-disk schema version as one value. */
export function getConfigVersion(configPath = getCurrentConfigPath()): ConfigVersion {
	const legacyPath = getLegacyConfigPath();
	// The canonical location wins when both files exist; otherwise detect the legacy source.
	const path = existsSync(configPath) || !existsSync(legacyPath) ? configPath : legacyPath;
	return { path, schemaVersion: readSchemaVersion(path) };
}

/** Apply path and schema migrations, then return the effective config version. */
export function migrateConfig(configPath = getCurrentConfigPath()): ConfigVersion {
	let version = getConfigVersion(configPath);
	const legacyPath = getLegacyConfigPath();
	// Never overwrite a canonical config with a stale legacy copy.
	if (version.path !== legacyPath) {
		if (existsSync(configPath) && existsSync(legacyPath)) {
			warnMigrationOnce(
				"legacy-config-shadowed",
				`NewAPI: ignoring legacy config at ${legacyPath} because ${configPath} already exists.`,
			);
		}
	} else {
		// Move the legacy file first so every later schema write targets the canonical directory.
		try {
			const dir = dirname(configPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			renameSync(legacyPath, configPath);
			console.warn(`NewAPI: moved config from ${legacyPath} to ${configPath}.`);
			version = { ...version, path: configPath };
		} catch (error) {
			// Another process may have completed the migration after our existence checks.
			if (existsSync(configPath)) {
				version = { path: configPath, schemaVersion: readSchemaVersion(configPath) };
			} else if (existsSync(legacyPath)) {
				warnMigrationOnce(
					"legacy-config-move-failed",
					`NewAPI: could not move config from ${legacyPath} to ${configPath}: ` +
						`${error instanceof Error ? error.message : String(error)}. Reading the legacy file for now.`,
				);
			} else {
				version = { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
			}
		}
	}

	// Pre-versioned files are schema 0; stamp the current envelope without altering their payload.
	if (version.schemaVersion < CONFIG_SCHEMA_VERSION && existsSync(version.path)) {
		try {
			const parsed = JSON.parse(readFileSync(version.path, "utf-8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const upgraded = { ...(parsed as Record<string, unknown>), version: CONFIG_SCHEMA_VERSION };
				const tmpPath = `${version.path}.tmp.${process.pid}.${Date.now()}`;
				writeFileSync(tmpPath, JSON.stringify(upgraded, null, 2), "utf-8");
				renameSync(tmpPath, version.path);
				console.warn(
					`NewAPI: upgraded config schema from version ${version.schemaVersion} to ${CONFIG_SCHEMA_VERSION} at ${version.path}.`,
				);
				version = { ...version, schemaVersion: CONFIG_SCHEMA_VERSION };
			}
		} catch (error) {
			warnMigrationOnce(
				`schema-upgrade-failed:${version.path}`,
				`NewAPI: could not upgrade config schema at ${version.path}: ` +
					`${error instanceof Error ? error.message : String(error)}.`,
			);
		}
	}

	// Refuse to downgrade an unknown future schema, which could destroy fields this version cannot parse.
	if (version.schemaVersion > CONFIG_SCHEMA_VERSION) {
		throw new Error(
			`NewAPI: config schema version ${version.schemaVersion} at ${version.path} is newer than supported ` +
				`version ${CONFIG_SCHEMA_VERSION}. Upgrade the extension before editing this configuration.`,
		);
	}
	return version;
}

export function warnLegacyProviderConfig(name: string, entry: Record<string, unknown>): void {
	if (typeof entry.modelOverrides !== "object" || entry.modelOverrides === null) return;
	warnMigrationOnce(
		`legacy-model-overrides:${name}`,
		`NewAPI [${name}]: modelOverrides is no longer supported. Move API routing to modelApiOverrides ` +
			`and metadata/compat overrides to Pi's models.json.`,
	);
}
