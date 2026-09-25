/**
 * Live compatibility probe for the Verboo Code router.
 *
 * Purpose: replace assumptions with measurements for the compat flags and the
 * output-token caps that Verboo's published contract leaves undefined. Every
 * flag this package ships should cite either the Verboo docs or a result in
 * scripts/probe-report.json.
 *
 * Usage:  VERBOO_API_KEY=... bun run scripts/probe-verboo.ts
 * Output: scripts/probe-report.json  (committed as evidence)
 *
 * The key is read from the environment only and is never written to any file.
 */

const BASE_URL = "https://code.verboo.ai/router/v1";
const API_KEY = process.env.VERBOO_API_KEY;
const REPORT_PATH = new URL("./probe-report.json", import.meta.url).pathname;
const TIMEOUT_MS = 45_000;

if (!API_KEY) {
	console.error("VERBOO_API_KEY is not set. Refusing to probe without a key.");
	process.exit(2);
}

interface ProbeResult {
	name: string;
	model: string;
	request: Record<string, unknown>;
	status: number;
	ok: boolean;
	/** Short, key-free rendering of the response or error. */
	observed: string;
}

async function post(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${API_KEY}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return { status: response.status, text: await response.text() };
	} catch (error) {
		return { status: 0, text: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/** Collapse a response body to a short, single-line observation. */
function summarize(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

async function probe(name: string, model: string, body: Record<string, unknown>): Promise<ProbeResult> {
	const request = { model, ...body };
	const { status, text } = await post(request);
	const result: ProbeResult = { name, model, request, status, ok: status >= 200 && status < 300, observed: summarize(text) };
	console.log(`  ${result.ok ? "ok  " : "FAIL"} ${status.toString().padStart(3)} ${name} (${model})`);
	return result;
}

/** The behavior probes; each answers exactly one compat question. */
async function behaviorProbes(model: string): Promise<ProbeResult[]> {
	const ping = [{ role: "user", content: "ping" }];
	return [
		await probe("baseline", model, { messages: ping, max_tokens: 1 }),
		await probe("stream_usage", model, {
			messages: ping,
			max_tokens: 1,
			stream: true,
			stream_options: { include_usage: true },
		}),
		await probe("stream_without_usage_option", model, { messages: ping, max_tokens: 1, stream: true }),
		await probe("developer_role", model, {
			messages: [{ role: "developer", content: "be terse" }, ...ping],
			max_tokens: 1,
		}),
		await probe("tools_empty", model, { messages: ping, max_tokens: 1, tools: [] }),
		await probe("unknown_fields", model, {
			messages: ping,
			max_tokens: 1,
			store: false,
			reasoning_details: [],
			made_up_field_for_probe: true,
		}),
		await probe("reasoning_effort_max", model, { messages: ping, max_tokens: 1, reasoning_effort: "max" }),
		await probe("replay_reasoning_content", model, {
			messages: [
				{ role: "assistant", content: "a", reasoning_content: "prior private reasoning" },
				ping[0],
			],
			max_tokens: 1,
		}),
	];
}

/** Find the largest accepted max_tokens by descending through candidates. */
const MAX_TOKEN_CANDIDATES = [262_144, 131_072, 65_536, 32_768];

async function outputCapProbe(model: string): Promise<{ model: string; acceptedMaxTokens: number | null; probes: ProbeResult[] }> {
	const probes: ProbeResult[] = [];
	for (const candidate of MAX_TOKEN_CANDIDATES) {
		const result = await probe(`max_tokens_${candidate}`, model, {
			messages: [{ role: "user", content: "ping" }],
			max_tokens: candidate,
		});
		probes.push(result);
		if (result.ok) return { model, acceptedMaxTokens: candidate, probes };
	}
	return { model, acceptedMaxTokens: null, probes };
}

async function listModelIds(): Promise<string[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`/models failed with ${response.status}`);
	const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
	return (payload.data ?? [])
		.map((row) => (typeof row.id === "string" ? row.id : ""))
		.filter((id) => id.length > 0);
}

async function main(): Promise<void> {
	console.log("Listing models…");
	const ids = await listModelIds();
	console.log(`Found ${ids.length} models: ${ids.join(", ")}\n`);

	console.log("Behavior probes (representative model: deepseek-v4-flash):");
	const behavior = await behaviorProbes(ids[0] ?? "deepseek-v4-flash");

	console.log("\nOutput-token cap probes (first accepted candidate per model):");
	const caps: Array<{ model: string; acceptedMaxTokens: number | null; probes: ProbeResult[] }> = [];
	for (const id of ids) caps.push(await outputCapProbe(id));

	const report = {
		source: `${BASE_URL}/chat/completions`,
		probedAt: new Date().toISOString(),
		modelIds: ids,
		behavior,
		outputCaps: caps,
	};
	await Bun.write(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\nWrote ${REPORT_PATH}`);
}

await main();
