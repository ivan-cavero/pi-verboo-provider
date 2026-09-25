#!/usr/bin/env bun
/**
 * Build-time generation of the Verboo fallback model catalog.
 *
 * Pulls capability data (context window, vision, reasoning effort levels) from
 * Verboo's own `/models` endpoint — the single source of truth, unlike NaN
 * which needs models.dev because its endpoint returns IDs only — and emits
 * `src/catalog.generated.ts`, which is committed and bundled into the package.
 *
 * Provenance rules (enforced, not decorative):
 * - Every emitted capability value must come from the live `/models` response,
 *   `scripts/probe-report.json`, or an explicit MANUAL_OVERRIDES note. Nothing
 *   is invented.
 * - The API key is read from `VERBOO_API_KEY` only; it is never written to a
 *   file or logged. A missing key or a failed fetch is fatal (non-zero exit) —
 *   the script never guesses capability data.
 * - `name` is derived from `id` because Verboo returns no `display_name`.
 * - `maxTokens`/`cost` are curated in `scripts/manual-overrides.ts`; unknown
 *   values fall back to the conservative `UNKNOWN_MODEL_LIMITS` with a note.
 * - `thinkingLevelMap` is derived per model from `effort_levels` by
 *   `src/thinking-levels.ts`.
 * - Every successful run also writes `scripts/models-capabilities.json`: the
 *   RAW `/models` rows exactly as received (with source URL and fetch time),
 *   so the `contextWindow`/`vision`/`effort_levels` values in the generated
 *   catalog are auditable from the repo (acceptance criterion #4).
 *
 * Reproducibility: the generated file records `fetchedAt`. A regeneration
 * reuses the existing `fetchedAt` when the catalog payload is otherwise
 * unchanged, so `bun run generate-catalog` is byte-for-byte idempotent. Set
 * `VERBOO_CATALOG_FETCHED_AT` to pin the value explicitly (verification/CI).
 *
 * Usage:  VERBOO_API_KEY=... bun run generate-catalog
 */

import {
	type GeneratedModelEntry,
	type LiveModelCapability,
	fetchLiveModelsSnapshot,
	UNKNOWN_MODEL_LIMITS,
	VERBOO_COMPAT,
} from "../src/catalog.ts";
import { thinkingLevelMapFromEfforts } from "../src/thinking-levels.ts";
import { MANUAL_OVERRIDES } from "./manual-overrides.ts";

