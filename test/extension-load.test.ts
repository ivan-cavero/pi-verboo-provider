/**
 * Extension-load contract.
 *
 * 1. `src/index.ts` registers exactly one provider named `verboo` with the six
 *    baseline models when the fake `pi` accepts the native Provider overload.
 * 2. When the native overload throws, registration falls back to the legacy
 *    `(name, config)` form with env-only auth and warns loudly.
 * 3. `src/` never uses a bare `@earendil-works/pi-ai/<subpath>` specifier
 *    (static or dynamic). pi's extension loader prefixes that alias, so a
 *    subpath resolves to `<compat.js>/<subpath>`, which does not exist.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function* tsFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* tsFiles(path);
		else if (name.endsWith(".ts")) yield path;
	}
}

/** Type-only statements are erased before resolution; safe to ignore. */
const TYPE_ONLY_STATEMENT = /^\s*(?:import|export)\s+type\b[\s\S]*?from\s*["'][^"']+["'];?/gm;
/** Static pi-ai SUBPATH specifier (the bare root is fine). */
const STATIC_SUBPATH_SPECIFIER = /(?:\bfrom\s*|\bimport\s*)["']@earendil-works\/pi-ai\/[^"']+["']/g;
/** Dynamic bare pi-ai subpath import — must never appear in src/. */
const DYNAMIC_SUBPATH_IMPORT = /\bimport\s*\(\s*["']@earendil-works\/pi-ai\/[^"']+["']\s*\)/g;

describe("static import contract", () => {
	test("src/ imports pi-ai only through the bare root", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8").replace(TYPE_ONLY_STATEMENT, "");
			for (const match of source.matchAll(STATIC_SUBPATH_SPECIFIER)) offenders.push(`${file}: ${match[0]}`);
		}
		expect(offenders).toEqual([]);
	});

	test("src/ has no dynamic bare pi-ai subpath import", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(DYNAMIC_SUBPATH_IMPORT)) offenders.push(`${file}: ${match[0]}`);
		}
		expect(offenders).toEqual([]);
	});
});

describe("extension entrypoint", () => {
	test("registers one 'verboo' provider with the six baseline models (native path)", async () => {
		const calls: unknown[][] = [];
		const fakePi = {
			registerProvider: (...args: unknown[]) => {
				calls.push(args);
			},
		} as unknown as ExtensionAPI;

		await extension(fakePi);

		expect(calls.length).toBe(1);
		expect(calls[0]!.length).toBe(1);
		const provider = calls[0]![0] as { id: string; name: string; getModels: () => unknown[] };
		expect(provider.id).toBe("verboo");
		expect(provider.name).toBe("Verboo Code");
		expect(provider.getModels().length).toBe(6);
	});

	test("falls back to the legacy (name, config) form when native registration throws", async () => {
		const calls: unknown[][] = [];
		const fakePi = {
			registerProvider: (...args: unknown[]) => {
				calls.push(args);
				if (args.length === 1) throw new Error("native overload unsupported");
			},
		} as unknown as ExtensionAPI;

		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			await extension(fakePi);
		} finally {
			console.warn = originalWarn;
		}

		expect(calls.length).toBe(2);
		expect(calls[0]!.length).toBe(1);
		const [name, config] = calls[1]! as [string, ProviderConfig];
		expect(name).toBe("verboo");
		expect(config.name).toBe("Verboo Code");
		expect(config.baseUrl).toBe("https://code.verboo.ai/router/v1");
		expect(config.api).toBe("openai-completions");
		expect(config.apiKey).toBe("$VERBOO_API_KEY");
		expect(config.models!.length).toBe(6);
		expect(config.models!.find((model) => model.id === "deepseek-v4-flash")!.thinkingLevelMap?.high).toBe("high");
		expect(warnings.some((warning) => warning.includes("[pi-verboo-provider]"))).toBe(true);
	});
});
