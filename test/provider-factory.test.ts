/**
 * Provider factory wiring: env/stored auth precedence and the per-key
 * `filterModels` prune once `fetchModels` has resolved. All network is
 * injected through `fetchImpl`.
 */

import { describe, expect, test } from "bun:test";
import type { ApiKeyCredential, AuthContext, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createVerbooProvider } from "../src/provider-factory.ts";
import { VERBOO_PROVIDER } from "../src/providers.ts";

function authContext(env: Record<string, string | undefined>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function jsonFetch(payload: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

async function resolveAuth(env: Record<string, string | undefined>, credential?: ApiKeyCredential) {
	const provider = await createVerbooProvider(VERBOO_PROVIDER);
	return provider.auth.apiKey!.resolve({
		ctx: authContext(env),
		...(credential ? { credential } : {}),
		signal: new AbortController().signal,
	});
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		...overrides,
	} as RefreshModelsContext;
}

const LIVE_PAYLOAD = {
	data: [
		{
			id: "deepseek-v4-flash",
			context_window: 1_048_576,
			vision: false,
			reasoning: { effort_levels: ["high", "max"], default_effort: "high" },
		},
		{
			id: "qwen3.8-27b",
			context_window: 262_144,
			vision: true,
			reasoning: { effort_levels: ["low", "medium", "xhigh", "none"], default_effort: "none" },
		},
	],
};

describe("createVerbooProvider registration shape", () => {
	test("registers with the Verboo identity and the generated baseline", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER);
		expect(provider.id).toBe("verboo");
		expect(provider.name).toBe("Verboo Code");
		expect(provider.baseUrl).toBe("https://code.verboo.ai/router/v1");
		expect(provider.auth.apiKey?.name).toBe("Verboo Code API key");
		expect(provider.getModels().length).toBe(6);
		expect(typeof provider.stream).toBe("function");
		expect(typeof provider.streamSimple).toBe("function");
	});
});

describe("auth resolution precedence", () => {
	test("stored credential wins over the env var", async () => {
		const resolved = await resolveAuth({ VERBOO_API_KEY: "env-key" }, { type: "api_key", key: "stored-key" });
		expect(resolved?.auth.apiKey).toBe("stored-key");
		expect(resolved?.source).toBe("stored credential");
	});

	test("env var is used when nothing is stored", async () => {
		const resolved = await resolveAuth({ VERBOO_API_KEY: "env-key" });
		expect(resolved?.auth.apiKey).toBe("env-key");
		expect(resolved?.source).toBe("VERBOO_API_KEY");
	});

	test("undefined when neither a stored credential nor the env var exists", async () => {
		expect(await resolveAuth({})).toBeUndefined();
	});

	test("an empty env var value does not count as configured", async () => {
		expect(await resolveAuth({ VERBOO_API_KEY: "" })).toBeUndefined();
	});

	test("login prompts for a secret and returns an api_key credential", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER);
		const login = provider.auth.apiKey!.login!;
		const prompts: Array<{ type?: string }> = [];
		const credential = await login({
			signal: new AbortController().signal,
			prompt: async (prompt) => {
				prompts.push(prompt);
				return "vbk-test-key";
			},
			notify: () => {},
		} as Parameters<typeof login>[0]);
		expect(credential).toEqual({ type: "api_key", key: "vbk-test-key" });
		expect(prompts[0]?.type).toBe("secret");
	});
});

describe("fetchModels + filterModels", () => {
	test("a successful refresh prunes to the live id set", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER, { fetchImpl: jsonFetch(LIVE_PAYLOAD) });
		expect(provider.getModels().length).toBe(6);

		const credential: ApiKeyCredential = { type: "api_key", key: "live-key" };
		await provider.refreshModels!(refreshContext({ credential }));

		const filtered = provider.filterModels!(
			provider.getModels() as readonly Model<"openai-completions">[],
			credential,
		);
		expect(filtered.map((model) => model.id)).toEqual(["deepseek-v4-flash", "qwen3.8-27b"]);
	});

	test("a failed refresh keeps the full baseline (no live set)", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER, { fetchImpl: jsonFetch({}, 500) });
		const credential: ApiKeyCredential = { type: "api_key", key: "live-key" };
		await provider.refreshModels!(refreshContext({ credential }));

		const filtered = provider.filterModels!(
			provider.getModels() as readonly Model<"openai-completions">[],
			credential,
		);
		expect(filtered.length).toBe(6);
	});
});
