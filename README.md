# pi-provider-newapi

[![CI](https://github.com/ttimasdf/pi-provider-newapi/actions/workflows/ci.yml/badge.svg)](https://github.com/ttimasdf/pi-provider-newapi/actions/workflows/ci.yml)
[![pi package catalog](https://img.shields.io/badge/pi-package%20catalog-5B5BD6.svg)](https://pi.dev/packages/pi-provider-newapi)
[![npm](https://img.shields.io/npm/v/pi-provider-newapi.svg)](https://www.npmjs.com/package/pi-provider-newapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Community | Linux.do](https://img.shields.io/badge/community-Linux.do-blue.svg)](https://linux.do/)

Connect [pi](https://github.com/earendil-works/pi) to one or more self-hosted [NewAPI](https://github.com/QuantumNous/new-api) gateways. This extension requires Pi Coding Agent **v0.84.0 or later**.

Each gateway becomes a separate, named provider in pi. The extension:

- discovers available models dynamically from NewAPI;
- enriches known models with pi's built-in capability and compatibility metadata;
- selects a compatible API from the gateway's advertised endpoints, with optional regex overrides;
- calculates model costs from NewAPI's ratio configuration when it is available; and
- keeps the last successful model catalog available for offline use or temporary gateway failures.

Pi remains responsible for credentials. The extension never copies API keys into its configuration, model definitions, logs, or cached catalogs.

**[中文文档](https://github.com/ttimasdf/pi-provider-newapi/blob/main/README_cn.md)**

## Installation

Install from npm:

```bash
pi install npm:pi-provider-newapi
```

Or install directly from GitHub:

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

## Quick start

Add a gateway using its root URL (without `/v1`):

```text
pi> /newapi-provider-add my_gateway
Base URL: https://ai.example.com
Provider "my_gateway" added. Run /login my_gateway to enter its API key; Pi will then discover its models.
```

The setup command performs a best-effort reachability check. A warning does not prevent the provider from being saved, since authenticated gateways often reject an anonymous probe.

Next, enter the API key through pi's standard login flow:

```text
pi> /login my_gateway
```

The provider is available in `/login` before its first model has been discovered. Once authenticated, open `/model` and choose a model such as `my_gateway/claude-sonnet-4-5`.

Pi stores the credential through its configured credential store, normally `<agentDir>/auth.json`. Do not add the key to `provider-newapi.json`.

## Commands

| Command | Description |
|---|---|
| `/newapi-provider-add [name]` | Add and immediately register a NewAPI gateway, then prompt for its root URL. |
| `/newapi-provider-remove [name]` | Unregister the provider and remove its extension configuration. Run `/logout <name>` first. |
| `/newapi-provider-list` | Show each configured provider's URL, authentication status, API override count, and active state. |
| `/newapi-generate-models-json` | Generate editable pi `modelOverrides` templates for discovered models that pi does not already know. |

### Removing a provider

Pi does not expose credential deletion through the extension API. To remove both the credential and the provider configuration, run these commands in order:

```text
/logout my_gateway
/newapi-provider-remove my_gateway
```

The extension never edits `auth.json` directly, so this flow also works with custom pi credential stores.

## Model discovery and caching

Pi controls when dynamic provider catalogs are refreshed:

- Opening `/model` starts a background refresh. Use this after changing `modelApiOverrides` or pi's `models.json`.
- `pi update --models` forces an immediate refresh when you do not want to wait for the background update.
- After a successful refresh, pi stores the provider catalog in `<agentDir>/models-store.json`.
- When network access is disabled, the extension restores the last successful catalog without contacting NewAPI.
- If a refresh fails, the last good catalog remains available. `/api/ratio_config` is optional, but `/v1/models` must succeed to produce a fresh catalog.
- Requests allow 15 seconds for `/v1/models`, 10 seconds for optional ratio metadata, and 5 seconds for the add-provider reachability check. Pi's global HTTP dispatcher still provides proxy routing and idle-timeout handling underneath these local limits.

Catalog updates use pi's generation-checked publishing API, so an older, slower refresh cannot overwrite newer model data. API keys are never included in the catalog store.

## Configuration

The add and remove commands manage `<agentDir>/extension-settings/provider-newapi.json`. Edit this file directly only when you need API routing overrides:

```json
{
  "version": 1,
  "providers": {
    "my_gateway": {
      "baseUrl": "https://ai.example.com",
      "modelApiOverrides": {
        "^claude-": "anthropic-messages",
        "^gpt-": "openai-completions"
      }
    },
    "second_gateway": {
      "baseUrl": "https://gw2.example.com",
      "modelApiOverrides": {}
    }
  },
  "settings": {
    "onboardingWarnCountdown": 3
  }
}
```

- **`version`** is the sole configuration schema discriminator. A missing value or `0` selects schema `0`; `1` selects the current schema. Schema validation never changes that selection. Invalid fields are reported by their full paths, while files declaring a newer schema are preserved and rejected until the extension is upgraded.
- **`providers`** contains one entry per NewAPI gateway. Each key becomes the provider ID shown by pi.
- **`baseUrl`** is the gateway root URL, without `/v1`. Trailing slashes are removed automatically.
- **`modelApiOverrides`** maps JavaScript regular expressions to pi APIs. Rules are checked in JSON order, and the first match wins. Supported values are `anthropic-messages`, `openai-completions`, and `openai-responses`. Invalid regular expressions are ignored with a warning; unsupported API values fail schema validation and trigger the timestamped config backup described below.
- **`settings.onboardingWarnCountdown`** is internal state that limits the no-provider reminder to three startups.

### API routing

By default, the extension combines pi's metadata with each model's `supported_endpoint_types` from NewAPI. A matching `modelApiOverrides` rule takes precedence over both.

| Model API | Base URL passed to pi |
|---|---|
| `openai-completions`, `openai-responses` | `{baseUrl}/v1` |
| `anthropic-messages` | `{baseUrl}` |

### Model metadata and compatibility

Pi owns model metadata and compatibility overrides. Put them in `<agentDir>/models.json` under the same provider ID:

```json
{
  "providers": {
    "my_gateway": {
      "compat": {
        "sendSessionAffinityHeaders": true
      },
      "modelOverrides": {
        "unknown-model-id": {
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32768
        }
      }
    }
  }
}
```

Pi applies exact model-ID overrides after discovery. Provider-level `compat` affects every model on the gateway; place `compat` inside a model override when it should apply to only one model.

For models that are not in pi's built-in catalog, run:

```text
/newapi-generate-models-json
```

The command refreshes the available catalogs and writes templates to `<agentDir>/models-generated.json`. It does not modify pi's user-owned `models.json`: copy the relevant provider and model entries into that file and merge them with anything already there. If a provider has no available catalog yet, open `/model` first and then rerun the generator.

### Migrating from v0.4

The extension no longer reads its former `modelOverrides` or `settings.sendSessionAffinityHeaders` fields. Move old `api` choices to `modelApiOverrides`—use a pattern such as `^model-id$` for an exact match—and move model metadata and `compat` settings to pi's `models.json` as shown above.

The default `<agentDir>` is:

| OS | Path |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

On first use, an existing `<agentDir>/extensions/provider-newapi.json` is moved out of the legacy directory and archived under `extension-settings` as `provider-newapi.YYMMDD-HHMMSS.json.bak`; supported settings are migrated into a new canonical config. The same timestamped backup is created before migrating schema `0` files. Schema `0` includes the former `modelOverrides` field: move its metadata and compatibility values from the backup into pi's `models.json`, and move old API choices into `modelApiOverrides`. A file declaring version `1` is always validated as schema `1`; v0-only fields in it are validation errors rather than a reason to reclassify it.

If JSON parsing or top-level config validation fails, the invalid file is moved to the same timestamped backup format and replaced with a valid empty configuration.

## Multiple gateways

Provider catalogs, credentials, and cached model lists stay separate. For example, the model picker can contain both:

```text
internal/claude-sonnet-4-5
personal/gpt-4o
```

## Development

There is no build step: pi loads the root `index.ts` entry directly. The implementation lives in focused modules under `src/`, with tests under `test/`.

```bash
pnpm install
pnpm run typecheck
pnpm test
```

The same typecheck and test suites run in GitHub Actions for pushes and pull requests.
