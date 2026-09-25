/**
 * Catalog behavior: model shaping, live parsing tolerance, merge semantics,
 * and the never-block-startup fallback. All network goes through an injected
 * `fetchImpl`, so the network guard is never bypassed.
 */

import { describe, expect, test } from "bun:test";
import {
	baselineModels,
	entryFromLiveCapability,
	listLiveModels,
	mergeLiveWithGenerated,
	resolveCatalog,
	toModel,
	UNKNOWN_MODEL_LIMITS,
	VERBOO_COMPAT,
	VERBOO_COMPAT_API,
	type CatalogSource,
} from "../src/catalog.ts";
import { GENERATED_CATALOG_META, VERBOO_GENERATED_MODELS } from "../src/catalog.generated.ts";

const SOURCE: CatalogSource = { providerId: "verboo", baseUrl: "https://code.verboo.ai/router/v1" };

/** Verboo's real `/models` payload shape (two representative rows). */
const VERBOO_PAYLOAD = {
	object: "list",
	data: [
		{
			id: "deepseek-v4-flash",
			object: "model",
			created: 1,
			owned_by: "verboo",
			context_window: 1_048_576,
			vision: false,
			reasoning: { effort_levels: ["high", "max"], default_effort: "high" },
		},
		{
			id: "qwen3.8-27b",
			object: "model",
			created: 1,
			owned_by: "verboo",
			context_window: 262_144,
			vision: true,
			reasoning: { effort_levels: ["low", "medium", "xhigh", "none"], default_effort: "none" },
		},
	],
};

