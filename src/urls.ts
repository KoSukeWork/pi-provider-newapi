/** Validates and normalizes user-controlled NewAPI gateway URLs. */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Accept only HTTP(S) gateway origins without credentials or query fragments.
 *
 * HTTP remains supported for explicitly local/self-hosted gateways, but callers
 * should warn users because API keys and model traffic will not be encrypted.
 */
export function normalizeBaseUrl(raw: string): string {
	const value = raw.trim().replace(/\/+$/, "");
	if (!value) throw new Error("base URL cannot be empty");
	if (CONTROL_CHARACTERS.test(value)) throw new Error("base URL contains control characters");

	let parsed: URL;
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
