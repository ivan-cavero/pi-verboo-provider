/**
 * Documented Verboo status/code taxonomy, plus the stream `Proxy` contract:
 * a rewritten terminal error must be observed identically by `result()` and by
 * async iteration.
 */

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	classifyStreamVerbooError,
	classifyVerbooError,
	estimateRequestTokens,
	VERBOO_OVERFLOW_PHRASE,
} from "../src/verboo-errors.ts";

function classify(errorMessage: string, estimated?: number, contextWindow = 1_000) {
	return classifyVerbooError({ errorMessage, model: { contextWindow }, estimatedInputTokens: estimated });
}

describe("classifyVerbooError — documented statuses", () => {
	test("400 over-window is overflow and carries pi's recognized phrase", () => {
		const result = classify('400: {"error":"invalid request"}', 2_000);
		expect(result?.kind).toBe("overflow");
		expect(result!.message).toContain(VERBOO_OVERFLOW_PHRASE);
		expect(result!.message).toContain("of 1000 tokens");
	});

	test("400 within window is left untouched", () => {
		expect(classify('400: {"error":"invalid request"}', 100)).toBeUndefined();
	});

	test("413 is a genuine overflow without an estimate", () => {
		const result = classify("413: payload exceeds the limit");
		expect(result?.kind).toBe("overflow");
		expect(result!.message).toContain(VERBOO_OVERFLOW_PHRASE);
	});

	test("428 carries acceptUrl and version", () => {
		const result = classify(
			'428: {"error":"terms_acceptance_required","version":"2026-08","acceptUrl":"https://code.verboo.ai/pt/terms/accept"}',
		);
		expect(result?.kind).toBe("terms");
		expect(result!.message).toContain("https://code.verboo.ai/pt/terms/accept");
		expect(result!.message).toContain("2026-08");
	});

	test("402 names balance and the fix", () => {
		const result = classify('402: {"error":"insufficient prepaid balance"}');
		expect(result?.kind).toBe("balance");
		expect(result!.message.toLowerCase()).toContain("balance");
	});

	test("401 and 403 are access errors and name the fix", () => {
		for (const status of [401, 403]) {
			const result = classify(`${status}: {"error":"not allowed"}`);
			expect(result?.kind).toBe("access");
			expect(result!.message).toContain("GET /models");
		}
	});

	test("404 is a model error and points at the catalog", () => {
		const result = classify('404: {"error":"model not found"}');
		expect(result?.kind).toBe("model");
		expect(result!.message).toContain("GET /models");
	});

	test("429 is rate limited and mentions Retry-After", () => {
		const result = classify("429: slow down");
		expect(result?.kind).toBe("rate_limit");
		expect(result!.message).toContain("Retry-After");
	});

	test("500/502/503 are transient", () => {
		for (const status of [500, 502, 503]) {
			const result = classify(`${status}: {"error":"upstream unavailable"}`);
			expect(result?.kind).toBe("transient");
		}
	});

	test("an undocumented status is unknown", () => {
		const result = classify("418: teapot");
		expect(result?.kind).toBe("unknown");
	});

	test("a body-only structured error is still actionable", () => {
		expect(classify('{"error":"invalid API key"}')?.kind).toBe("access");
		expect(classify('{"error":"structured output is not enabled for this plan","code":"structured_output_not_enabled"}')?.kind).toBe(
			"access",
		);
	});

	test("empty or unparseable messages are untouched", () => {
		expect(classifyVerbooError({ errorMessage: "" })).toBeUndefined();
		expect(classify("just some text")).toBeUndefined();
	});
});

describe("estimateRequestTokens", () => {
	test("counts systemPrompt + tools + messages at chars/3.47", () => {
		const estimate = estimateRequestTokens({
			systemPrompt: "x".repeat(347),
			tools: [{ name: "t" }],
			messages: [{ role: "user", content: "y".repeat(347) }],
		});
		expect(estimate).toBeGreaterThanOrEqual(200);
	});

	test("returns 0 without a context", () => {
		expect(estimateRequestTokens(undefined)).toBe(0);
	});
});

function assistantMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "verboo",
		model: "deepseek-v4-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 1,
	} as unknown as AssistantMessage;
}

/** A minimal AssistantMessageEventStream that yields one terminal error. */
function errorStream(message: AssistantMessage): AssistantMessageEventStream {
	let consumed = false;
	const event = { type: "error", reason: "error", error: message } as const;
	return {
		result: async () => message,
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (consumed) return { done: true, value: undefined };
				consumed = true;
				return { done: false, value: event };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		}),
	} as unknown as AssistantMessageEventStream;
}

describe("the stream Proxy agrees across result() and async iteration", () => {
	test("an over-window 400 is rewritten identically on both paths", async () => {
		const wrapped = classifyStreamVerbooError(
			errorStream(assistantMessage('400: {"error":"invalid request"}')),
			{ contextWindow: 1_000 },
			2_000,
		);

		const final = await wrapped.result();
		expect(final.errorMessage).toContain(VERBOO_OVERFLOW_PHRASE);

		let iterated: AssistantMessage | undefined;
		for await (const event of wrapped) {
			if (event.type === "error") iterated = event.error;
		}
		expect(iterated?.errorMessage).toBe(final.errorMessage);
	});

	test("an unknown error is not rewritten", async () => {
		const original = "418: teapot";
		const wrapped = classifyStreamVerbooError(errorStream(assistantMessage(original)), { contextWindow: 1_000 }, 2_000);
		const final = await wrapped.result();
		expect(final.errorMessage).toBe(original);
	});
});
