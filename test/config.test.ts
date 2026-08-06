/** Verifies config normalization, atomic updates, path migration, and schema version handling. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { getConfigPath, readConfig, updateConfig } from "../src/config.ts";
import { CONFIG_SCHEMA_VERSION } from "../src/constants.ts";
import { getConfigVersion, getLegacyConfigPath } from "../src/migration.ts";

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

test("readConfig: moves and reads the legacy extensions-directory config", () =>
	withAgentDir(() => {
		const legacyPath = getLegacyConfigPath();
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(
			legacyPath,
			JSON.stringify({
				providers: {
					gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
				},
				settings: {},
			}),
		);

		assert.deepEqual(getConfigVersion(), { path: legacyPath, schemaVersion: 0 });
		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: { onboardingWarnCountdown: undefined },
		});
		assert.equal(existsSync(legacyPath), false);
		assert.equal(existsSync(getConfigPath()), true);
		assert.deepEqual(getConfigVersion(), {
			path: getConfigPath(),
			schemaVersion: CONFIG_SCHEMA_VERSION,
		});
		assert.equal(JSON.parse(readFileSync(getConfigPath(), "utf-8")).version, CONFIG_SCHEMA_VERSION);
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

test("readConfig: keeps only supported API overrides and current settings", () =>
	withAgentDir(() => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: CONFIG_SCHEMA_VERSION,
				providers: {
					gw: {
						baseUrl: "https://gw.example.com",
						modelOverrides: { old: { api: "anthropic-messages" } },
						modelApiOverrides: {
							"^claude-": "anthropic-messages",
							"^bad-": "unsupported-api",
						},
					},
				},
				settings: { onboardingWarnCountdown: 2, sendSessionAffinityHeaders: true },
			}),
		);

		assert.deepEqual(readConfig(), {
			version: CONFIG_SCHEMA_VERSION,
			providers: {
				gw: {
					baseUrl: "https://gw.example.com",
					modelApiOverrides: { "^claude-": "anthropic-messages" },
				},
			},
			settings: { onboardingWarnCountdown: 2 },
		});
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
