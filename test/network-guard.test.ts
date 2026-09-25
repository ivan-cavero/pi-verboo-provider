/**
 * Contract: the suite must never reach the network (see test/network-guard.ts,
 * preloaded via bunfig.toml). The only way around it is the explicit
 * `installMockFetch` hatch, and a non-mocked URL must still be refused.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { installMockFetch, isNetworkGuardActive, restoreNetworkGuard } from "./network-guard.ts";

const MOCK_URL = "https://mock.local/router/v1/models";

function urlOf(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
}

describe("test network guard", () => {
	afterEach(() => restoreNetworkGuard());

	test("refuses live calls by default", async () => {
		expect(isNetworkGuardActive()).toBe(true);
		await expect(fetch("https://code.verboo.ai/router/v1/models")).rejects.toThrow("test-network-guard");
	});

	test("the mock hatch routes mocked URLs and still refuses non-mocked ones", async () => {
		installMockFetch((async (input: Parameters<typeof fetch>[0]) => {
			if (urlOf(input) !== MOCK_URL) {
				throw new Error(`[test-network-guard] Refusing a real network call to ${urlOf(input)}.`);
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch);

		expect(isNetworkGuardActive()).toBe(false);
		const response = await fetch(MOCK_URL);
		expect(await response.json()).toEqual({ ok: true });

		// The hatch is narrow: a URL the handler did not mock is still refused.
		await expect(fetch("https://elsewhere.example/v1/models")).rejects.toThrow("test-network-guard");
	});

	test("restoreNetworkGuard returns to refusing", async () => {
		installMockFetch((async () => new Response("ok")) as unknown as typeof fetch);
		expect((await fetch(MOCK_URL)).ok).toBe(true);

		restoreNetworkGuard();
		expect(isNetworkGuardActive()).toBe(true);
		await expect(fetch(MOCK_URL)).rejects.toThrow("test-network-guard");
	});
});