function jsonFetch(payload: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

function textFetch(body: string, status = 200): typeof fetch {
	return (async () =>
		new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

/** A fetch that never settles until its AbortSignal fires (timeout path). */
function hangingFetch(): typeof fetch {
	return ((_url: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		})) as unknown as typeof fetch;
}

describe("baselineModels / toModel", () => {
	test("baseline is the committed snapshot, shaped for pi", () => {
		const models = baselineModels(SOURCE);
		expect(models.length).toBe(VERBOO_GENERATED_MODELS.length);
		expect(models.map((model) => model.id)).toEqual([...GENERATED_CATALOG_META.models]);
		for (const model of models) {
			expect(model.api).toBe(VERBOO_COMPAT_API);
			expect(model.provider).toBe("verboo");
			expect(model.baseUrl).toBe(SOURCE.baseUrl);
			expect(typeof model.reasoning).toBe("boolean");
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.compat).toEqual(VERBOO_COMPAT);
		}
		const deepseek = models.find((model) => model.id === "deepseek-v4-flash")!;
		expect(deepseek.thinkingLevelMap?.high).toBe("high");
		expect(deepseek.thinkingLevelMap?.max).toBe("max");
		expect(deepseek.thinkingLevelMap?.off).toBeNull();

		const mimo = models.find((model) => model.id === "mimo-v2.5")!;
		expect(mimo.reasoning).toBe(false);
		expect("thinkingLevelMap" in mimo).toBe(false);
	});

	test("toModel sets thinkingLevelMap only when the entry has one, as a copy", () => {
		const withMap = VERBOO_GENERATED_MODELS.find((entry) => entry.id === "deepseek-v4-flash")!;
		const model = toModel(withMap, SOURCE);
		expect(model.thinkingLevelMap).toEqual(withMap.thinkingLevelMap);
		model.thinkingLevelMap!.off = "mutated";
		expect(withMap.thinkingLevelMap!.off).toBeNull();

		const noMap = VERBOO_GENERATED_MODELS.find((entry) => entry.id === "mimo-v2.5")!;
		expect("thinkingLevelMap" in toModel(noMap, SOURCE)).toBe(false);
	});
});

describe("listLiveModels", () => {
	test("parses Verboo's real capability rows", async () => {
		const rows = await listLiveModels({ baseUrl: SOURCE.baseUrl, apiKey: "k", fetchImpl: jsonFetch(VERBOO_PAYLOAD) });
		expect(rows).toBeDefined();
		expect(rows!.map((row) => row.id)).toEqual(["deepseek-v4-flash", "qwen3.8-27b"]);
		expect(rows![0]).toEqual({
			id: "deepseek-v4-flash",
			contextWindow: 1_048_576,
			vision: false,
			reasoning: { effortLevels: ["high", "max"], defaultEffort: "high" },
		});
		expect(rows![1]!.contextWindow).toBe(262_144);
		expect(rows![1]!.vision).toBe(true);
	});

	test("returns undefined on non-OK, malformed, empty, or unsupported payloads", async () => {
		const options = { baseUrl: SOURCE.baseUrl, apiKey: "k" };
		expect(await listLiveModels({ ...options, fetchImpl: jsonFetch(VERBOO_PAYLOAD, 500) })).toBeUndefined();
		expect(await listLiveModels({ ...options, fetchImpl: textFetch("not json") })).toBeUndefined();
		expect(await listLiveModels({ ...options, fetchImpl: jsonFetch({ data: [] }) })).toBeUndefined();
		expect(await listLiveModels({ ...options, fetchImpl: jsonFetch({ object: "list" }) })).toBeUndefined();
		expect(await listLiveModels({ ...options, fetchImpl: jsonFetch([{ nope: true }]) })).toBeUndefined();
	});

	test("returns undefined on timeout instead of hanging", async () => {
		const rows = await listLiveModels({
			baseUrl: SOURCE.baseUrl,
			apiKey: "k",
			fetchImpl: hangingFetch(),
			timeoutMs: 5,
		});
		expect(rows).toBeUndefined();
	});
});

describe("mergeLiveWithGenerated", () => {
	const live = [
		{ id: "deepseek-v4-flash" },
		{
			id: "brand-new-model",
			contextWindow: 32_000,
			vision: true,
			reasoning: { effortLevels: ["low", "high"] },
		},
	];

	test("known ids keep generated capabilities; unknown ids get conservative limits", () => {
		const merged = mergeLiveWithGenerated(live, SOURCE);
		expect(merged.matched).toEqual(["deepseek-v4-flash"]);
		expect(merged.unknown).toEqual(["brand-new-model"]);

		const known = merged.models.find((model) => model.id === "deepseek-v4-flash")!;
		expect(known.maxTokens).toBe(65_536);
		expect(known.compat).toEqual(VERBOO_COMPAT);
		expect(known.thinkingLevelMap?.high).toBe("high");

		const unknown = merged.models.find((model) => model.id === "brand-new-model")!;
		expect(unknown.maxTokens).toBe(UNKNOWN_MODEL_LIMITS.maxTokens);
		expect(unknown.contextWindow).toBe(32_000);
		expect(unknown.input).toEqual(["text", "image"]);
		expect(unknown.reasoning).toBe(true);
		expect(unknown.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	test("an uncatalogued entry carries an explicit provenance note", () => {
		const entry = entryFromLiveCapability(live[1]!);
		expect(entry.maxTokens).toBe(UNKNOWN_MODEL_LIMITS.maxTokens);
		expect(entry.notes).toBeDefined();
		expect(entry.notes!.some((note) => note.includes("Not present in the generated catalog"))).toBe(true);
		expect(entry.notes!.some((note) => note.includes(String(UNKNOWN_MODEL_LIMITS.maxTokens)))).toBe(true);
	});
});

describe("resolveCatalog", () => {
	test("falls back to the generated baseline when the live fetch fails", async () => {
		const resolved = await resolveCatalog(SOURCE, { apiKey: "k", fetchImpl: jsonFetch({}, 500) });
		expect(resolved.liveIds).toBeUndefined();
		expect(resolved.unknownIds).toEqual([]);
		expect(resolved.models.length).toBe(VERBOO_GENERATED_MODELS.length);
		expect(resolved.models.map((model) => model.id)).toEqual([...GENERATED_CATALOG_META.models]);
	});

	test("a successful live fetch is authoritative and merges capabilities", async () => {
		const resolved = await resolveCatalog(SOURCE, { apiKey: "k", fetchImpl: jsonFetch(VERBOO_PAYLOAD) });
		expect([...(resolved.liveIds ?? [])]).toEqual(["deepseek-v4-flash", "qwen3.8-27b"]);
		expect(resolved.unknownIds).toEqual([]);
		expect(resolved.models.length).toBe(2);
		expect(resolved.models.find((model) => model.id === "deepseek-v4-flash")!.maxTokens).toBe(65_536);
		expect(resolved.models.find((model) => model.id === "qwen3.8-27b")!.contextWindow).toBe(262_144);
	});

	test("an uncatalogued live id survives with conservative limits and is reported", async () => {
		const payload = { data: [{ id: "surprise-model", context_window: 8_192, vision: false }] };
		const resolved = await resolveCatalog(SOURCE, { apiKey: "k", fetchImpl: jsonFetch(payload) });
		expect(resolved.unknownIds).toEqual(["surprise-model"]);
		const model = resolved.models[0]!;
		expect(model.maxTokens).toBe(UNKNOWN_MODEL_LIMITS.maxTokens);
		expect(model.contextWindow).toBe(8_192);
		expect(model.input).toEqual(["text"]);
	});
});
