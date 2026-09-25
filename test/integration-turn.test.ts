/**
 * End-to-end turn through the REAL pi-ai `openai-completions` adapter, driven
 * by the provider this package builds, against a mock SSE gateway.
 *
 * These assert observable behavior, not config values:
 *  - `reasoning_content` deltas become thinking blocks;
 *  - the terminal usage chunk becomes `message.usage`;
 *  - `finish_reason` is observed (stop) rather than inferred;
 *  - an over-window generic 400 is surfaced as a context-overflow error that
 *    pi-ai's own `isContextOverflow` recognizes (exported from the bare
 *    `@earendil-works/pi-ai` root in 0.87.1), so pi compacts and retries.
 *
 * No network: `fetch` is injected into the stream options.
 */

import { describe, expect, test } from "bun:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createVerbooProvider } from "../src/provider-factory.ts";
import { VERBOO_PROVIDER } from "../src/providers.ts";

type FetchImpl = typeof fetch;

function chunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, ...payload })}\n\n`;
}

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const value of chunks) controller.enqueue(encoder.encode(value));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

interface Gateway {
	fetchImpl: FetchImpl;
	lastBody: () => Record<string, unknown>;
}

/** A gateway that streams a reasoning + text turn with a terminal usage chunk. */
function okGateway(): Gateway {
	let body: Record<string, unknown> = {};
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(init?.body as string) as Record<string, unknown>;
		return sseResponse([
			chunk({
				model: "deepseek-v4-flash",
				choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Let me think." }, finish_reason: null }],
			}),
			chunk({
				model: "deepseek-v4-flash",
				choices: [{ index: 0, delta: { reasoning_content: " Then answer." }, finish_reason: null }],
			}),
			chunk({
				model: "deepseek-v4-flash",
				choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }],
			}),
			chunk({
				model: "deepseek-v4-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			chunk({
				model: "deepseek-v4-flash",
				choices: [],
				usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
			}),
			"data: [DONE]\n\n",
		]);
	}) as unknown as FetchImpl;
	return { fetchImpl, lastBody: () => body };
}

/** A gateway that always answers with a JSON error body. */
function failGateway(status: number, body: unknown): Gateway {
	let lastBody: Record<string, unknown> = {};
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		lastBody = JSON.parse(init?.body as string) as Record<string, unknown>;
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as FetchImpl;
	return { fetchImpl, lastBody: () => lastBody };
}

function contextOf(systemPrompt: string, messages: unknown[], tools: unknown[] = []): TranscriptContext {
	return { systemPrompt, messages, tools } as unknown as TranscriptContext;
}

async function runTurn(
	provider: Awaited<ReturnType<typeof createVerbooProvider>>,
	model: Model<"openai-completions">,
	context: TranscriptContext,
	gateway: Gateway,
): Promise<AssistantMessage> {
	const stream = provider.stream(model, context, { apiKey: "test-key", fetch: gateway.fetchImpl });
	for await (const _event of stream) {
		// consume to completion
	}
	return (await stream.result()) as AssistantMessage;
}

const GENERIC_400_BODY = {
	error: { message: "invalid request", type: "invalid_request_error", code: "invalid_request" },
};

describe("integration turn — mock SSE gateway", () => {
	test("reasoning, usage, and finish_reason are all observed", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER);
		const model = provider.getModels().find((candidate) => candidate.id === "deepseek-v4-flash")!;
		const gateway = okGateway();

		const final = await runTurn(provider, model, contextOf("You are terse.", [{ role: "user", content: "ping" }]), gateway);

		// compat.supportsUsageInStreaming is wired through to the request.
		expect(gateway.lastBody().stream_options).toEqual({ include_usage: true });

		expect(final.stopReason).toBe("stop");

		const thinking = final.content.find((block) => block.type === "thinking");
		expect(thinking && thinking.type === "thinking" ? thinking.thinking : undefined).toBe("Let me think. Then answer.");

		const text = final.content.find((block) => block.type === "text");
		expect(text && text.type === "text" ? text.text : undefined).toBe("pong");

		expect(final.usage.input).toBe(11);
		expect(final.usage.output).toBe(5);
		expect(final.usage.totalTokens).toBe(16);
	});

	test("an over-window generic 400 is surfaced as a context overflow", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER);
		const model = provider.getModels().find((candidate) => candidate.id === "qwen3.8-27b")!;
		const gateway = failGateway(400, GENERIC_400_BODY);

		const context = contextOf("", [{ role: "user", content: "x".repeat(1_200_000) }]);
		const final = await runTurn(provider, model, context, gateway);

		// The mock really did see an over-window body.
		expect(JSON.stringify(gateway.lastBody()).length / 3.47).toBeGreaterThan(model.contextWindow);

		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").toContain("exceeds the model's maximum context length");
		expect(isContextOverflow(final, model.contextWindow)).toBe(true);
	});

	test("a generic 400 within the window is NOT mislabelled as overflow", async () => {
		const provider = await createVerbooProvider(VERBOO_PROVIDER);
		const model = provider.getModels().find((candidate) => candidate.id === "deepseek-v4-flash")!;
		const gateway = failGateway(400, GENERIC_400_BODY);

		const final = await runTurn(provider, model, contextOf("hi", [{ role: "user", content: "hello" }]), gateway);

		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").toContain("invalid request");
		expect(isContextOverflow(final, model.contextWindow)).toBe(false);
	});
});
