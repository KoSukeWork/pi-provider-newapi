import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig, updateConfig } from "./config.ts";
import { fetchWithTimeout } from "./http.ts";
import { registerNewAPIProvider } from "./provider.ts";
import type { ProviderRuntimeState } from "./provider.ts";
import type { ProviderEntry } from "./types.ts";

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

			const entry: ProviderEntry = { baseUrl, modelOverrides: {} };
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
				const overrideCount = Object.keys(entry.modelOverrides ?? {}).length;
				const stateLabel = state.registered.has(name) ? "active" : "inactive";
				return (
					`  ${name}  |  ${entry.baseUrl}  |  ` +
					`auth: ${status.configured ? "✓" : "✗"}  |  ` +
					`overrides: ${overrideCount}  |  ${stateLabel}`
				);
			});
			ctx.ui.notify(`NewAPI providers (${names.length}):\n${lines.join("\n")}`, "info");
		},
	});
}
