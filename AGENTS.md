# AGENTS.md

`pi-provider-newapi` is a single-file [pi](https://github.com/earendil-works/pi) coding-agent extension that exposes self-hosted [NewAPI](https://github.com/QuantumNous/new-api) gateways as pi model providers. It targets **pi SDK v0.80.8+** (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`).

All logic lives in @index.ts; tests in @index.test.ts. There is no build step — pi loads the `.ts` entry directly (`package.json` → `pi.extensions`).

## Commands

```bash
npm run typecheck   # tsc --noEmit (checks index.ts + index.test.ts)
npm test            # node --test (runs index.test.ts via Node's TS strip-only loader)
```

Interactive smoke test against the source checkout (needs a TTY; will hang in non-interactive shells):

```bash
../pi-src/pi-test.sh -e ./index.ts
```

Node's strip-only TS loader powers `npm test`: **no TS-only runtime syntax** (no `enum`, no parameter properties, no decorators). Keep types erasable.

## Hard constraints (v0.80.8 contract)

- **Pi owns credentials.** Never read/write `auth.json`, never touch the removed `modelRegistry.authStorage`. Users enter keys via `/login <name>` and remove them via `/logout <name>`.
- **Providers register once with `models: []` + `refreshModels(context)`.** The empty catalog is intentional — it makes the provider selectable in `/login` before any model is discovered, which bootstraps credential entry. Do not re-`registerProvider` per discovery.
- **Discovery is Pi-driven.** `/model` background refresh and `pi update --models` call `refreshModels(context)`. Honor `context.allowNetwork`, `context.force`, `context.signal`, `context.credential`, and persist via `context.store`.
- Never copy the API key into provider config, logs, notifications, model definitions, or the model store.

## Implementation map (index.ts)

Data flow: **config + Pi credential → discover → enrich → build model configs → register/persist.**

- **Config** (`readConfig`/`writeConfigAtomic`/`updateConfig`): stored at `<agentDir>/extensions/provider-newapi.json` as `{ providers: { <name>: { baseUrl, modelOverrides } }, settings }`. `updateConfig` is a serialized read-modify-write (module-level promise queue) with atomic temp-file+rename, so concurrent refreshes never clobber each other's provider entries. Malformed config is backed up to `.bak` and reset.
- **`fetchWithTimeout`**: combines a local timeout with `context.signal` via `AbortSignal.any`; throws a `NewAPIError` tagged `aborted | timeout | auth | http | payload | network`.
- **Parsing** (pure, exported, tested): `parseModelsResponse` → `NewAPIModelEntry[]` (captures `id`, `owned_by`, `supported_endpoint_types`); `parseRatioConfig` → `Ratios`. Both are defensive and never throw on malformed optional data (`/v1/models` shape is the only hard requirement).
- **Enrichment** (`getEnrichmentLookup`): a process-memoized map from normalized model id → built-in `Model` metadata, built from `ENRICHMENT_PROVIDERS` (priority-ordered) via pi-ai `getModels`. Only APIs in `SUPPORTED_NEWAPI_MODEL_APIS` are used.
- **API routing** (`gatewayApisFor` + `pickModelApi`): maps NewAPI `supported_endpoint_types` → pi `Api`s (`ENDPOINT_TYPE_TO_APIS`) and picks the model API preferring what the gateway actually advertises, then override/enriched value, then `DEFAULT_MODEL_API`. `resolveApiBaseUrl` appends `/v1` for OpenAI-style APIs.
- **`buildProviderModels`** (pure, exported, tested): the core transform. Enriched models start from built-in metadata; `modelOverrides` are applied as **partial patches** (only fields present in the JSON override; unspecified fields keep enriched values). Unknown models get a generated template override (returned separately as `newOverrides` for the caller to merge into config). Costs come from ratios: `1 USD = 500,000 quota`, `cost = ratio × (1e6 / 5e5)` per 1M tokens.
- **`discoverModels`**: fetches ratio config (best-effort) + `/v1/models` (required), reads the api-key from `context.credential`, calls `buildProviderModels`.
- **`refreshProviderModels`** (the `refreshModels` callback): restores `context.store` cache when offline/aborted; on success merges new override templates into config, writes the catalog to `context.store`, and returns it; on failure returns the last-good cached catalog (never wipes a good catalog with an empty/failed result).
- **`registerNewAPIProvider`**: `pi.registerProvider(name, { name, baseUrl, api, models: [], refreshModels })`.
- **Default export**: registers every configured provider at startup (skipping built-in name collisions / duplicates / missing baseUrl), then registers commands.

## Commands (user-facing)

- `/newapi-provider-add [name]` — prompt name + base URL, persist config, register live, tell the user to run `/login`. Only a best-effort unauthenticated reachability check; auth verification happens later in `refreshModels`.
- `/newapi-provider-remove [name]` — unregister + delete config entry. Warns to run `/logout` first (v0.80.8 exposes no extension-safe credential deletion). Never edits `auth.json`.
- `/newapi-provider-list` — uses `ctx.modelRegistry.getProviderAuthStatus(name).configured`; never prints secrets.

## Conventions

- Tabs for indentation; keep the file dependency-free beyond the two pi peer packages + Node built-ins.
- Extract pure, deterministic logic as exported functions and unit-test it; keep I/O (fetch, fs, Pi APIs) thin.
- Keep `package.json` `version` and the top `CHANGELOG.md` entry in sync; update both READMEs (`README.md` + `README_cn.md`) when user-facing behavior changes.
