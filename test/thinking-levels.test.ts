/**
 * The per-model thinking-level table from odd/tasks/verboo-pi-provider.md.
 *
 * Regression guard for the trap in pi-ai's `getSupportedThinkingLevels`:
 * every level except `xhigh`/`max` is considered SUPPORTED when the map key is
 * simply OMITTED. So an unsupported level must be an explicit `null`, never an
 * omitted key — otherwise Verboo would be offered an effort it does not accept.
 */

import { describe, expect, test } from "bun:test";
import {
	supportedThinkingLevels,
	thinkingLevelMapFromEfforts,
	type PiThinkingLevel,
} from "../src/thinking-levels.ts";

interface Row {
	id: string;
	efforts: readonly string[] | undefined;
	reasoning: boolean;
	map: Record<string, string | null> | undefined;
	levels: PiThinkingLevel[];
}

const TABLE: Row[] = [
	{
		id: "deepseek-v4-flash",
		efforts: ["high", "max"],
		reasoning: true,
		map: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		levels: ["high", "max"],
	},
	{
		id: "deepseek-v4-flash-0731",
		efforts: ["high", "max", "low", "medium", "xhigh"],
		reasoning: true,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		levels: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		id: "deepseek-v4.1-flash",
		efforts: ["low", "high", "xhigh", "max"],
		reasoning: true,
		map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: "max" },
		levels: ["low", "high", "xhigh", "max"],
	},
	{
		id: "glm-5.3-flash",
		efforts: ["low", "high", "max"],
		reasoning: true,
		map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		levels: ["low", "high", "max"],
	},
	{
		id: "mimo-v2.5",
		efforts: undefined,
		reasoning: false,
		map: undefined,
		levels: ["off"],
	},
	{
		id: "qwen3.8-27b",
		efforts: ["low", "medium", "xhigh", "none"],
		reasoning: true,
		map: { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
		levels: ["off", "low", "medium", "xhigh"],
	},
];

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

describe("thinkingLevelMapFromEfforts", () => {
	for (const row of TABLE) {
		test(`${row.id}: exact map`, () => {
			expect(thinkingLevelMapFromEfforts(row.efforts) ?? undefined).toEqual(row.map);
		});
	}

	test("returns undefined for undefined or empty efforts", () => {
		expect(thinkingLevelMapFromEfforts(undefined)).toBeUndefined();
		expect(thinkingLevelMapFromEfforts([])).toBeUndefined();
	});
});

describe("supportedThinkingLevels matches the task table", () => {
	for (const row of TABLE) {
		test(`${row.id} -> ${row.levels.join(",")}`, () => {
			expect(supportedThinkingLevels(row.efforts, row.reasoning)).toEqual(row.levels);
		});
	}

	test("a non-reasoning model is off-only even with declared efforts", () => {
		expect(supportedThinkingLevels(["low", "high"], false)).toEqual(["off"]);
	});
});

describe("off maps to Verboo none only where none is declared", () => {
	for (const row of TABLE) {
		if (!row.reasoning) continue;
		test(`${row.id}: off = ${row.id === "qwen3.8-27b" ? "none" : "null"}`, () => {
			const map = thinkingLevelMapFromEfforts(row.efforts)!;
			expect(map.off).toBe(row.id === "qwen3.8-27b" ? "none" : null);
		});
	}
});

describe("unsupported non-xhigh/max levels are explicit nulls, never omitted", () => {
	for (const row of TABLE) {
		if (!row.reasoning) continue;
		test(`${row.id}: every non-xhigh/max level has a key`, () => {
			const map = thinkingLevelMapFromEfforts(row.efforts)!;
			for (const level of PI_LEVELS) {
				if (level === "xhigh" || level === "max") continue;
				expect(Object.prototype.hasOwnProperty.call(map, level)).toBe(true);
				expect(map[level]).toBe(row.map![level] ?? null);
			}
		});
	}
});
