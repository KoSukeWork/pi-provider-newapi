# pi-provider-newapi

[![pi package catalog](https://img.shields.io/badge/pi-package%20catalog-5B5BD6.svg)](https://pi.dev/packages/pi-provider-newapi)
[![npm](https://img.shields.io/npm/v/pi-provider-newapi.svg)](https://www.npmjs.com/package/pi-provider-newapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![社区 | Linux.do](https://img.shields.io/badge/社区-Linux.do-blue.svg)](https://linux.do/)

A [pi](https://github.com/earendil-works/pi) coding-agent provider extension for self-hosted [NewAPI](https://github.com/QuantumNous/new-api) gateways. It requires Pi Coding Agent **v0.84.0 or later**.

Multiple named providers are supported, each backed by an independent NewAPI gateway. Discovered models are enriched from Pi's built-in metadata and routed automatically:

| Model API | Endpoint |
|---|---|
| `openai-completions`, `openai-responses` | `{baseUrl}/v1` |
| `anthropic-messages` | `{baseUrl}` |

**[中文文档](https://github.com/ttimasdf/pi-provider-newapi/blob/main/README_cn.md)**

## Installation

```bash
pi install npm:pi-provider-newapi
```

Or install from git:

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

## Quick start

Add a gateway configuration:

```text
pi> /newapi-provider-add my_gateway
Provider name: my_gateway
Base URL: https://ai.example.com
Provider "my_gateway" was added. Run /login my_gateway to enter its API key; Pi will then discover its models.
```

Then authenticate with Pi's standard credential flow:

```text
pi> /login my_gateway
```

The provider appears in `/login` even before models are discovered. After login, Pi stores the API key, refreshes the provider model list, and the models are available immediately:

```text
pi> /model my_gateway/claude-sonnet-4-5
```

Do not put an API key in the extension configuration. Pi owns credentials and stores them using its configured credential store (normally `<agentDir>/auth.json`).

## Commands

| Command | Description |
|---|---|
| `/newapi-provider-add [name]` | Add a gateway configuration and register it immediately. Then run `/login <name>`. |
| `/newapi-provider-remove [name]` | Unregister and remove a gateway configuration. Run `/logout <name>` first to remove its Pi-owned credential. |
| `/newapi-provider-list` | Show configured providers, credential status, API override count, and active state. |
| `/newapi-generate-models-json` | Generate Pi `modelOverrides` templates for currently discovered unknown models. |

### Removal workflow

Pi does not expose credential deletion through the extension API. To completely remove a provider, first run:

```text
/logout my_gateway
/newapi-provider-remove my_gateway
```

The remove command never edits `auth.json` directly, which keeps the extension compatible with custom Pi credential stores.

## Model list refresh and offline model lists

NewAPI discovery is implemented as Pi's dynamic provider refresh callback:

- Opening `/model` refreshes configured NewAPI model lists in the background. After changing `modelApiOverrides` or Pi's `models.json`, open `/model` to apply the updated configuration.
- `pi update --models` forces an immediate model-list refresh; use it instead when you need the updated model configuration without waiting for the background refresh.
- Successful model lists are stored per provider in Pi's `<agentDir>/models-store.json`.
- In offline mode, Pi restores the last successful model list without making NewAPI requests.
- A failed refresh retains the last good cached model list. The optional `/api/ratio_config` endpoint is best-effort; `/v1/models` is required for a fresh model list.

No API key is included in the model-list cache.

## Configuration

Gateway configuration is stored at `<agentDir>/extension-settings/provider-newapi.json`:

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

- **`version`** — extension configuration schema version. The current version is `1`; pre-versioned files are detected as schema `0` and upgraded automatically. Files from newer schemas are preserved and rejected until the extension is upgraded.
- **`providers`** — one entry per NewAPI instance. The map key is the Pi provider ID.
- **`modelApiOverrides`** — maps JavaScript regular-expression sources to a Pi API. Rules are checked in JSON order and the first match wins. An explicit match overrides NewAPI's advertised endpoint metadata. Supported values are `anthropic-messages`, `openai-completions`, and `openai-responses`; invalid patterns or values are ignored with a warning.
- **`settings.onboardingWarnCountdown`** — internal state that limits the no-provider reminder to three startups.

Model metadata and compatibility settings are owned by Pi. Put them in `<agentDir>/models.json`, using the same provider ID:

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

Pi applies these exact-ID overrides after extension model discovery. Provider-level `compat` applies to every model on the gateway; place `compat` inside an exact model override when only one model needs it.

Run `/newapi-generate-models-json` to reload the currently available model lists and write unknown-model templates to `<agentDir>/models-generated.json`. The command prints clickable paths for the generated file and Pi's `<agentDir>/models.json`. Manually copy and merge the relevant provider/model entries; the extension never modifies `models.json`. If a configured provider has no available catalog yet, open `/model` to run discovery and then rerun the generator.

### Migrating from v0.4

The extension no longer reads its former `modelOverrides` or `settings.sendSessionAffinityHeaders` fields. Move each old `api` choice into `modelApiOverrides` (anchor an exact ID as `^model-id$` when appropriate), and move all metadata and `compat` fields into Pi's `models.json` as shown above.

`<agentDir>` normally resolves to:

| OS | Path |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

On first use, an existing `<agentDir>/extensions/provider-newapi.json` is moved automatically to the new `extension-settings` location. If the configuration is malformed, it is backed up to `provider-newapi.json.bak` and reset to a valid empty configuration.

## Multiple providers

Models from each gateway remain separate in Pi's model selector:

```text
/model internal/claude-sonnet-4-5
/model personal/gpt-4o
```

Each provider has independent configuration, Pi credential, and cached model list.
