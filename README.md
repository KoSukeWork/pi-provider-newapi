# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

[pi](https://github.com/earendil-works/pi) coding agent provider extension for self-hosted [NewAPI](https://github.com/QuantumNous/new-api) AI gateways.

Supports **multiple named providers**, each backed by a separate NewAPI instance. On startup, each provider is discovered, enriched from pi's built-in model metadata, and registered. API routing is automatic:

| Recommended API | Endpoint |
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

The extension is auto-discovered via the `pi.extensions` field in `package.json`.

## Quick Start

Run `/newapi-provider-add` inside a pi session. The command will prompt you for:

1. **Provider name** — an identifier you choose (e.g. `my_gateway`). Must not be an existing built-in pi provider name.
2. **Base URL** — root URL of your NewAPI instance (e.g. `https://ai.example.com`).
3. **API Key** — your NewAPI key.

The command verifies connectivity before saving anything. On success it registers the provider immediately — no `/reload` needed.

```
pi> /newapi-provider-add my_gateway
Provider name: my_gateway
Base URL: https://ai.example.com
API Key: sk-your-api-key
✓ Provider "my_gateway" added with 42 models.
```

You can add as many providers as you like. Each is registered under its own name:

```
pi> /model my_gateway/claude-sonnet-4-5
```

## Commands

| Command | Description |
|---|---|
| `/newapi-provider-add [name]` | Add a new provider (interactive prompts) |
| `/newapi-provider-remove [name]` | Remove a provider — unregisters, deletes config + credentials |
| `/newapi-provider-list` | Show all configured providers with base URL, auth status, and model override count |

## Configuration

### Config file

`<agentDir>/extensions/provider-newapi.json`

```json
{
  "providers": {
    "my_gateway": {
      "baseUrl": "https://ai.example.com",
      "modelOverrides": {
        "unknown-model-id": {
          "api": "anthropic-messages",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      }
    },
    "second_gateway": {
      "baseUrl": "https://gw2.example.com",
      "modelOverrides": {}
    }
  },
  "settings": {
    "onboardingWarnCountdown": 3
  }
}
```

- **`providers`** — one entry per NewAPI instance. The key is the provider name pi registers.
- **`modelOverrides`** — manually supply or override metadata for models not in pi's built-in catalog. The extension auto-populates a template entry for every unknown model it discovers; edit the values as needed. For known models, an entry is retained and applied on top of the enriched built-in metadata.
- **`settings.onboardingWarnCountdown`** — internal counter; decremented each startup while no providers are configured.

### Credentials

API keys are stored in pi's standard `<agentDir>/auth.json`, keyed by provider name. `/newapi-provider-add` writes them there automatically. You can also use pi's `/login` command to update an existing provider's key after initial setup.

`<agentDir>` defaults to:

| OS | Path |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

### Invalid config

If `provider-newapi.json` cannot be parsed or has an unexpected shape, the extension backs it up to `provider-newapi.json.bak`, starts with an empty config, and prints a warning. Use `/newapi-provider-add` to reconfigure.

## Multiple providers example

```json
{
  "providers": {
    "internal": {
      "baseUrl": "https://ai.corp.internal",
      "modelOverrides": {}
    },
    "personal": {
      "baseUrl": "https://my-newapi.fly.dev",
      "modelOverrides": {}
    }
  },
  "settings": {}
}
```

Models from both providers appear in `/model` under their respective provider namespaces (`internal/<id>`, `personal/<id>`).
