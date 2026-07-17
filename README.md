# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

A [pi](https://github.com/earendil-works/pi) coding-agent provider extension for self-hosted [NewAPI](https://github.com/QuantumNous/new-api) gateways. It requires Pi and `@earendil-works/pi-ai` **v0.80.8 or later**.

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

The provider appears in `/login` even before models are discovered. After login, Pi stores the API key, refreshes the provider catalog, and the models are available immediately:

```text
pi> /model my_gateway/claude-sonnet-4-5
```

Do not put an API key in the extension configuration. Pi owns credentials and stores them using its configured credential store (normally `<agentDir>/auth.json`).

## Commands

| Command | Description |
|---|---|
| `/newapi-provider-add [name]` | Add a gateway configuration and register it immediately. Then run `/login <name>`. |
| `/newapi-provider-remove [name]` | Unregister and remove a gateway configuration. Run `/logout <name>` first to remove its Pi-owned credential. |
| `/newapi-provider-list` | Show configured providers, credential status, overrides, and active state. |

### Removal workflow

Pi v0.80.8 does not expose credential deletion to extensions. To completely remove a provider, first run:

```text
/logout my_gateway
/newapi-provider-remove my_gateway
```

The remove command never edits `auth.json` directly, which keeps the extension compatible with custom Pi credential stores.

## Model refresh and offline catalogs

NewAPI discovery is implemented as Pi's dynamic provider refresh callback:

- Opening `/model` refreshes configured NewAPI catalogs in the background.
- `pi update --models` forces a catalog refresh.
- Successful catalogs are stored per provider in Pi's `<agentDir>/models-store.json`.
- In offline mode, Pi restores the last successful catalog without making NewAPI requests.
- A failed refresh retains the last good cached catalog. The optional `/api/ratio_config` endpoint is best-effort; `/v1/models` is required for a fresh catalog.

No API key is included in the catalog cache.

## Configuration

Gateway configuration is stored at `<agentDir>/extensions/provider-newapi.json`:

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

- **`providers`** — one entry per NewAPI instance. The map key is the Pi provider ID.
- **`modelOverrides`** — metadata for unknown models or patches over known built-in metadata. For a known (enriched) model, only the fields you specify are overridden; the rest keep their built-in values, so a partial entry like `{ "reasoning": true }` is valid. Unknown models receive a generated template after a successful discovery; edit it as necessary.
- **`settings.onboardingWarnCountdown`** — internal state that limits the no-provider reminder to three startups.

`<agentDir>` normally resolves to:

| OS | Path |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

If the configuration is malformed, it is backed up to `provider-newapi.json.bak` and reset to a valid empty configuration.

## Multiple providers

Models from each gateway remain separate in Pi's model selector:

```text
/model internal/claude-sonnet-4-5
/model personal/gpt-4o
```

Each provider has independent configuration, Pi credential, and cached catalog.
