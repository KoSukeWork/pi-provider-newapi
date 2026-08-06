import { FETCH_TIMEOUT_MS } from "./constants.ts";

export type NewAPIErrorCode = "aborted" | "timeout" | "auth" | "http" | "payload" | "network";

export class NewAPIError extends Error {
	readonly code: NewAPIErrorCode;

	constructor(code: NewAPIErrorCode, message: string) {
		super(message);
		this.name = "NewAPIError";
		this.code = code;
	}
}

/** Fetch with a local timeout while also honoring Pi's cancellation signal. */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeoutMs?: number; signal?: AbortSignal | null } = {},
): Promise<Response> {
	const { timeoutMs = FETCH_TIMEOUT_MS, signal: upstream, ...fetchOptions } = options;

	if (upstream?.aborted) throw new NewAPIError("aborted", `fetch(${url}) aborted before start`);

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
	const signals: AbortSignal[] = [timeoutController.signal];
	if (upstream) signals.push(upstream);
	const combined =
		typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : timeoutController.signal;

	let bridge: (() => void) | undefined;
	if (typeof AbortSignal.any !== "function" && upstream) {
		bridge = () => timeoutController.abort();
		upstream.addEventListener("abort", bridge, { once: true });
	}

	try {
		return await fetch(url, { ...fetchOptions, signal: combined });
	} catch (err) {
		if (upstream?.aborted) throw new NewAPIError("aborted", `fetch(${url}) cancelled`);
		if (timeoutController.signal.aborted) {
			throw new NewAPIError("timeout", `fetch(${url}) timed out after ${timeoutMs / 1000}s`);
		}
		throw new NewAPIError(
			"network",
			`fetch(${url}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		clearTimeout(timer);
		if (bridge && upstream) upstream.removeEventListener("abort", bridge);
	}
}
