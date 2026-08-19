// src/config.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";

// src/config-schema.ts
import { Type } from "typebox";
import Value from "typebox/value";

// src/constants.ts
var CONFIG_FILENAME = "provider-newapi.json";
var CONFIG_SCHEMA_VERSION = 1;
var QUOTA_PER_USD = 5e5;
var TOKENS_PER_COST = 1e6;
var DEFAULT_GROUP_RATE = 1;
var DEFAULT_FETCH_TIMEOUT_MS = 15e3;
var RATIO_CONFIG_FETCH_TIMEOUT_MS = 1e4;
var REACHABILITY_FETCH_TIMEOUT_MS = 5e3;
var DEFAULT_MODEL_API = "anthropic-messages";
var DEFAULT_CONTEXT_WINDOW = 128e3;
var DEFAULT_MAX_TOKENS = 32768;
var ONBOARDING_WARN_MAX = 3;
var SUPPORTED_NEWAPI_MODEL_APIS = /* @__PURE__ */ new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses"
]);
var ENDPOINT_TYPE_TO_APIS = {
  anthropic: ["anthropic-messages"],
  openai: ["openai-completions", "openai-responses"]
};
var API_PREFERENCE = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions"
];
var ENRICHMENT_PROVIDERS = [
  "deepseek",
  "zai",
  "google",
  "anthropic",
  "minimax",
  "moonshotai",
  "xiaomi",
  "openai",
  "vercel-ai-gateway"
];

