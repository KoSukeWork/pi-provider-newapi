# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

[pi](https://github.com/earendil-works/pi) coding agent provider extension for self-hosted [NewAPI](https://github.com/QuantumNous/new-api) AI gateways.

Registers a single `newapi` provider with dynamic model discovery, automatic cost calculation, and backend routing based on each model's enriched API metadata:

| Recommended API | Endpoint |
|---|---|
| `openai-completions`, `openai-responses` | `{baseUrl}/v1` |
| `anthropic-messages` | `{baseUrl}` |

**[中文文档](https://github.com/ttimasdf/pi-provider-newapi/blob/main/README_cn.md)**

## Installation

This is a [pi](https://github.com/earendil-works/pi) coding agent provider extension. It has no runtime dependencies — only peer dependencies on pi itself.

```bash
pi install npm:pi-provider-newapi
```

Or install from git:

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

The extension is auto-discovered via the `pi.extensions` field in `package.json` — no extra configuration is needed after install.

## Quick Start

### Option A: Environment variables (fast path)

```bash
export NEWAPI_BASE_URL=https://ai.your-gateway.com
export NEWAPI_API_KEY=sk-your-api-key
```

The provider registers automatically on startup with discovered models.

### Option B: Interactive `/login` (persist key)

```bash
export NEWAPI_BASE_URL=https://ai.your-gateway.com
```

```
pi> /login
```

Run `/login` in the pi session. pi will interactively prompt for the provider, and for the API key (`sk-your-api-key`). The key is saved to `<agentDir>/auth.json` by pi's built-in credential store. On next load, the extension reads it automatically.

## Configuration

Base URL and model metadata are stored in `<agentDir>/extensions/provider-newapi.json`. The API key is managed separately by pi's built-in `<agentDir>/auth.json` (set via `/login` or `NEWAPI_API_KEY` env var).

`<agentDir>` defaults to:

| OS | Path |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

```json
{
  "baseUrl": "https://ai.your-gateway.com",
  "modelInfo": {
    "unknown-model-id": {
      "api": "anthropic-messages",
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  }
}
```

On load, if `NEWAPI_BASE_URL` differs from stored, the base URL is updated. If `NEWAPI_BASE_URL` is not set, a warning is printed.

`modelInfo` entries are auto-generated for models not found in the built-in model database. Edit them to adjust `api`, `reasoning`, `input` types, `contextWindow`, or `maxTokens`. Optionally add `thinkingLevelMap` (e.g. `{ "xhigh": "max" }`). When a previously unknown model later becomes known, the config entry is removed and upstream values take precedence, with a warning showing any differences between the config and upstream values.

## How It Works

1. **Config reconciliation** — reads stored key and base URL; syncs with `NEWAPI_BASE_URL` env var
2. **Ratio config fetch** — fetches `GET /api/ratio_config` (no auth required) for NewAPI's `model_ratio`, `completion_ratio`, `cache_ratio`, and `create_cache_ratio` maps. This step is best-effort — if it fails, costs simply report as `0`
3. **Model discovery** — fetches `GET /v1/models` from the gateway (requires API key)
4. **Ratio matching** — matches each model ID against ratio config keys using a three-step fallback: exact match → case-insensitive match → prefix match. This handles NewAPI's inconsistent naming (e.g. version tags, mixed casing)
5. **Model enrichment** — matches discovered models against built-in model data from multiple providers, in this priority order: `deepseek`, `zai`, `google`, `anthropic`, `minimax`, `moonshotai`, `xiaomi`, `openai`, `vercel-ai-gateway`. Models whose built-in API is not supported by NewAPI (`openai-completions`, `openai-responses`, or `anthropic-messages`) are skipped during lookup construction. Model IDs are normalized by stripping any `provider/` prefix and converting to lowercase. Earlier providers win when the same model appears in more than one source. Enrichment populates `api`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input` types, and compatibility settings. During enrichment, `supportsDeveloperRole` is set to `true` for `anthropic` and `openai` sources and `false` for all others. Unknown models fall back to defaults (`anthropic-messages`, 128K context / 4096 max output tokens / text-only)
6. **Cost calculation** — converts from NewAPI quota to USD per million tokens. Based on NewAPI's formula `Quota = (Input + Output × CompletionRate) × ModelRate × GroupRate` with `1 USD = 500,000 quota`:
   - `cost.input     = modelRatio × 2`
   - `cost.output    = modelRatio × completionRatio × 2`
   - `cost.cacheRead  = modelRatio × cacheRatio × 2`
   - `cost.cacheWrite = modelRatio × createCacheRatio × 2`
7. **Backend routing** — each registered model carries its enriched `api` and endpoint, so pi routes through the appropriate built-in API handler instead of guessing from model ID prefixes
8. **Model info templates** — unknown models (not in built-in data) get a template added to `provider-newapi.json` under `modelInfo` for manual editing. When a previously unknown model later becomes known, the template is removed automatically and upstream values are used, with a warning logged showing any differences between config and upstream values

### Graceful Fallback

If model discovery fails (network error, auth failure, etc.), the provider falls back to an **unconfigured** state:

- Registers a placeholder model `newapi/unconfigured`
- If an API key exists in `auth.json`, prompts user to run `/reload` then `/model`
- If no key exists, prompts user to run `/login`

This ensures pi never crashes on startup — it always presents a usable (if inert) provider.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) coding agent
- NewAPI gateway
- Built-in model metadata from the supported upstream providers listed above
- For cost tracking: `ExposeRatioEnabled` must be `true` in gateway Settings → Operation → Ratio
- API key with access to models via the gateway

## Without ratio_config

If the gateway has `ExposeRatioEnabled` set to `false`, the extension still works — all costs report as `0` (usage tracking disabled). Model discovery and routing are unaffected.

## License

[MIT](LICENSE) © [ttimasdf](https://github.com/ttimasdf)
