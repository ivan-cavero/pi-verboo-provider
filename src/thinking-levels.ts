/**
 * Verboo effort levels -> pi thinking-level map.
 *
 * Verboo's `/models` endpoint declares, per model, the reasoning efforts it
 * accepts (`reasoning.effort_levels`) plus a `reasoning.default_effort`. Pi
 * models a smaller, fixed vocabulary: `off | minimal | low | medium | high |
 * xhigh | max` (default `medium`). The two vocabularies overlap but are not
 * identical — Verboo uses `none` where pi uses `off`, and only some models
 * accept `xhigh`/`max`.
 *
 * Why this module exists (and why it always emits explicit `null`s):
 * pi-ai's `getSupportedThinkingLevels(model)` (dist/models.js, 0.87.1) filters
 * the pi levels with these rules:
 *
 *   - `reasoning: false`                 -> the only supported level is `off`;
 *   - `thinkingLevelMap[level] === null` -> the level is unsupported;
 *   - `xhigh` / `max`                    -> supported only when the map holds a
 *                                           DEFINED entry (a value, not
 *                                           `undefined`);
 *   - every other level (`off`, `minimal`, `low`, `medium`, `high`) is treated
 *     as SUPPORTED when the key is simply omitted.
 *
 * That last rule is the trap: a pi level we do not mention would be offered to
 * the model even though Verboo declares no matching effort. So the map this
 * module produces always contains an explicit `null` for every unsupported pi
 * level; a `null` (not an omission) is the only reliable "unsupported" signal.
 *
 * Mapping rule:
 *   - Verboo `none`          -> pi `off` when declared;
 *   - any other Verboo effort -> the pi level of the same name when declared;
 *   - a pi level with no matching declared effort -> `null` (unsupported).
 *
 * The module is pure and dependency-free (the only import is a type), so it is
 * unit-testable without pi-ai or the network.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Pi thinking levels in pi-ai's own `EXTENDED_THINKING_LEVELS` order. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** Verboo's disable-reasoning effort. It is not a pi level; it maps to `off`. */
const VERBOO_NONE_EFFORT = "none";

/** Pi level that Verboo's `none` effort maps to. */
const PI_OFF_LEVEL = "off";

/**
 * Build a pi-ai `ThinkingLevelMap` from a model's declared Verboo effort
 * levels. Returns `undefined` when no efforts are declared (the map is then
 * meaningless — callers must not invent one).
 *
 * Every pi level gets an explicit entry. Unsupported levels get `null`, never
 * an omitted key (see the module header for why).
 */
export function thinkingLevelMapFromEfforts(
	efforts: readonly string[] | undefined,
): ThinkingLevelMap | undefined {
	if (!efforts || efforts.length === 0) return undefined;

	const declared = new Set(efforts);
	const map: ThinkingLevelMap = {};

	for (const level of PI_THINKING_LEVELS) {
		if (level === PI_OFF_LEVEL) {
			map[level] = declared.has(VERBOO_NONE_EFFORT) ? VERBOO_NONE_EFFORT : null;
			continue;
		}
		map[level] = declared.has(level) ? level : null;
	}

	return map;
}

/**
 * The pi thinking levels a model actually supports, mirroring pi-ai's
 * `getSupportedThinkingLevels` semantics exactly:
 *
 *   - `reasoning: false` -> `["off"]` (Verboo's `none` is not required for
 *     `off`; pi treats a non-reasoning model as off-only);
 *   - otherwise filter `PI_THINKING_LEVELS`: a `null` map entry is excluded,
 *     `xhigh`/`max` are included only with a defined entry, and a level with
 *     no declared effort is `null` in the generated map, so it is excluded.
 */
export function supportedThinkingLevels(
	efforts: readonly string[] | undefined,
	reasoning: boolean,
): PiThinkingLevel[] {
	if (!reasoning) return [PI_OFF_LEVEL];

	const map = thinkingLevelMapFromEfforts(efforts);
	return PI_THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}
