import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { getConfigPath, readConfig, updateConfig } from "../src/config.ts";

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

test("readConfig: keeps only supported API overrides and current settings", () =>
	withAgentDir(() => {
		const path = getConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
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
			providers: {
				gw: { baseUrl: "https://gw.example.com", modelApiOverrides: {} },
			},
			settings: {},
		});
	});
});
