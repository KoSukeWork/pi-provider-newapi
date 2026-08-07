/** Verifies config normalization, atomic updates, path migration, and schema version handling. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { deserializeConfig, getConfigPath, readConfig, updateConfig } from "../src/config.ts";
import { CONFIG_SCHEMA_VERSION } from "../src/constants.ts";
import { getConfigVersion, getLegacyConfigPath } from "../src/migration.ts";

function getBackupPaths(agentDir: string): string[] {
	const configDir = join(agentDir, "extension-settings");
	if (!existsSync(configDir)) return [];
	return readdirSync(configDir)
		.filter((name) => /^provider-newapi\.\d{6}-\d{6}\.json\.bak$/.test(name))
		.map((name) => join(configDir, name));
}

function withAgentDir(run: (agentDir: string) => void | Promise<void>): Promise<void> | void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "newapi-config-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const finish = () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	};
	try {
		const result = run(agentDir);
		if (result instanceof Promise) return result.finally(finish);
		finish();
	} catch (error) {
		finish();
		throw error;
	}
}

test("config paths separate settings from extension sources", () =>
	withAgentDir((agentDir) => {
		assert.equal(getConfigPath(), join(agentDir, "extension-settings", "provider-newapi.json"));
		assert.equal(getLegacyConfigPath(), join(agentDir, "extensions", "provider-newapi.json"));
		assert.deepEqual(getConfigVersion(), {
			path: getConfigPath(),
			schemaVersion: CONFIG_SCHEMA_VERSION,
		});
	}));

test("readConfig: archives and migrates the legacy extensions-directory config", () =>
	withAgentDir((agentDir) => {
		const legacyPath = getLegacyConfigPath();
		mkdirSync(dirname(legacyPath), { recursive: true });
		const raw = JSON.stringify({
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: {},
		});
		writeFileSync(legacyPath, raw);

		assert.deepEqual(getConfigVersion(), { path: legacyPath, schemaVersion: 0 });
		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: {},
		});
		assert.equal(existsSync(legacyPath), false);
		assert.equal(existsSync(getConfigPath()), true);
		assert.deepEqual(getConfigVersion(), {
			path: getConfigPath(),
			schemaVersion: CONFIG_SCHEMA_VERSION,
		});
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), raw);
		assert.equal(JSON.parse(readFileSync(getConfigPath(), "utf-8")).version, CONFIG_SCHEMA_VERSION);
	}));

test("readConfig: archives a shadowed legacy-path file", () =>
	withAgentDir((agentDir) => {
		const path = getConfigPath();
		const legacyPath = getLegacyConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ version: CONFIG_SCHEMA_VERSION, providers: {}, settings: {} }),
		);
		const legacyRaw = JSON.stringify({ providers: { old: { baseUrl: "https://old.example.com" } } });
		writeFileSync(legacyPath, legacyRaw);

		assert.deepEqual(readConfig().providers, {});
		assert.equal(existsSync(legacyPath), false);
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), legacyRaw);
	}));

test("readConfig: archives malformed JSON and creates an empty config", () =>
	withAgentDir((agentDir) => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		const malformed = '{"providers":';
		writeFileSync(path, malformed);

		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {},
			settings: {},
		});
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), malformed);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {},
			settings: {},
		});
	}));

test("readConfig: archives JSON that does not match the NewAPIConfig schema", () =>
	withAgentDir((agentDir) => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		const raw = JSON.stringify({
			version: CONFIG_SCHEMA_VERSION,
			providers: { gw: { baseUrl: 42, modelApiOverrides: {} } },
			settings: {},
		});
		writeFileSync(path, raw);

		assert.throws(() => deserializeConfig(raw), /config\.providers\.gw\.baseUrl must be string/);
		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {},
			settings: {},
		});
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), raw);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {},
			settings: {},
		});
	}));

test("readConfig: uses the version field and reports invalid schema 1 fields", () =>
	withAgentDir((agentDir) => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		const raw = JSON.stringify({
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: { baseUrl: "https://gw.example.com" },
			},
			settings: {
				onboardingWarnCountdown: 0,
				sendSessionAffinityHeaders: true,
			},
		});
		writeFileSync(path, raw);

		assert.deepEqual(getConfigVersion(), { path, schemaVersion: CONFIG_SCHEMA_VERSION });
		assert.throws(
			() => deserializeConfig(raw),
			(error: unknown) => {
				assert.match(String(error), /config\.providers\.gw\.modelApiOverrides is required/);
				assert.match(String(error), /config\.settings\.sendSessionAffinityHeaders is not allowed/);
				return true;
			},
		);
		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {},
			settings: {},
		});
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), raw);
	}));

test("readConfig: rejects and preserves newer config schemas", () =>
	withAgentDir(() => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		const raw = JSON.stringify({ version: CONFIG_SCHEMA_VERSION + 1, providers: {}, settings: {} });
		writeFileSync(path, raw);

		assert.throws(() => readConfig(), /newer than supported/);
		assert.equal(readFileSync(path, "utf-8"), raw);
	}));

test("readConfig: migrates schema 0 modelOverrides and preserves them in a backup", () =>
	withAgentDir((agentDir) => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		const raw = JSON.stringify({
			providers: {
				gw: {
					baseUrl: "https://gw.example.com",
					modelOverrides: { old: { api: "anthropic-messages" } },
					modelApiOverrides: {
						"^claude-": "anthropic-messages",
					},
				},
			},
			settings: { onboardingWarnCountdown: 2, sendSessionAffinityHeaders: true },
		});
		writeFileSync(path, raw);

		assert.deepEqual(getConfigVersion(), { path, schemaVersion: 0 });
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
		let config: ReturnType<typeof readConfig>;
		try {
			config = readConfig();
		} finally {
			console.warn = originalWarn;
		}
		assert.deepEqual(config, {
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: {
					baseUrl: "https://gw.example.com",
					modelApiOverrides: { "^claude-": "anthropic-messages" },
				},
			},
			settings: { onboardingWarnCountdown: 2 },
		});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /schema 0 config.*schema 1.*models\.json/);
		assert.doesNotMatch(warnings[0], /legacy modelOverrides found/);
		const backups = getBackupPaths(agentDir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(backups[0], "utf-8"), raw);
		const migrated = JSON.parse(readFileSync(path, "utf-8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		assert.equal(Object.hasOwn(migrated.providers.gw, "modelOverrides"), false);
	}));

test("updateConfig: rewrites legacy fields out of extension config", async () => {
	await withAgentDir(async () => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					gw: {
						baseUrl: "https://gw.example.com",
						modelOverrides: { old: { reasoning: true } },
						modelApiOverrides: {},
					},
				},
				settings: { sendSessionAffinityHeaders: true },
			}),
		);

		await updateConfig(() => true);
		const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		assert.deepEqual(written, {
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: {},
		});
	});
});
