# @pi-extension-provider-newapi

pi provider extension for self-hosted [NewAPI](https://github.com/QuantumNous/new-api) AI gateways.

Registers a single `newapi` provider with dynamic model discovery, automatic cost calculation, and backend routing based on model ID prefix:

| Model prefix | Backend | Endpoint |
|---|---|---|
| `gpt-`, `o1`, `o3`, `o4` | OpenAI Responses | `{baseUrl}/v1` |
| everything else | Anthropic Messages | `{baseUrl}` |

## Setup

### Option A: Environment variables (fast path)

```bash
export NEWAPI_BASE_URL=https://ai.your-gateway.com
export NEWAPI_API_KEY=sk-your-api-key
```

The provider registers automatically on startup with discovered models.

### Option B: Interactive `/login` (persist key)

```
pi> source .env          # sets NEWAPI_BASE_URL in dev
pi> /login newapi
Enter API key: sk-your-api-key
```

The key is saved to `<agentDir>/auth.json` by pi's built-in credential store. On next load, the extension reads it automatically.

## Config

Base URL and model metadata are stored in `<agentDir>/extensions/provider-newapi.json`. The API key is managed separately by pi's built-in `<agentDir>/auth.json` (set via `/login newapi` or `NEWAPI_API_KEY` env var).

```json
{
  "baseUrl": "https://ai.your-gateway.com",
  "modelInfo": {
    "unknown-model-id": {
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  }
}
```

On load, if a key exists and `NEWAPI_BASE_URL` differs from stored, the base URL is updated. If `NEWAPI_BASE_URL` is not set, a warning is printed.

`modelInfo` entries are auto-generated for models not found in the built-in model database. Edit them to adjust `reasoning`, `input` types, `contextWindow`, or `maxTokens`. Optionally add `thinkingLevelMap` (e.g. `{ "xhigh": "max" }`).

## How it works

1. **Config reconciliation** — reads stored key and base URL; syncs with `NEWAPI_BASE_URL` env var
2. **Model discovery** — fetches `GET /v1/models` from the gateway
3. **Model enrichment** — matches discovered models against built-in model data from `vercel-ai-gateway` to populate `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, and `input` types. Unknown models fall back to defaults (128K / 4096 tokens / text-only)
4. **Cost calculation** — fetches `GET /api/ratio_config` (no auth required) for NewAPI's `model_ratio`, `completion_ratio`, `cache_ratio`, and `create_cache_ratio` maps. Converts from NewAPI quota to USD per million tokens:
   - `cost.input   = modelRatio × 2`
   - `cost.output  = modelRatio × completionRatio × 2`
   - `cost.cacheRead  = modelRatio × cacheRatio × 2`
   - `cost.cacheWrite = modelRatio × createCacheRatio × 2`
5. **Backend routing** — models matching `gpt-`, `o1`, `o3`, or `o4` prefix use OpenAI Responses API; all others use Anthropic Messages API
6. **Model info templates** — unknown models (not in built-in data) get a template added to `provider-newapi.json` under `modelInfo` for manual editing. When a previously unknown model later becomes known, the template is removed automatically.

## Requirements

- NewAPI gateway
- For cost tracking: `ExposeRatioEnabled` must be `true` in gateway Settings → Operation → Ratio
- API key with access to models via the gateway

## Without ratio_config

If the gateway has `ExposeRatioEnabled` set to `false`, the extension still works — all costs report as `0` (usage tracking disabled).
