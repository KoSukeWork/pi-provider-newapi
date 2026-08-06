import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig, updateConfig } from "./config.ts";
import {
	buildGeneratedModelsJson,
	countGeneratedModelOverrides,
	getGeneratedModelsPath,
	writeGeneratedModelsJson,
} from "./generated-models.ts";
import { fetchWithTimeout } from "./http.ts";
import { registerNewAPIProvider } from "./provider.ts";
import type { ProviderRuntimeState } from "./provider.ts";
import type { ProviderEntry } from "./types.ts";

function terminalFileLink(path: string, enabled: boolean): string {
	if (!enabled) return path;
	return `\u001b]8;;${pathToFileURL(path).href}\u0007${path}\u001b]8;;\u0007`;
}

export function registerCommands(pi: ExtensionAPI, state: ProviderRuntimeState): void {
	pi.registerCommand("newapi-provider-add", {
		description: "Add a new NewAPI provider (prompts for base URL; login via /login)",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) {
				const input = await ctx.ui.input("Provider name", "my_gateway");
				if (input === undefined) return;
				name = input.trim();
			}

			if (!name) {
				ctx.ui.notify("Provider name cannot be empty.", "error");
				return;
			}
			if (/[\s/\\]/.test(name)) {
				ctx.ui.notify("Provider name must not contain spaces or slashes.", "error");
				return;
			}

			const builtins = getProviders() as unknown as string[];
			if (builtins.includes(name)) {
				ctx.ui.notify(`Cannot add "${name}": name collides with a built-in pi provider.`, "error");
				return;
			}

			const current = readConfig();
			if (current.providers[name]) {
				ctx.ui.notify(`Provider "${name}" already exists. Run /newapi-provider-remove "${name}" first.`, "error");
				return;
			}

			const baseUrlRaw = await ctx.ui.input("Base URL", "https://ai.example.com");
			if (baseUrlRaw === undefined) return;
			const baseUrl = baseUrlRaw.trim().replace(/\/+$/, "");
			if (!baseUrl) {
				ctx.ui.notify("Base URL cannot be empty.", "error");
				return;
			}

			try {
				const response = await fetchWithTimeout(`${baseUrl}/v1/models`, { signal: ctx.signal });
				if (!response.ok && response.status !== 401 && response.status !== 403) {
					ctx.ui.notify(
						`Warning: ${baseUrl} responded ${response.status} ${response.statusText}. Saving anyway.`,
						"warning",
					);
				}
			} catch (err) {
				ctx.ui.notify(
					`Warning: could not reach ${baseUrl} (${err instanceof Error ? err.message : String(err)}). Saving anyway.`,
					"warning",
				);
			}

			const entry: ProviderEntry = { baseUrl, modelApiOverrides: {} };
			await updateConfig((config) => {
				config.providers[name] = entry;
				return true;
			});

			registerNewAPIProvider(pi, name, entry);
			state.registered.add(name);
			ctx.ui.notify(
				`Provider "${name}" added. Run /login ${name} to enter its API key; Pi will then discover its models.`,
				"info",
			);
		},
	});

	pi.registerCommand("newapi-generate-models-json", {
		description: "Generate Pi modelOverrides templates for unknown NewAPI models",
		handler: async (_args, ctx) => {
			const config = readConfig();
			const providerNames = Object.keys(config.providers);
			if (providerNames.length === 0) {
				ctx.ui.notify("No NewAPI providers are configured.", "info");
				return;
			}

			ctx.ui.notify("Reloading available NewAPI models before generating templates...", "info");
			let refreshError: string | undefined;
			try {
				await ctx.modelRegistry.refresh();
			} catch (error) {
				refreshError = error instanceof Error ? error.message : String(error);
			}

			const currentModels = ctx.modelRegistry.getAll();
			const generated = buildGeneratedModelsJson(providerNames, currentModels);
			const generatedPath = getGeneratedModelsPath();
			try {
				writeGeneratedModelsJson(generated, generatedPath);
			} catch (error) {
				ctx.ui.notify(
					`Could not write ${generatedPath}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const modelsPath = join(getAgentDir(), "models.json");
			const generatedLink = terminalFileLink(generatedPath, ctx.mode === "tui");
			const modelsLink = terminalFileLink(modelsPath, ctx.mode === "tui");
			const count = countGeneratedModelOverrides(generated);
			const providersWithoutModels = providerNames.filter(
				(name) => !currentModels.some((model) => model.provider === name),
			);
			const warnings = [
				...(refreshError ? [`Model reload failed: ${refreshError}`] : []),
				...(providersWithoutModels.length > 0
					? [
							`No discovered models were available for: ${providersWithoutModels.join(", ")}. ` +
								"Open /model to refresh discovery, then run this command again.",
						]
					: []),
			];
			const warning = warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((item) => `  ${item}`).join("\n")}` : "";
			ctx.ui.notify(
				`Generated ${count} unknown-model override template${count === 1 ? "" : "s"}:\n${generatedLink}\n\n` +
					`Copy and merge the relevant provider entries from that file into Pi's models.json:\n${modelsLink}\n\n` +
					"Do not replace existing providers or modelOverrides entries when pasting; merge them by provider and model ID." +
					warning,
				warnings.length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("newapi-provider-remove", {
		description: "Remove a configured NewAPI provider (run /logout <name> first)",
		handler: async (args, ctx) => {
			const current = readConfig();
			const providerNames = Object.keys(current.providers);
			if (providerNames.length === 0) {
				ctx.ui.notify("No NewAPI providers are configured.", "info");
				return;
			}

			let name = args.trim();
			if (!name) {
				const selected = await ctx.ui.select("Select provider to remove", providerNames);
				if (selected === undefined) return;
				name = selected;
			}

			if (!current.providers[name]) {
				ctx.ui.notify(`Provider "${name}" not found in config.`, "error");
				return;
			}

			const status = ctx.modelRegistry.getProviderAuthStatus(name);
			const credentialNote = status.configured
				? `A Pi credential is still configured for "${name}". Run /logout ${name} to remove it — this command does not edit auth.json.\n\n`
				: "";
			const confirmed = await ctx.ui.confirm(
				`Remove provider "${name}"?`,
				`${credentialNote}This will unregister "${name}" and delete its config entry.`,
			);
			if (!confirmed) return;

			pi.unregisterProvider(name);
			await updateConfig((config) => {
				if (!config.providers[name]) return false;
				delete config.providers[name];
				return true;
			});
			state.registered.delete(name);
			ctx.ui.notify(
				status.configured
					? `Provider "${name}" removed. Run /logout ${name} to delete its stored credential.`
					: `Provider "${name}" removed.`,
				"info",
			);
		},
	});

	pi.registerCommand("newapi-provider-list", {
		description: "List all configured NewAPI providers and their status",
		handler: async (_args, ctx) => {
			const current = readConfig();
			const names = Object.keys(current.providers);
			if (names.length === 0) {
				ctx.ui.notify("No NewAPI providers configured. Run /newapi-provider-add to add one.", "info");
				return;
			}

			const lines = names.map((name) => {
				const entry = current.providers[name];
				const status = ctx.modelRegistry.getProviderAuthStatus(name);
				const overrideCount = Object.keys(entry.modelApiOverrides ?? {}).length;
				const stateLabel = state.registered.has(name) ? "active" : "inactive";
				return (
					`  ${name}  |  ${entry.baseUrl}  |  ` +
					`auth: ${status.configured ? "✓" : "✗"}  |  ` +
					`API overrides: ${overrideCount}  |  ${stateLabel}`
				);
			});
			ctx.ui.notify(`NewAPI providers (${names.length}):\n${lines.join("\n")}`, "info");
		},
	});
}
