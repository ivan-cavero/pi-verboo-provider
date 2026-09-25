/**
 * Verboo-aware error classification.
 *
 * Verboo documents and structures its errors (https://code.verboo.ai/en/docs/api/errors),
 * unlike the opaque gateway the reference package had to work around. That
 * lets this module map a documented status/code to either a pi-recognized
 * context-overflow error (so pi compacts and retries) or an actionable message
 * that names the cause and the fix.
 *
 * Documented contract implemented here:
 *   400 invalid request · 401 invalid key · 402 insufficient prepaid balance ·
 *   403 feature/access not allowed · 404 model not found for the key ·
 *   413 payload exceeds the limit · 428 terms acceptance required ·
 *   429 rate limited (retryable; the retry delay is surfaced when the body
 *   carries one) · 500/502/503 transient (retryable).
 *
 * Structured bodies this module understands:
 *   {"error":"invalid API key"}
 *   {"error":"structured output is not enabled for this plan","code":"structured_output_not_enabled"}
 *   {"error":"terms_acceptance_required","version":"2026-08","acceptUrl":"https://code.verboo.ai/pt/terms/accept"}
 *   {"error":"upstream unavailable"}            (measured for 502)
 *
 * pi-ai wraps provider errors as `"<status>: <body>"` in
 * `message.errorMessage`; the parser matches with and without that wrapper.
 *
 * Conservative rule (same as the reference): a `400` that is NOT over-window
 * is left untouched (`undefined`), so an unrelated validation error is never
 * relabelled as a context overflow. The `500`/`502`/`503` transient class is
 * never treated as overflow either — retry beats compaction there.
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ProviderStreams,
} from "@earendil-works/pi-ai";

/** Characters per token used for the request-size estimate (the issue's offline ratio). */
export const ESTIMATED_CHARS_PER_TOKEN = 3.47;

/**
 * The literal phrase pi-ai's `isContextOverflow` recognizes. Every overflow
 * message this module produces contains it inside an
 * `... maximum context length of <n> tokens ...` clause so pi's matcher fires.
 */
export const VERBOO_OVERFLOW_PHRASE = "exceeds the model's maximum context length";

export type VerbooErrorKind =
	| "overflow"
	| "terms"
	| "access"
	| "balance"
	| "model"
	| "rate_limit"
	| "transient"
	| "unknown";

export interface VerbooErrorClassification {
	kind: VerbooErrorKind;
	/** Actionable, pi-compatible replacement for `message.errorMessage`. */
	message: string;
}

export interface ClassifyVerbooErrorInput {
	/** The provider error text, with or without pi-ai's `"<status>: <body>"` wrapper. */
	errorMessage: string;
	/** The model the request targeted; supplies `contextWindow` for the overflow check. */
	model?: { contextWindow?: number };
	/** Estimated input tokens of the request that produced the error. */
	estimatedInputTokens?: number;
}

/**
 * Estimate the input tokens of an outgoing request from its character size.
 * Accepts the raw `Context` shape (`systemPrompt`/`messages`/`tools`) and the
 * normalized `TranscriptContext` (which only carries `messages`). Returns 0
 * when the context cannot be serialized.
 */
export interface TokenEstimateContext {
	systemPrompt?: string;
	messages?: unknown;
	tools?: unknown;
}

export function estimateRequestTokens(context: TokenEstimateContext | undefined): number {
	if (!context) return 0;
	const systemChars = typeof context.systemPrompt === "string" ? context.systemPrompt.length : 0;
	const total = systemChars + safeJsonLength(context.tools) + safeJsonLength(context.messages);
	if (!Number.isFinite(total) || total <= 0) return 0;
	return Math.ceil(total / ESTIMATED_CHARS_PER_TOKEN);
}

function safeJsonLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (Array.isArray(value) && value.length === 0) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Short, key-free rendering of the original provider error. */
function originalSnippet(original: string): string {
	const flat = original.replace(/\s+/g, " ").trim();
	return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

const STATUS_WRAPPER = /^\s*(\d{3})\s*:\s*([\s\S]*)$/;

interface ParsedError {
	status?: number;
	body: Record<string, unknown> | undefined;
	code: string | undefined;
	errorText: string | undefined;
	acceptUrl: string | undefined;
	version: string | undefined;
	retryAfter: string | undefined;
}

/** Parse the JSON body, tolerating a JSON object embedded in surrounding text. */
function parseJsonBody(bodyText: string): Record<string, unknown> | undefined {
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	const candidates = [trimmed];
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

function stringField(body: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!body) return undefined;
	for (const key of keys) {
		const value = body[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function parseError(errorMessage: string): ParsedError {
	const match = errorMessage.match(STATUS_WRAPPER);
	const status = match ? Number(match[1]) : undefined;
	const bodyText = match ? (match[2] ?? "") : errorMessage;
	const body = parseJsonBody(bodyText);
	return {
		status,
		body,
		code: stringField(body, "code"),
		errorText: stringField(body, "error", "message"),
		acceptUrl: stringField(body, "acceptUrl", "accept_url"),
		version: stringField(body, "version"),
		retryAfter: stringField(body, "retry_after", "retryAfter", "retry-after"),
	};
}

function overflowMessage(parsed: ParsedError, original: string, contextWindow: number | undefined, estimatedInputTokens: number | undefined): string {
	// pi-ai's matcher needs a number after the phrase; Prefer the window, then
	// the estimate. The `0` fallback is only reachable for a 413 with no model
	// window and no estimate, and is a matcher token, not a capability claim.
	const limit = contextWindow && contextWindow > 0 ? contextWindow : estimatedInputTokens && estimatedInputTokens > 0 ? estimatedInputTokens : 0;
	const estimated = estimatedInputTokens && estimatedInputTokens > 0 ? Math.ceil(estimatedInputTokens) : 0;
	const detail = parsed.status === 413 ? "HTTP 413 payload exceeds the limit" : `HTTP ${parsed.status ?? "error"}`;
	return (
		`Requested token count ${VERBOO_OVERFLOW_PHRASE} of ${limit} tokens ` +
		`(estimated ${estimated} input tokens; provider answered ${detail}). ` +
		`Verboo did not name the overflow, so the context must be compacted before retrying. ` +
		`Original provider error: ${originalSnippet(original)}`
	);
}

/** Classify by documented HTTP status. `undefined` = leave the error untouched. */
function classifyByStatus(
	status: number,
	parsed: ParsedError,
	original: string,
	contextWindow: number | undefined,
	estimatedInputTokens: number | undefined,
): VerbooErrorClassification | undefined {
	const snippet = originalSnippet(original);
	const detail = parsed.errorText ?? parsed.code;
	switch (status) {
		case 400: {
			const overWindow =
				typeof contextWindow === "number" &&
				contextWindow > 0 &&
				typeof estimatedInputTokens === "number" &&
				Number.isFinite(estimatedInputTokens) &&
				estimatedInputTokens > contextWindow;
			// Conservative rule: only an over-window 400 is an overflow. Any other
			// 400 is unrelated and must not be relabelled.
			return overWindow
				? { kind: "overflow", message: overflowMessage(parsed, original, contextWindow, estimatedInputTokens) }
				: undefined;
		}
		case 413:
			return { kind: "overflow", message: overflowMessage(parsed, original, contextWindow, estimatedInputTokens) };
		case 402:
			return {
				kind: "balance",
				message:
					`Verboo rejected the request because the prepaid balance is insufficient (HTTP 402${detail ? `: ${detail}` : ""}). ` +
					`Add credit to your Verboo account; the fix is balance, not the catalog. You can still list models with GET /models. ` +
					`Original provider error: ${snippet}`,
			};
		case 403:
		case 401:
			return {
				kind: "access",
				message:
					`Verboo denied access to the request (HTTP ${status}${detail ? `: ${detail}` : ": feature or access not allowed"}). ` +
					`Check that VERBOO_API_KEY is valid and that your plan includes this feature, then list the models your key can use with GET /models. ` +
					`Original provider error: ${snippet}`,
			};
		case 404:
			return {
				kind: "model",
				message:
					`Verboo does not serve this model for your key (HTTP 404${detail ? `: ${detail}` : ": model not found"}). ` +
					`Refresh the catalog with GET /models and choose a model id it lists. ` +
					`Original provider error: ${snippet}`,
			};
		case 429:
			return {
				kind: "rate_limit",
				message:
					`Verboo rate-limited the request (HTTP 429${parsed.retryAfter ? `, retry after ${parsed.retryAfter}` : ""}). ` +
					`The request is safe to retry after the server's rate-limit window. ` +
					`Original provider error: ${snippet}`,
			};
		case 500:
		case 502:
		case 503:
			return {
				kind: "transient",
				message:
					`Verboo returned a transient server error (HTTP ${status}${detail ? `: ${detail}` : ""}). ` +
					`Retry shortly; if it persists, check your plan and balance. ` +
					`Original provider error: ${snippet}`,
			};
		default:
			return {
				kind: "unknown",
				message: `Verboo returned an unrecognized error (HTTP ${status}). Original provider error: ${snippet}`,
			};
	}
}

/**
 * Classify a provider error message into a documented Verboo kind, or
 * `undefined` when no rule applies (never mislabel).
 */
export function classifyVerbooError(
	input: ClassifyVerbooErrorInput,
): VerbooErrorClassification | undefined {
	const original = input.errorMessage;
	if (typeof original !== "string" || original.trim().length === 0) return undefined;

	const parsed = parseError(original);
	const contextWindow = input.model?.contextWindow;
	const estimated = input.estimatedInputTokens;
	const code = (parsed.code ?? "").toLowerCase();
	const errorText = (parsed.errorText ?? "").toLowerCase();

	// Terms is status-or-signal based: it can arrive as 428 or as a body
	// (`error: "terms_acceptance_required"`, optionally with acceptUrl/version).
	if (
		parsed.status === 428 ||
		code.includes("terms") ||
		errorText.includes("terms_acceptance") ||
		errorText.includes("terms acceptance")
	) {
		const snippet = originalSnippet(original);
		return {
			kind: "terms",
			message:
				`Verboo requires accepting its terms before this request can proceed` +
				`${parsed.status ? ` (HTTP ${parsed.status})` : ""}` +
				`${parsed.version ? `, terms version ${parsed.version}` : ""}. ` +
				`Accept them at ${parsed.acceptUrl ?? "https://code.verboo.ai/ (no acceptUrl was returned)"}. ` +
				`Original provider error: ${snippet}`,
		};
	}

	if (parsed.status !== undefined) {
		return classifyByStatus(parsed.status, parsed, original, contextWindow, estimated);
	}

	// No HTTP status in the message: recognize the documented structured bodies
	// so a body-only error is still actionable. Everything else stays untouched.
	if (
		errorText.includes("invalid api key") ||
		code === "structured_output_not_enabled" ||
		errorText.includes("not enabled for this plan")
	) {
		return {
			kind: "access",
			message:
				`Verboo denied access to the request (${parsed.errorText ?? parsed.code ?? "invalid API key or disabled feature"}). ` +
				`Check that VERBOO_API_KEY is valid and that your plan includes this feature, then list the models your key can use with GET /models. ` +
				`Original provider error: ${originalSnippet(original)}`,
		};
	}

	return undefined;
}

/**
 * Rewrite a terminal assistant error in place when a classification applies.
 * Returns the same message object (or `undefined`) so the `error` event and
 * `result()` observe identical state.
 */
export function classifyVerbooErrorMessage(
	message: AssistantMessage | undefined,
	model: { contextWindow?: number } | undefined,
	estimatedInputTokens: number,
): AssistantMessage | undefined {
	if (!message || message.stopReason !== "error" || typeof message.errorMessage !== "string") {
		return message;
	}
	const classification = classifyVerbooError({
		errorMessage: message.errorMessage,
		model,
		estimatedInputTokens,
	});
	// `unknown` has no actionable rewrite; keep the original provider text.
	if (!classification || classification.kind === "unknown") return message;
	message.errorMessage = classification.message;
	return message;
}

/**
 * Wrap a provider stream so its terminal error is classified against the size
 * of the request that produced it. The rewritten message is memoized on the
 * `result()` promise and applied to iterated `error` steps, so consumers that
 * `await result()` and consumers that iterate agree.
 */
export function classifyStreamVerbooError(
	stream: AssistantMessageEventStream,
	model: { contextWindow?: number } | undefined,
	estimatedInputTokens: number,
): AssistantMessageEventStream {
	const rewrite = (message: AssistantMessage | undefined): AssistantMessage | undefined =>
		classifyVerbooErrorMessage(message, model, estimatedInputTokens);
	const resultPromise = stream.result().then(rewrite);

	return new Proxy(stream, {
		get(target, property, receiver) {
			if (property === "result") return () => resultPromise;
			if (property === Symbol.asyncIterator) {
				return () => {
					const iterator = target[Symbol.asyncIterator]();
					return {
						async next() {
							const step = await iterator.next();
							if (!step.done && step.value?.type === "error") rewrite(step.value.error);
							return step;
						},
						async return(value?: unknown) {
							return iterator.return ? iterator.return(value) : { done: true, value };
						},
						async throw(error?: unknown) {
							if (iterator.throw) return iterator.throw(error);
							throw error;
						},
						[Symbol.asyncIterator]() {
							return this;
						},
					};
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as AssistantMessageEventStream;
}

/**
 * Wrap every `stream`/`streamSimple` call so a documented Verboo error is
 * surfaced as a pi-actionable classification (overflow → compact + retry;
 * others → named cause and fix).
 */
export function withVerbooErrorClassification(api: ProviderStreams): ProviderStreams {
	return {
		...api,
		stream: (model, context, options) =>
			classifyStreamVerbooError(api.stream(model, context, options), model, estimateRequestTokens(context)),
		streamSimple: (model, context, options) =>
			classifyStreamVerbooError(
				api.streamSimple(model, context, options),
				model,
				estimateRequestTokens(context),
			),
	};
}
