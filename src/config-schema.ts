/** Runtime schemas and inferred types for extension configuration versions. */

import { Type, type Static } from "typebox";
import Value from "typebox/value";
import { CONFIG_SCHEMA_VERSION } from "./constants.ts";

const ModelApiSchema = Type.Union([
	Type.Literal("anthropic-messages"),
	Type.Literal("openai-completions"),
	Type.Literal("openai-responses"),
]);

const ModelApiOverridesSchema = Type.Record(Type.String(), ModelApiSchema);

const ProviderV1Schema = Type.Object(
	{
		baseUrl: Type.String(),
		modelApiOverrides: ModelApiOverridesSchema,
	},
	{ additionalProperties: false },
);

const SettingsV1Schema = Type.Object(
	{
		onboardingWarnCountdown: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const ConfigV1Schema = Type.Object(
	{
		version: Type.Literal(CONFIG_SCHEMA_VERSION),
		providers: Type.Record(Type.String(), ProviderV1Schema),
		settings: SettingsV1Schema,
	},
	{ additionalProperties: false },
);

const ProviderV0Schema = Type.Object(
	{
		baseUrl: Type.String(),
		modelApiOverrides: Type.Optional(ModelApiOverridesSchema),
		modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

const SettingsV0Schema = Type.Object(
	{
		onboardingWarnCountdown: Type.Optional(Type.Number()),
		sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ConfigV0Schema = Type.Object(
	{
		version: Type.Optional(Type.Literal(0)),
		providers: Type.Record(Type.String(), ProviderV0Schema),
		settings: SettingsV0Schema,
	},
	{ additionalProperties: false },
);

export type NewAPIModelApi = Static<typeof ModelApiSchema>;
export type ProviderEntry = Static<typeof ProviderV1Schema>;
export type Settings = Static<typeof SettingsV1Schema>;
export type NewAPIConfig = Static<typeof ConfigV1Schema>;
export type NewAPIConfigV0 = Static<typeof ConfigV0Schema>;

export type ParsedConfig =
	| { kind: "v0"; schemaVersion: 0; data: NewAPIConfigV0 }
	| { kind: "v1"; schemaVersion: 1; data: NewAPIConfig }
	| { kind: "future"; schemaVersion: number; data: unknown };

function errorMessage(error: unknown): string {
	if (error instanceof Error && typeof error.cause === "object" && error.cause !== null) {
		const errors = (error.cause as { errors?: unknown }).errors;
		if (Array.isArray(errors)) {
			const messages = errors.flatMap((item) => {
				if (typeof item !== "object" || item === null) return [];
				const validation = item as {
					instancePath?: unknown;
					keyword?: unknown;
					message?: unknown;
					params?: { additionalProperties?: unknown; requiredProperties?: unknown };
				};
				const path =
					typeof validation.instancePath === "string"
						? validation.instancePath.replace(/^\//, "").replaceAll("/", ".")
						: "";
				const at = (field?: string) => `config${path ? `.${path}` : ""}${field ? `.${field}` : ""}`;
				if (validation.keyword === "required") {
					const required = validation.params?.requiredProperties;
					if (Array.isArray(required)) {
						return required.filter((field): field is string => typeof field === "string").map((field) => `${at(field)} is required`);
					}
				}
				if (validation.keyword === "additionalProperties") {
					const additional = validation.params?.additionalProperties;
					if (Array.isArray(additional)) {
						return additional
							.filter((field): field is string => typeof field === "string")
							.map((field) => `${at(field)} is not allowed`);
					}
				}
				return [`${at()} ${String(validation.message ?? "is invalid")}`];
			});
			if (messages.length > 0) return messages.join("; ");
		}
	}
	return error instanceof Error ? error.message : String(error);
}

/** Read the authoritative schema version without validating that version's payload. */
export function detectConfigSchemaVersion(value: unknown): number {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("config must be an object");
	}
	const version = (value as Record<string, unknown>).version;
	if (version === undefined) return 0;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
		throw new Error("config.version must be a non-negative integer");
	}
	return version;
}

/** Parse JSON and validate against the schema selected exclusively by its version field. */
export function deserializeVersionedConfig(raw: string): ParsedConfig {
	const value = JSON.parse(raw) as unknown;
	const schemaVersion = detectConfigSchemaVersion(value);
	if (schemaVersion > CONFIG_SCHEMA_VERSION) {
		return { kind: "future", schemaVersion, data: value };
	}

	try {
		return schemaVersion === 0
			? { kind: "v0", schemaVersion: 0, data: Value.Parse(ConfigV0Schema, value) }
			: { kind: "v1", schemaVersion: 1, data: Value.Parse(ConfigV1Schema, value) };
	} catch (error) {
		throw new Error(`config schema v${schemaVersion} validation failed: ${errorMessage(error)}`);
	}
}