// src/config-schema.ts
var ModelApiSchema = Type.Union([
  Type.Literal("anthropic-messages"),
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses")
]);
var ModelApiOverridesSchema = Type.Record(Type.String(), ModelApiSchema);
var ProviderV1Schema = Type.Object(
  {
    baseUrl: Type.String(),
    modelApiOverrides: Type.Optional(ModelApiOverridesSchema)
  },
  { additionalProperties: false }
);
var SettingsV1Schema = Type.Object(
  {
    onboardingWarnCountdown: Type.Optional(Type.Number())
  },
  { additionalProperties: false }
);
var ConfigV1Schema = Type.Object(
  {
    version: Type.Literal(CONFIG_SCHEMA_VERSION),
    providers: Type.Record(Type.String(), ProviderV1Schema),
    settings: SettingsV1Schema
  },
  { additionalProperties: false }
);
var ProviderV0Schema = Type.Object(
  {
    baseUrl: Type.String(),
    modelApiOverrides: Type.Optional(ModelApiOverridesSchema),
    modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  },
  { additionalProperties: false }
);
var SettingsV0Schema = Type.Object(
  {
    onboardingWarnCountdown: Type.Optional(Type.Number()),
    sendSessionAffinityHeaders: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);
var ConfigV0Schema = Type.Object(
  {
    version: Type.Optional(Type.Literal(0)),
    providers: Type.Record(Type.String(), ProviderV0Schema),
    settings: SettingsV0Schema
  },
  { additionalProperties: false }
);
function errorMessage(error) {
  if (error instanceof Error && typeof error.cause === "object" && error.cause !== null) {
    const errors = error.cause.errors;
    if (Array.isArray(errors)) {
      const messages = errors.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const validation = item;
        const path = typeof validation.instancePath === "string" ? validation.instancePath.replace(/^\//, "").replaceAll("/", ".") : "";
        const at = (field) => `config${path ? `.${path}` : ""}${field ? `.${field}` : ""}`;
        if (validation.keyword === "required") {
          const required = validation.params?.requiredProperties;
          if (Array.isArray(required)) {
            return required.filter((field) => typeof field === "string").map((field) => `${at(field)} is required`);
          }
        }
        if (validation.keyword === "additionalProperties") {
          const additional = validation.params?.additionalProperties;
          if (Array.isArray(additional)) {
            return additional.filter((field) => typeof field === "string").map((field) => `${at(field)} is not allowed`);
          }
        }
        return [`${at()} ${String(validation.message ?? "is invalid")}`];
      });
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return error instanceof Error ? error.message : String(error);
}
function detectConfigSchemaVersion(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const version = value.version;
  if (version === void 0) return 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Error("config.version must be a non-negative integer");
  }
  return version;
}
function deserializeVersionedConfig(raw) {
  const value = JSON.parse(raw);
  const schemaVersion = detectConfigSchemaVersion(value);
  if (schemaVersion > CONFIG_SCHEMA_VERSION) {
    return { kind: "future", schemaVersion, data: value };
  }
  try {
    return schemaVersion === 0 ? { kind: "v0", schemaVersion: 0, data: Value.Parse(ConfigV0Schema, value) } : { kind: "v1", schemaVersion: 1, data: Value.Parse(ConfigV1Schema, value) };
  } catch (error) {
    throw new Error(`config schema v${schemaVersion} validation failed: ${errorMessage(error)}`);
  }
}

// src/migration.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
function getCurrentConfigPath() {
  return join(getAgentDir(), "extension-settings", CONFIG_FILENAME);
}
function getLegacyConfigPath() {
  return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}
function parseConfig(path) {
  return deserializeVersionedConfig(readFileSync(path, "utf-8"));
}
function formatBackupTimestamp(date) {
  const part = (value) => String(value).padStart(2, "0");
  return part(date.getFullYear() % 100) + part(date.getMonth() + 1) + part(date.getDate()) + "-" + part(date.getHours()) + part(date.getMinutes()) + part(date.getSeconds());
}
function nextBackupPath(configPath) {
  const stem = CONFIG_FILENAME.endsWith(".json") ? CONFIG_FILENAME.slice(0, -5) : CONFIG_FILENAME;
  const timestamp = /* @__PURE__ */ new Date();
  let backupPath;
  do {
    backupPath = join(dirname(configPath), `${stem}.${formatBackupTimestamp(timestamp)}.json.bak`);
    timestamp.setSeconds(timestamp.getSeconds() + 1);
  } while (existsSync(backupPath));
  return backupPath;
}
function archiveConfig(sourcePath, configPath) {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const backupPath = nextBackupPath(configPath);
  renameSync(sourcePath, backupPath);
  return backupPath;
}
function writeConfigAt(configPath, config) {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, configPath);
}
function emptyConfig() {
  return { version: CONFIG_SCHEMA_VERSION, providers: {}, settings: {} };
}
function migrateCandidate(candidate) {
  if (candidate.kind === "v1") return candidate.data;
  if (candidate.kind !== "v0") {
    throw new Error(`cannot migrate future config schema v${candidate.schemaVersion}`);
  }
  const providers = {};
  for (const [name, entry] of Object.entries(candidate.data.providers)) {
    providers[name] = {
      baseUrl: entry.baseUrl ?? "",
      modelApiOverrides: entry.modelApiOverrides ?? {}
    };
  }
  return {
    version: CONFIG_SCHEMA_VERSION,
    providers,
    settings: {
      onboardingWarnCountdown: candidate.data.settings?.onboardingWarnCountdown
    }
  };
}
function configRecoveryGuidance() {
  return " Run /newapi-config-recover to recover settings from config backups.";
}
function resetInvalidConfig(configPath = getCurrentConfigPath(), reason) {
  const detail = reason instanceof Error ? `: ${reason.message}` : reason === void 0 ? "" : `: ${String(reason)}`;
  try {
    const backupPath = existsSync(configPath) ? archiveConfig(configPath, configPath) : void 0;
    writeConfigAt(configPath, emptyConfig());
    console.warn(
      `NewAPI: config at ${configPath} is invalid${detail}.` + (backupPath ? ` Moved it to ${backupPath}` : "") + " and created an empty config." + (backupPath ? configRecoveryGuidance() : "")
    );
  } catch (error) {
    console.warn(
      `NewAPI: could not archive and reset invalid config at ${configPath}: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
}
function archiveLegacyPath(legacyPath, configPath) {
  let candidate;
  let parseError;
  try {
    candidate = parseConfig(legacyPath);
  } catch (error) {
    parseError = error;
  }
  const backupPath = archiveConfig(legacyPath, configPath);
  if (existsSync(configPath)) {
    console.warn(
      `NewAPI: moved legacy config from ${legacyPath} to ${backupPath}; the existing config at ${configPath} remains authoritative.` + configRecoveryGuidance()
    );
    return;
  }
  if (!candidate) {
    writeConfigAt(configPath, emptyConfig());
    console.warn(
      `NewAPI: legacy config at ${legacyPath} is invalid${parseError instanceof Error ? `: ${parseError.message}` : ""}. Moved it to ${backupPath} and created an empty config at ${configPath}.` + configRecoveryGuidance()
    );
    return;
  }
  if (candidate.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `NewAPI: legacy config schema version ${candidate.schemaVersion} was moved to ${backupPath} and is newer than supported version ${CONFIG_SCHEMA_VERSION}. Upgrade the extension before migrating it.` + configRecoveryGuidance()
    );
  }
  writeConfigAt(configPath, migrateCandidate(candidate));
  console.warn(
    `NewAPI: moved legacy config from ${legacyPath} to ${backupPath} and migrated it to ${configPath}.` + configRecoveryGuidance()
  );
}
function migrateConfig(configPath = getCurrentConfigPath()) {
  const legacyPath = getLegacyConfigPath();
  if (existsSync(legacyPath)) archiveLegacyPath(legacyPath, configPath);
  if (!existsSync(configPath)) return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
  let candidate;
  try {
    candidate = parseConfig(configPath);
  } catch (error) {
    resetInvalidConfig(configPath, error);
    return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
  }
  if (candidate.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `NewAPI: config schema version ${candidate.schemaVersion} at ${configPath} is newer than supported version ${CONFIG_SCHEMA_VERSION}. Upgrade the extension before editing this configuration.`
    );
  }
  if (candidate.schemaVersion < CONFIG_SCHEMA_VERSION) {
    const backupPath = archiveConfig(configPath, configPath);
    writeConfigAt(configPath, migrateCandidate(candidate));
    console.warn(
      `NewAPI: moved schema ${candidate.schemaVersion} config to ${backupPath} and migrated ${configPath} to schema ${CONFIG_SCHEMA_VERSION}.` + configRecoveryGuidance()
    );
  }
  return { path: configPath, schemaVersion: CONFIG_SCHEMA_VERSION };
}

// src/urls.ts
var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
function normalizeBaseUrl(raw) {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) throw new Error("base URL cannot be empty");
  if (CONTROL_CHARACTERS.test(value)) throw new Error("base URL contains control characters");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("base URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must use http:// or https://");
  }
  if (!parsed.hostname) throw new Error("base URL must include a hostname");
  if (parsed.username || parsed.password) {
    throw new Error("base URL must not contain username or password information");
  }
  if (parsed.search || parsed.hash) throw new Error("base URL must not contain a query or fragment");
  return value;
}

// src/config.ts
function getConfigPath() {
  return join2(getAgentDir2(), "extension-settings", CONFIG_FILENAME);
}
function deserializeConfig(raw) {
  const parsed = deserializeVersionedConfig(raw);
  if (parsed.kind !== "v1") {
    throw new Error(`expected config schema v${CONFIG_SCHEMA_VERSION}, received schema v${parsed.schemaVersion}`);
  }
  const providers = Object.fromEntries(
    Object.entries(parsed.data.providers).map(([name, entry]) => {
      try {
        return [name, { ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) }];
      } catch (error) {
        throw new Error(
          `config.providers.${name}.baseUrl is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );
  return { ...parsed.data, providers };
}
function readConfig() {
  const { path: configPath } = migrateConfig(getConfigPath());
  const empty = { version: CONFIG_SCHEMA_VERSION, providers: {}, settings: {} };
  if (!existsSync2(configPath)) return empty;
  let raw;
  try {
    raw = readFileSync2(configPath, "utf-8");
  } catch (err) {
    console.warn(`NewAPI: could not read config: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
  try {
    return deserializeConfig(raw);
  } catch (error) {
    resetInvalidConfig(configPath, error);
    return empty;
  }
}
function writeConfigAtomic(config) {
  const configPath = getConfigPath();
  const dir = dirname2(configPath);
  if (!existsSync2(dir)) mkdirSync2(dir, { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync2(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync2(tmpPath, configPath);
}
var configWriteQueue = Promise.resolve();
function updateConfig(mutator) {
  const run = configWriteQueue.then(async () => {
    const config = readConfig();
    if (mutator(config)) writeConfigAtomic(config);
  });
  configWriteQueue = run.catch(() => {
  });
  return run;
}

// src/commands.ts
import { join as join4 } from "node:path";
import { pathToFileURL } from "node:url";
import { getProviders as getProviders2 } from "@earendil-works/pi-ai/compat";
import { getAgentDir as getAgentDir4 } from "@earendil-works/pi-coding-agent";

// src/generated-models.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";

// src/models.ts
import { getModels } from "@earendil-works/pi-ai/compat";

// src/http.ts
var NewAPIError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NewAPIError";
    this.code = code;
  }
};
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: upstream, ...fetchOptions } = options;
  if (upstream?.aborted) throw new NewAPIError("aborted", `fetch(${url}) aborted before start`);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [timeoutController.signal];
  if (upstream) signals.push(upstream);
  const combined = typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : timeoutController.signal;
  let bridge;
  if (typeof AbortSignal.any !== "function" && upstream) {
    bridge = () => timeoutController.abort();
    upstream.addEventListener("abort", bridge, { once: true });
  }
  try {
    return await fetch(url, { ...fetchOptions, signal: combined });
  } catch (err) {
    if (upstream?.aborted) throw new NewAPIError("aborted", `fetch(${url}) cancelled`);
    if (timeoutController.signal.aborted) {
      throw new NewAPIError("timeout", `fetch(${url}) timed out after ${timeoutMs / 1e3}s`);
    }
    throw new NewAPIError(
      "network",
      `fetch(${url}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
    if (bridge && upstream) upstream.removeEventListener("abort", bridge);
  }
}

// src/types.ts
var EMPTY_RATIOS = {
  modelRatios: {},
  completionRatios: {},
  cacheRatios: {},
  createCacheRatios: {}
};

// src/models.ts
function resolveApiBaseUrl(baseUrl, api) {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
      return `${baseUrl.replace(/\/+$/, "")}/v1`;
    default:
      return baseUrl;
  }
}
function calcCacheCost(modelRate, ratio) {
  return modelRate * ratio * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD);
}
function findRatio(modelId, ratios) {
  if (modelId in ratios) return ratios[modelId];
  const lower = modelId.toLowerCase();
  for (const [key, value] of Object.entries(ratios)) {
    if (key.toLowerCase() === lower) return value;
  }
  for (const [key, value] of Object.entries(ratios)) {
    if (lower.startsWith(key.toLowerCase())) return value;
  }
  return void 0;
}
var cachedEnrichmentLookup;
function getEnrichmentLookup() {
  if (cachedEnrichmentLookup) return cachedEnrichmentLookup;
  const lookup = /* @__PURE__ */ new Map();
  for (const provider of ENRICHMENT_PROVIDERS) {
    let providerModels;
    try {
      providerModels = getModels(provider);
    } catch {
      continue;
    }
    for (const model of providerModels) {
      if (!SUPPORTED_NEWAPI_MODEL_APIS.has(model.api)) continue;
      const stripped = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
      const normalizedId = stripped.replaceAll(".", "-").toLowerCase();
      if (lookup.has(normalizedId)) continue;
      lookup.set(normalizedId, {
        model: {
          ...model,
          compat: {
            ...model.compat,
            supportsDeveloperRole: provider === "anthropic" || provider === "openai"
          }
        },
        source: provider
      });
    }
  }
  cachedEnrichmentLookup = lookup;
  return lookup;
}
function isEnrichedModelId(modelId) {
  return getEnrichmentLookup().has(modelId.replaceAll(".", "-").toLowerCase());
}
function compileModelApiOverrides(overrides) {
  const rules = [];
  const errors = [];
  for (const [pattern, api] of Object.entries(overrides)) {
    if (!SUPPORTED_NEWAPI_MODEL_APIS.has(api)) {
      errors.push(`pattern "${pattern}" uses unsupported API "${api}"`);
      continue;
    }
    try {
      rules.push({ pattern, regex: new RegExp(pattern), api });
    } catch (error) {
      errors.push(`invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rules, errors };
}
function pickModelApi(preferred, gatewayApis) {
  if (preferred && SUPPORTED_NEWAPI_MODEL_APIS.has(preferred) && (gatewayApis.size === 0 || gatewayApis.has(preferred))) {
    return preferred;
  }
  for (const api of API_PREFERENCE) {
    if (gatewayApis.has(api)) return api;
  }
  return SUPPORTED_NEWAPI_MODEL_APIS.has(preferred) ? preferred : DEFAULT_MODEL_API;
}
function parseModelsResponse(json) {
  if (typeof json !== "object" || json === null) {
    throw new NewAPIError("payload", "/v1/models returned a non-object payload");
  }
  const data = json.data;
  if (!Array.isArray(data)) throw new NewAPIError("payload", "/v1/models payload has no data array");
  const output = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item;
    if (typeof record.id !== "string") continue;
    output.push({
      id: record.id,
      ownedBy: typeof record.owned_by === "string" ? record.owned_by : void 0,
      supportedEndpointTypes: Array.isArray(record.supported_endpoint_types) ? record.supported_endpoint_types.filter((type) => typeof type === "string") : []
    });
  }
  return output;
}
function asRatioMap(value) {
  if (typeof value !== "object" || value === null) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
  }
  return output;
}
function parseRatioConfig(json) {
  if (typeof json !== "object" || json === null) return EMPTY_RATIOS;
  const root = json;
  if (root.success === false) return EMPTY_RATIOS;
  const data = root.data ?? root;
  return {
    modelRatios: asRatioMap(data.model_ratio),
    completionRatios: asRatioMap(data.completion_ratio),
    cacheRatios: asRatioMap(data.cache_ratio),
    createCacheRatios: asRatioMap(data.create_cache_ratio)
  };
}
function buildProviderModels(params) {
  const { providerName, baseUrl, apiModels, ratios, modelApiOverrides } = params;
  const enrichmentLookup = getEnrichmentLookup();
  const { rules, errors } = compileModelApiOverrides(modelApiOverrides);
  for (const error of errors) console.warn(`NewAPI [${providerName}]: modelApiOverrides ${error} \u2014 ignoring it.`);
  const models = [];
  for (const modelEntry of apiModels) {
    const normalizedId = modelEntry.id.replaceAll(".", "-").toLowerCase();
    const enriched = enrichmentLookup.get(normalizedId);
    const gatewayApis = /* @__PURE__ */ new Set();
    for (const type of modelEntry.supportedEndpointTypes) {
      for (const candidate of ENDPOINT_TYPE_TO_APIS[type] ?? []) gatewayApis.add(candidate);
    }
    const apiOverride = rules.find((rule) => rule.regex.test(modelEntry.id))?.api;
    let name = modelEntry.id;
    let reasoning = false;
    let thinkingLevelMap = enriched?.model.thinkingLevelMap;
    let input = ["text"];
    let contextWindow = DEFAULT_CONTEXT_WINDOW;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let api;
    let compat;
    if (enriched) {
      name = enriched.model.name ?? modelEntry.id;
      compat = enriched.model.compat;
      reasoning = enriched.model.reasoning;
      input = enriched.model.input;
      contextWindow = enriched.model.contextWindow;
      maxTokens = enriched.model.maxTokens;
      api = apiOverride ?? pickModelApi(enriched.model.api, gatewayApis);
      if (apiOverride === void 0 && enriched.model.api === void 0 && gatewayApis.size === 0) {
        console.warn(
          `NewAPI [${providerName}]: enriched model "${modelEntry.id}" from ${enriched.source} has no api and the gateway advertised none \u2014 falling back to ${api}`
        );
      }
    } else {
      api = apiOverride ?? pickModelApi(void 0, gatewayApis);
    }
    const modelRate = findRatio(modelEntry.id, ratios.modelRatios) ?? 0;
    const completionRate = findRatio(modelEntry.id, ratios.completionRatios) ?? 1;
    const cacheRatio = findRatio(modelEntry.id, ratios.cacheRatios) ?? 0;
    const createCacheRatio = findRatio(modelEntry.id, ratios.createCacheRatios) ?? 0;
    models.push({
      id: modelEntry.id,
      name,
      api,
      baseUrl: resolveApiBaseUrl(baseUrl, api),
      reasoning,
      thinkingLevelMap,
      input,
      cost: {
        input: modelRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD),
        output: modelRate * completionRate * DEFAULT_GROUP_RATE * (TOKENS_PER_COST / QUOTA_PER_USD),
        cacheRead: calcCacheCost(modelRate, cacheRatio),
        cacheWrite: calcCacheCost(modelRate, createCacheRatio)
      },
      contextWindow,
      maxTokens,
      compat
    });
  }
  return models;
}

// src/generated-models.ts
function buildGeneratedModelsJson(providerNames, models) {
  const providers = {};
  const configured = new Set(providerNames);
  const modelsByProvider = /* @__PURE__ */ new Map();
  for (const model of models) {
    if (!configured.has(model.provider) || isEnrichedModelId(model.id)) continue;
    const ids = modelsByProvider.get(model.provider) ?? /* @__PURE__ */ new Set();
    ids.add(model.id);
    modelsByProvider.set(model.provider, ids);
  }
  for (const providerName of [...configured].sort()) {
    const ids = modelsByProvider.get(providerName);
    if (!ids || ids.size === 0) continue;
    const modelOverrides = {};
    for (const id of [...ids].sort()) {
      modelOverrides[id] = {
        reasoning: false,
        input: ["text"],
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS
      };
    }
    providers[providerName] = { modelOverrides };
  }
  return { providers };
}
function getGeneratedModelsPath() {
  return join3(getAgentDir3(), "models-generated.json");
}
function writeGeneratedModelsJson(config, outputPath = getGeneratedModelsPath()) {
  const outputDir = dirname3(outputPath);
  if (!existsSync3(outputDir)) mkdirSync3(outputDir, { recursive: true });
  const tmpPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync3(tmpPath, `${JSON.stringify(config, null, 2)}
`, "utf-8");
  renameSync3(tmpPath, outputPath);
}

// src/provider.ts
import { getProviders } from "@earendil-works/pi-ai/compat";

// src/discovery.ts
async function refreshProviderModels(providerName, context) {
  const config = readConfig();
  const entry = config.providers[providerName];
  if (!entry) return [];
  const cachedModels = context.stored?.models ?? [];
  if (!context.allowNetwork || context.signal.aborted) return cachedModels;
  const credential = context.credential;
  const apiKey = credential?.type === "api_key" && credential.key ? credential.key : void 0;
  try {
    const baseUrl = normalizeBaseUrl(entry.baseUrl);
    let ratios = EMPTY_RATIOS;
    try {
      const ratioResponse = await fetchWithTimeout(`${baseUrl}/api/ratio_config`, {
        redirect: "error",
        signal: context.signal,
        timeoutMs: RATIO_CONFIG_FETCH_TIMEOUT_MS
      });
      if (ratioResponse.ok) ratios = parseRatioConfig(await ratioResponse.json());
    } catch (err) {
      if (err instanceof NewAPIError && err.code === "aborted") throw err;
      console.warn(
        `NewAPI [${providerName}]: /api/ratio_config unavailable \u2014 ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const modelsResponse = await fetchWithTimeout(`${baseUrl}/v1/models`, {
      headers,
      redirect: "error",
      signal: context.signal
    });
    if (modelsResponse.status === 401 || modelsResponse.status === 403) {
      throw new NewAPIError(
        "auth",
        `GET /v1/models: ${modelsResponse.status} ${modelsResponse.statusText} \u2014 check the API key`
      );
    }
    if (!modelsResponse.ok) {
      throw new NewAPIError("http", `GET /v1/models: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }
    const models = buildProviderModels({
      providerName,
      baseUrl,
      apiModels: parseModelsResponse(await modelsResponse.json()),
      ratios,
      modelApiOverrides: entry.modelApiOverrides ?? {}
    });
    if (models.length === 0 && cachedModels.length > 0) {
      console.warn(`NewAPI [${providerName}]: /v1/models returned zero models \u2014 keeping cached catalog.`);
      return cachedModels;
    }
    if (context.signal.aborted) return cachedModels;
    await context.publish({
      persist: {
        models,
        checkedAt: Date.now()
      }
    });
    return models;
  } catch (err) {
    if (err instanceof NewAPIError && err.code === "aborted") return cachedModels;
    console.warn(
      `NewAPI [${providerName}]: refresh failed \u2014 ${err instanceof Error ? err.message : String(err)}` + (cachedModels.length > 0 ? " (serving cached catalog)" : "")
    );
    return cachedModels;
  }
}

// src/provider.ts
function registerNewAPIProvider(pi, name, entry) {
  const baseUrl = normalizeBaseUrl(entry.baseUrl);
  pi.registerProvider(name, {
    name: `NewAPI (${name})`,
    baseUrl,
    api: DEFAULT_MODEL_API,
    // The empty startup catalog makes /login available before authenticated discovery runs.
    models: [],
    async refreshModels(context) {
      return refreshProviderModels(name, context);
    }
  });
}
function registerConfiguredProviders(pi, config, state) {
  const builtinProviderIds = getProviders();
  for (const [name, entry] of Object.entries(config.providers)) {
    if (builtinProviderIds.includes(name)) {
      console.warn(`NewAPI: skipping provider "${name}" \u2014 name collides with a built-in pi provider.`);
      continue;
    }
    if (state.registered.has(name)) {
      console.warn(`NewAPI: skipping duplicate provider key "${name}" in config.`);
      continue;
    }
    if (!entry || typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) {
      console.warn(`NewAPI: skipping provider "${name}" \u2014 missing baseUrl.`);
      continue;
    }
    try {
      registerNewAPIProvider(pi, name, entry);
    } catch (error) {
      console.warn(
        `NewAPI: skipping provider "${name}" \u2014 invalid baseUrl (${error instanceof Error ? error.message : String(error)}).`
      );
      continue;
    }
    state.registered.add(name);
  }
}

// src/commands.ts
function terminalFileLink(path, enabled) {
  if (!enabled) return path;
  return `\x1B]8;;${pathToFileURL(path).href}\x07${path}\x1B]8;;\x07`;
}
function registerCommands(pi, state) {
  pi.registerCommand("newapi-provider-add", {
    description: "Add a new NewAPI provider (prompts for base URL; login via /login)",
    handler: async (args, ctx) => {
      let name = args.trim();
      if (!name) {
        const input = await ctx.ui.input("Provider name", "my_gateway");
        if (input === void 0) return;
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
      const builtins = getProviders2();
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
      if (baseUrlRaw === void 0) return;
      let baseUrl;
      try {
        baseUrl = normalizeBaseUrl(baseUrlRaw);
      } catch (error) {
        ctx.ui.notify(`Invalid base URL: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (baseUrl.startsWith("http://")) {
        ctx.ui.notify("Warning: HTTP does not encrypt API keys or model traffic; HTTPS is recommended.", "warning");
      }
      try {
        const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
          redirect: "error",
          signal: ctx.signal,
          timeoutMs: REACHABILITY_FETCH_TIMEOUT_MS
        });
        if (!response.ok && response.status !== 401 && response.status !== 403) {
          ctx.ui.notify(
            `Warning: ${baseUrl} responded ${response.status} ${response.statusText}. Saving anyway.`,
            "warning"
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `Warning: could not reach ${baseUrl} (${err instanceof Error ? err.message : String(err)}). Saving anyway.`,
          "warning"
        );
      }
      const entry = { baseUrl, modelApiOverrides: {} };
      await updateConfig((config) => {
        config.providers[name] = entry;
        return true;
      });
      registerNewAPIProvider(pi, name, entry);
      state.registered.add(name);
      ctx.ui.notify(
        `Provider "${name}" added. Run /login ${name} to enter its API key; Pi will then discover its models.`,
        "info"
      );
    }
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
      let refreshError;
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
          "error"
        );
        return;
      }
      const modelsPath = join4(getAgentDir4(), "models.json");
      const generatedLink = terminalFileLink(generatedPath, ctx.mode === "tui");
      const modelsLink = terminalFileLink(modelsPath, ctx.mode === "tui");
      const count = Object.values(generated.providers).reduce(
        (total, provider) => total + Object.keys(provider.modelOverrides).length,
        0
      );
      const providersWithoutModels = providerNames.filter(
        (name) => !currentModels.some((model) => model.provider === name)
      );
      const warnings = [
        ...refreshError ? [`Model reload failed: ${refreshError}`] : [],
        ...providersWithoutModels.length > 0 ? [
          `No discovered models were available for: ${providersWithoutModels.join(", ")}. Open /model to refresh discovery, then run this command again.`
        ] : []
      ];
      const warning = warnings.length > 0 ? `

Warnings:
${warnings.map((item) => `  ${item}`).join("\n")}` : "";
      ctx.ui.notify(
        `Generated ${count} unknown-model override template${count === 1 ? "" : "s"}:
${generatedLink}

Copy and merge the relevant provider entries from that file into Pi's models.json:
${modelsLink}

Do not replace existing providers or modelOverrides entries when pasting; merge them by provider and model ID.` + warning,
        warnings.length > 0 ? "warning" : "info"
      );
    }
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
        if (selected === void 0) return;
        name = selected;
      }
      if (!current.providers[name]) {
        ctx.ui.notify(`Provider "${name}" not found in config.`, "error");
        return;
      }
      const status = ctx.modelRegistry.getProviderAuthStatus(name);
      const credentialNote = status.configured ? `A Pi credential is still configured for "${name}". Run /logout ${name} to remove it \u2014 this command does not edit auth.json.

` : "";
      const confirmed = await ctx.ui.confirm(
        `Remove provider "${name}"?`,
        `${credentialNote}This will unregister "${name}" and delete its config entry.`
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
        status.configured ? `Provider "${name}" removed. Run /logout ${name} to delete its stored credential.` : `Provider "${name}" removed.`,
        "info"
      );
    }
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
        return `  ${name}  |  ${entry.baseUrl}  |  auth: ${status.configured ? "\u2713" : "\u2717"}  |  API overrides: ${overrideCount}  |  ${stateLabel}`;
      });
      ctx.ui.notify(`NewAPI providers (${names.length}):
${lines.join("\n")}`, "info");
    }
  });
}

// src/extension.ts
async function newApiExtension(pi) {
  const config = readConfig();
  const state = { registered: /* @__PURE__ */ new Set() };
  registerConfiguredProviders(pi, config, state);
  if (state.registered.size === 0) {
    const countdown = config.settings.onboardingWarnCountdown ?? ONBOARDING_WARN_MAX;
    if (countdown > 0) {
      console.warn("NewAPI: no providers configured. Run /newapi-provider-add to add a NewAPI gateway.");
      void updateConfig((latestConfig) => {
        latestConfig.settings.onboardingWarnCountdown = countdown - 1;
        return true;
      });
    }
  }
  registerCommands(pi, state);
}
export {
  newApiExtension as default
};
