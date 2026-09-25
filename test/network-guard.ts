/**
 * Network guard for the test suite (preloaded via bunfig.toml).
 *
 * Every test must inject its own `fetch` (`fetchImpl` / `options.fetch`) or
 * spawn a local fixture. A test — or a helper that silently falls back to the
 * global fetch — must never reach a live endpoint, and never with a
 * developer's `VERBOO_API_KEY` (which would spend real quota against
 * https://code.verboo.ai).
 *
 * Replacing `globalThis.fetch` with a loud throw makes an accidental live call
 * fail immediately instead of burning tokens.
 *
 * Narrow escape hatch: integration tests that cannot inject fetch may call
 * `installMockFetch(handler)` to route the global fetch to an in-memory
 * handler, and MUST call `restoreNetworkGuard()` afterwards. The guard only
 * routes: narrowing — refusing URLs the test did not mock — is the supplied
 * handler's responsibility (see test/network-guard.test.ts).
 */

type FetchArgs = Parameters<typeof fetch>;

// Kept module-private on purpose: exporting it would let a test restore real
// network access via installMockFetch(originalFetch).
const originalFetch = globalThis.fetch;

function describeInput(input: FetchArgs[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
}

async function guardFetch(input: FetchArgs[0]): Promise<Response> {
	throw new Error(
		`[test-network-guard] Refusing a real network call to ${describeInput(input)}. ` +
			"Inject fetchImpl/options.fetch, or installMockFetch(handler) explicitly — the test suite must never hit live endpoints.",
	);
}

let mockFetch: typeof fetch | undefined;

globalThis.fetch = (async (...args: FetchArgs): Promise<Response> => {
	if (mockFetch) return mockFetch(...args);
	return guardFetch(args[0]);
}) as typeof fetch;

/** Route the global fetch to an in-memory handler for one test (restore after). */
export function installMockFetch(handler: typeof fetch): void {
	mockFetch = handler;
}

/** Return to the throwing guard. Always call this in `afterEach`/`finally`. */
export function restoreNetworkGuard(): void {
	mockFetch = undefined;
}

/** True when the throwing guard is active (no mock installed). */
export function isNetworkGuardActive(): boolean {
	return mockFetch === undefined;
}