const BASE_URL = "https://code.verboo.ai/router/v1";
const MODELS_SOURCE = `${BASE_URL}/models`;
const OUTPUT_PATH = new URL("../src/catalog.generated.ts", import.meta.url).pathname;
const CAPABILITIES_PATH = new URL("./models-capabilities.json", import.meta.url).pathname;
const FETCH_TIMEOUT_MS = 15_000;
const FETCHED_AT_PLACEHOLDER = "__VERBOO_FETCHED_AT__";
const FETCHED_AT_FIELD_PATTERN = /^(\s*fetchedAt:\s*")([^"]*)(")/m;
const FETCHED_AT_HEADER_PATTERN = /^(\/\/ Source:.*?,\s*fetched\s+)(\S+)(\s*)$/m;

/** Replace every occurrence of the `fetchedAt` value so two renders can be compared. */
function normalizeFetchedAt(content: string): string {
	return content
		.replace(FETCHED_AT_FIELD_PATTERN, `$1${FETCHED_AT_PLACEHOLDER}$3`)
		.replace(FETCHED_AT_HEADER_PATTERN, `$1${FETCHED_AT_PLACEHOLDER}$3`);
}

/**
 * Provenance-only notes for entries whose live data needs a recorded
 * explanation. Capability divergences/curation live in manual-overrides.ts.
 */
const CATALOG_NOTES: Record<string, string[]> = {
	"deepseek-v4.1-flash": [
		"Verboo /models reports vision:true for this model while the maintainer's working OpenCode config marked it text-only; the generated catalog follows Verboo (input includes image) and records the divergence for re-verification.",
	],
	"mimo-v2.5": [
		"Verboo /models declares no reasoning object for this model, yet live chat completions emit reasoning_content; the catalog stays honest to /models (reasoning:false, no thinkingLevelMap, pi offers only 'off') and records the inconsistency.",
	],
};

const META_NOTES: string[] = [
	"name is derived from id: Verboo /models returns no display_name.",
	"compat is the measured gateway behavior recorded in scripts/probe-report.json (2026-09-25): thinkingFormat openai, supportsReasoningEffort true, supportsDeveloperRole false, maxTokensField max_tokens, supportsFinishReason true, supportsUsageInStreaming true.",
	"cost is {0,0,0,0} for every model: Verboo publishes no pricing in /models (unknown, never invented).",
];

function fail(message: string): never {
	console.error(`generate-catalog: ${message}`);
	process.exit(1);
}

/** Build one generated entry from a live capability row, never guessing. */
function buildEntry(capability: LiveModelCapability): GeneratedModelEntry {
	const override = MANUAL_OVERRIDES[capability.id];

	if (capability.contextWindow === undefined) {
		fail(
			`model "${capability.id}": /models returned no context_window — refusing to guess a context window.`,
		);
	}
	if (typeof capability.vision !== "boolean") {
		fail(
			`model "${capability.id}": /models returned no vision flag — refusing to guess input modalities.`,
		);
	}

	const reasoning = capability.reasoning !== undefined;
	let thinkingLevelMap: GeneratedModelEntry["thinkingLevelMap"];
	if (reasoning) {
		const efforts = capability.reasoning?.effortLevels;
		if (!efforts || efforts.length === 0) {
			fail(
				`model "${capability.id}": /models declares reasoning but no effort_levels — cannot derive a thinking-level map without guessing.`,
			);
		}
		thinkingLevelMap = thinkingLevelMapFromEfforts(efforts);
		if (!thinkingLevelMap) {
			fail(`model "${capability.id}": failed to derive a thinking-level map from effort_levels.`);
		}
	}

	const maxTokens = override?.maxTokens ?? UNKNOWN_MODEL_LIMITS.maxTokens;
	const cost = override?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const notes: string[] = [];
	if (override) {
		notes.push(override.note);
	} else {
		notes.push(
			`maxTokens ${maxTokens}: conservative UNKNOWN_MODEL_LIMITS default — no manual override recorded and Verboo publishes no output cap; add an entry in scripts/manual-overrides.ts with a provenance note.`,
		);
	}
	notes.push(...(CATALOG_NOTES[capability.id] ?? []));

	return {
		id: capability.id,
		name: override?.name ?? capability.id,
		reasoning,
		input: capability.vision ? ["text", "image"] : ["text"],
		cost,
		contextWindow: capability.contextWindow,
		maxTokens,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		compat: { ...VERBOO_COMPAT },
		notes,
	};
}

/** Deterministic code-unit sort by id, so the emitted order never depends on endpoint ordering. */
function byId(a: GeneratedModelEntry, b: GeneratedModelEntry): number {
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

function renderCatalog(entries: readonly GeneratedModelEntry[], fetchedAt: string): string {
	const modelIds = entries.map((entry) => entry.id);
	return `// This file is auto-generated by scripts/generate-catalog.ts
// Do not edit manually — run \`bun run generate-catalog\` to update.
//
// Source: ${MODELS_SOURCE}, fetched ${fetchedAt}
// Verboo returns { data: [...] } with context_window, vision and
// reasoning.effort_levels/default_effort per model. It does NOT return
// display_name, an output-token cap, or pricing: name is derived from id,
// maxTokens comes from scripts/manual-overrides.ts, and cost is zero
// (unknown, never invented). thinkingLevelMap is derived per model from that
// model's effort_levels by src/thinking-levels.ts.

import type { GeneratedModelEntry } from "./catalog.ts";

export const VERBOO_GENERATED_MODELS: readonly GeneratedModelEntry[] = ${JSON.stringify(entries, null, "\t")};

export const GENERATED_CATALOG_META = {
	source: ${JSON.stringify(MODELS_SOURCE)},
	fetchedAt: ${JSON.stringify(fetchedAt)},
	modelCount: ${entries.length},
	models: ${JSON.stringify(modelIds)},
	notes: ${JSON.stringify(META_NOTES, null, "\t")},
} as const;
`;
}

/**
 * Resolve the `fetchedAt` recorded in the file: an explicit
 * `VERBOO_CATALOG_FETCHED_AT` pin wins; otherwise reuse the committed value
 * when the catalog payload is unchanged (idempotent regeneration); otherwise
 * use now.
 */
async function resolveFetchedAt(placeholderContent: string): Promise<string> {
	const pinned = process.env.VERBOO_CATALOG_FETCHED_AT;
	if (pinned) return pinned;

	const existing = await Bun.file(OUTPUT_PATH)
		.text()
		.catch(() => undefined);
	if (existing) {
		const match = existing.match(FETCHED_AT_FIELD_PATTERN);
		if (match && match[2] && normalizeFetchedAt(existing) === placeholderContent) {
			return match[2];
		}
	}

	return new Date().toISOString();
}

async function main(): Promise<void> {
	const apiKey = process.env.VERBOO_API_KEY;
	if (!apiKey) {
		fail(
			"VERBOO_API_KEY is not set. Refusing to generate the catalog without a key — capability data must never be guessed.",
		);
	}

	console.log(`Fetching model capabilities from ${MODELS_SOURCE}…`);
	const snapshot = await fetchLiveModelsSnapshot({ baseUrl: BASE_URL, apiKey, timeoutMs: FETCH_TIMEOUT_MS });
	if (!snapshot || snapshot.capabilities.length === 0) {
		fail(
			`failed to fetch or parse ${MODELS_SOURCE} — refusing to generate a catalog without live capability data.`,
		);
	}

	const entries = snapshot.capabilities.map(buildEntry).sort(byId);
	const fetchedAt = await resolveFetchedAt(renderCatalog(entries, FETCHED_AT_PLACEHOLDER));
	const content = renderCatalog(entries, fetchedAt);

	await Bun.write(OUTPUT_PATH, content);

	// Auditable provenance: persist the raw `/models` rows exactly as received
	// so every contextWindow/vision/effort_levels value in the catalog can be
	// checked against the source.
	const capabilitiesSnapshot = {
		source: MODELS_SOURCE,
		fetchedAt,
		modelCount: snapshot.rawRows.length,
		models: snapshot.rawRows,
	};
	await Bun.write(CAPABILITIES_PATH, `${JSON.stringify(capabilitiesSnapshot, null, 2)}\n`);

	console.log(
		`Wrote ${OUTPUT_PATH} (${entries.length} models: ${entries.map((entry) => entry.id).join(", ")})`,
	);
	console.log(`Wrote ${CAPABILITIES_PATH} (${snapshot.rawRows.length} raw rows)`);
	console.log(`Fetched at: ${fetchedAt}`);
}

await main();
