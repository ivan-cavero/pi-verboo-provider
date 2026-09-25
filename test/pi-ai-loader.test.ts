/**
 * Loader contract via the `PiAiLoaderHost` injection seam.
 *
 * Covers branch 1 (root namespace), branch 2 (host-derived candidate), the
 * throwing-resolver path, and the C3 regression: a resolver that returns a
 * filesystem path (the `createRequire` fallback shape) must produce the typed
 * `PiAiStreamingApiResolutionError`, never a raw `TypeError`.
 *
 * No network and no writes: `importModule` is injected.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import {
	PiAiStreamingApiResolutionError,
	resolveOpenAICompletionsApi,
	type ModuleNamespace,
	type PiAiLoaderHost,
} from "../src/pi-ai-loader.ts";

const FAKE_FACTORY = (() => ({}) as ProviderStreams) as unknown as () => ProviderStreams;
const NAMESPACE_WITH_FACTORY: ModuleNamespace = { openAICompletionsApi: FAKE_FACTORY };
const EMPTY_NAMESPACE: ModuleNamespace = {};

async function capture(promise: Promise<unknown>): Promise<Error | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

describe("resolveOpenAICompletionsApi", () => {
	test("returns the root namespace factory without resolving (branch 1)", async () => {
		let resolved = false;
		const host: PiAiLoaderHost = {
			namespace: NAMESPACE_WITH_FACTORY,
			resolveSpecifier: () => {
				resolved = true;
				return "file:///never-used/index.js";
			},
			importModule: async () => ({}),
		};

		expect(await resolveOpenAICompletionsApi(host)).toBe(FAKE_FACTORY);
		expect(resolved).toBe(false);
	});

	test("a throwing resolver surfaces the typed error", async () => {
		const host: PiAiLoaderHost = {
			namespace: EMPTY_NAMESPACE,
			resolveSpecifier: () => {
				throw new Error("no resolve support on this runtime");
			},
			importModule: async () => ({}),
		};

		const error = await capture(resolveOpenAICompletionsApi(host));
		expect(error).toBeInstanceOf(PiAiStreamingApiResolutionError);
		expect((error as PiAiStreamingApiResolutionError).attemptedUrls).toEqual([]);
	});

	test("a host-derived candidate that exports the factory is returned (branch 2)", async () => {
		const requested: string[] = [];
		const host: PiAiLoaderHost = {
			namespace: EMPTY_NAMESPACE,
			resolveSpecifier: () => "file:///host/node_modules/@earendil-works/pi-ai/dist/index.js",
			importModule: async (url) => {
				requested.push(url);
				return url.endsWith("api/openai-completions.lazy.js") ? NAMESPACE_WITH_FACTORY : EMPTY_NAMESPACE;
			},
		};

		expect(await resolveOpenAICompletionsApi(host)).toBe(FAKE_FACTORY);
		expect(requested[0]).toContain("api/openai-completions.lazy.js");
		expect(requested[0]?.startsWith("file:///host/node_modules/@earendil-works/pi-ai/dist/")).toBe(true);
	});

	test("a filesystem-path resolver result still yields the typed error, not a TypeError (C3)", async () => {
		const rootPath = "/tmp/pi-ai-host/node_modules/@earendil-works/pi-ai/dist/index.js";
		const host: PiAiLoaderHost = {
			namespace: EMPTY_NAMESPACE,
			resolveSpecifier: () => rootPath,
			importModule: async () => ({}),
		};

		const error = await capture(resolveOpenAICompletionsApi(host));
		expect(error).toBeInstanceOf(PiAiStreamingApiResolutionError);
		expect(error?.constructor.name).toBe("PiAiStreamingApiResolutionError");

		const typed = error as PiAiStreamingApiResolutionError;
		expect(typed.resolvedRootUrl).toBe(rootPath);
		expect(typed.attemptedUrls.length).toBe(2);
		expect(typed.attemptedUrls.every((url) => url.startsWith("file://"))).toBe(true);
	});
});
