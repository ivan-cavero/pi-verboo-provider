/**
 * MANUAL_OVERRIDES — build-time corrections applied over the live Verboo
 * `/models` data by `scripts/generate-catalog.ts` before emitting
 * `src/catalog.generated.ts`.
 *
 * Verboo's `/models` returns `context_window`, `vision`, and
 * `reasoning.effort_levels`/`default_effort`, but NOT the output-token cap,
 * pricing, or a display name. Those are the only unknowns; record curated
 * values here instead of hand-editing the generated file.
 *
 * Provenance rules (mirrors the task document):
 * - `note` is REQUIRED and must state where the value was confirmed (source
 *   and/or date) so it can be re-verified later.
 * - Never guess a number. If no confirmation source exists, leave the
 *   conservative default and say so in the note.
 * - An override may also act as a pin: a value kept so an upstream change
 *   cannot silently drop a confirmed choice. A pin's note must say it is a
 *   pin, never present it as a divergence.
 *
 * Fields override the live-derived entry one-for-one:
 * name, cost, maxTokens.
 */

export interface ManualModelOverride {
	/** Display name override (Verboo /models returns no display_name). */
	name?: string;
	/** Per-token cost override (USD/Mtok). */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Max output tokens override. */
	maxTokens?: number;
	/** Required provenance note; emitted verbatim onto the generated entry. */
	note: string;
}

/**
 * The shipped output-token cap is a conservative envelope, not a published
 * limit: Verboo never documents it. `scripts/probe-report.json` records the
 * measured headroom per model; `models.json` `modelOverrides` remains the
 * escape hatch for a user who needs the full window.
 */
const CONSERVATIVE_MAX_TOKENS = 65_536;

function outputCapNote(measured: string): string {
	return (
		`maxTokens ${CONSERVATIVE_MAX_TOKENS}: conservative envelope, NOT a published cap — ` +
		"Verboo /models returns no output-token limit and the docs do not publish one. " +
		`The probe measured ${measured} (scripts/probe-report.json, 2026-09-25). ` +
		`${CONSERVATIVE_MAX_TOKENS} is the value the maintainer's working OpenCode config already uses; ` +
		"models.json modelOverrides remains the escape hatch."
	);
}

export const MANUAL_OVERRIDES: Record<string, ManualModelOverride> = {
	"deepseek-v4-flash": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote("262144 accepted"),
	},
	"deepseek-v4-flash-0731": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote("262144 accepted"),
	},
	"deepseek-v4.1-flash": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote("262144 accepted"),
	},
	"glm-5.3-flash": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote("262144 accepted"),
	},
	"mimo-v2.5": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote("262144 accepted"),
	},
	"qwen3.8-27b": {
		maxTokens: CONSERVATIVE_MAX_TOKENS,
		note: outputCapNote(
			'262144 rejected upstream with 502 {"error":"upstream unavailable"} and 131072 accepted',
		),
	},
};
