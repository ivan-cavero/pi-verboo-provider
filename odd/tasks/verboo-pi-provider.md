# Feature: pi-verboo-provider

## Objective

Build `@ivan-cavero/pi-verboo-provider`, a Pi (earendil-works/pi) extension package that registers
**Verboo Code** as a first-class provider, based on the structure of `gtrabanco/pi-nan-provider`
but deliberately improved rather than copied.

## Problem

Verboo ships an official Pi integration, but it is **declarative only** (`~/.pi/agent/models.json`):
the user must hardcode model IDs, and nothing validates the model against the account key, exposes
reasoning-effort capability, or explains Verboo's structured errors. The reference package
(`pi-nan-provider`) solves the same problem for NaN but targets pi **0.84.4**, is coupled to
models.dev because NaN's `/models` returns IDs only, and carries an opaque-error workaround that
Verboo does not need.

## Why this design (evidence)

- **Pi installed is 0.87.1**, not 0.84.4. The bun-global `@earendil-works/*` copies are stale.
  Target the 0.87.1 extension API. Reference `devDependencies` pin 0.84.4 — do not copy that.
- **A "Pi plugin" is an extension**: default-exported factory `(pi: ExtensionAPI) => void|Promise<void>`
  plus `package.json` → `pi: { extensions: ["./src/index.ts"] }`. There is no `piPlugin` key and no
  global `pi`.
- **Verboo `/models` is capability-rich**, unlike NaN's: it returns `context_window`, `vision`, and
  `reasoning.effort_levels` + `default_effort`. So the offline fallback is generated from **Verboo's
  own endpoint** (single source of truth), not models.dev. `models.dev` has no Verboo provider at all.
- **Verboo `/models` does NOT return the output-token cap, `cost`, or `display_name`.** These are the
  only unknowns and must be curated (`scripts/manual-overrides.ts`) or measured (`scripts/probe-verboo.ts`).
- **Verboo effort levels are non-standard** (`xhigh`, `max`, `none`). Pi levels are
  `off | minimal | low | medium | high | xhigh | max` (default `medium`). Per pi-ai
  `getSupportedThinkingLevels()`, `xhigh`/`max` are only offered when `thinkingLevelMap` has a
  **defined** entry for them, and a `null` entry marks a level unsupported. Therefore the map must be
  computed **per model** from that model's `effort_levels` — this is the main functional improvement.
- **Verboo errors are documented and structured** (`402` balance, `403` access, `404` model, `413`
  payload, `428` terms with `acceptUrl`, `429` + `Retry-After`, codes like
  `structured_output_not_enabled`). This replaces nan's "generic 400 + over-window heuristic" with a
  real classifier keyed on documented signals.
- **Verboo has no MCP server** (integrations: Cursor, OpenCode, Pi, OpenClaw, Hermes), so nan's MCP
  bridges and `/nan-usage` are dropped. Scope decision: **provider core only** (user-selected).

## Scope

In scope: provider registration (native + legacy fallback), generated offline catalog, live `/models`
catalog merge + per-key filtering, per-model thinking-level mapping, documented error classification,
auth via `VERBOO_API_KEY` + `/login verboo`, unit + integration tests, README.

Out of scope: MCP bridges, quota/usage command, payload sanitizer (only if a probe proves Verboo needs
it), publishing to npm, CI release workflow, cross-model reasoning guard (see open question below).

## Constraints

- pi 0.87.1 API. `peerDependencies`: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  at `>=0.87.0 <1`. Runtime deps: none. Dev: bun types + typescript.
- Extensions must import **only the bare** `@earendil-works/pi-ai` root (subpaths break under pi's
  compat alias). Static and dynamic.
- Relative imports inside `src/` carry explicit `.ts` extensions (jiti loader).
- No secret may ever be written into a tracked file. The API key is read from `VERBOO_API_KEY` only.
- Never fabricate capability data: unknown ⇒ conservative placeholder + explicit note.

## Design

```
package.json          pi.extensions, peerDeps 0.87.x, scripts (probe/generate/test/typecheck)
tsconfig.json         strict, noUncheckedIndexedAccess, verbatimModuleSyntax, noEmit, bundler
bunfig.toml           preload test/network-guard.ts
src/providers.ts      VERBOO_PROVIDER = { id:"verboo", name:"Verboo Code",
                        baseUrl:"https://code.verboo.ai/router/v1", envVars:["VERBOO_API_KEY"] }
src/thinking-levels.ts  effort_levels -> Pi ThinkingLevelMap (per model); pure, unit-tested
src/catalog.ts        GeneratedModelEntry type, toModel(), baselineModels(), listLiveModels()
                        (tolerant of Verboo's real payload), merge, resolveCatalog, filter
src/verboo-errors.ts  documented status/code -> overflow + actionable message; pure, unit-tested
src/pi-ai-loader.ts   host-anchored openAICompletionsApi resolution, loud typed failure
src/provider-factory.ts createProvider({ auth: envApiKeyAuth, models, fetchModels, filterModels, api })
src/index.ts          default export factory: registerProvider(native) else legacy ProviderConfig
src/catalog.generated.ts  committed snapshot produced by scripts/generate-catalog.ts
scripts/probe-verboo.ts   live compat/maxTokens probe -> scripts/probe-report.json (evidence)
scripts/generate-catalog.ts  /models (+ probe report + manual overrides) -> src/catalog.generated.ts
scripts/manual-overrides.ts  curated maxTokens/cost with mandatory provenance note
test/                 network guard + unit tests + real-pi-ai integration with mock SSE
```

### catalog.generated.ts entry contract

`{ id, name, reasoning, input: ("text"|"image")[], cost, contextWindow, maxTokens, thinkingLevelMap,
compat, notes[] }`. `name` is derived from `id` when Verboo omits `display_name` (it does today).
Generated file carries a provenance header (source, fetchedAt, modelCount) and per-model notes.

### Compat: MEASURED (scripts/probe-report.json, 2026-09-25)

All six flags are settled by probe, not assumption. Do not re-litigate.

```
compat: {
  thinkingFormat: "openai",        // Verboo documents reasoning_effort as the wire field
  supportsReasoningEffort: true,   // reasoning_effort:"max" => 200
  supportsDeveloperRole: false,    // docs list roles system|user|assistant|tool only
  maxTokensField: "max_tokens",    // documented; measured 200
  supportsFinishReason: true,      // finish_reason present in stream AND non-stream responses
  supportsUsageInStreaming: true,  // usage chunk present both with AND without stream_options
}
```

**No payload sanitizer is needed — measured, not assumed.** Verboo returned `200` for every case
that broke NaN: `tools: []`, unknown/extra fields (`store`, `made_up_field_for_probe`), and a replayed
assistant message carrying `reasoning_content`. Do **not** port `openai-compat-sanitizer.ts`.
`requiresReasoningContentOnAssistantMessages` stays unset — replay already works.

`mimo-v2.5` emits `reasoning_content` in responses even though its `/models` entry declares no
`reasoning` object. Keep the catalog honest to `/models` (`reasoning: false`, thinking level `off` only)
and record the inconsistency in that entry's `notes`.

### thinkingLevelMap: DERIVED PER MODEL (the core improvement)

Pi levels: `off | minimal | low | medium | high | xhigh | max`. Verboo effort values may include
`none`, which is **not** a Pi level. Rule: a Pi level maps to the Verboo effort of the same name when
declared, otherwise `null` (unsupported); `off` maps to `"none"` only when `none` is declared.
`xhigh`/`max` require a defined entry to be offered by pi-ai at all.

| model | Verboo effort_levels | resulting Pi-supported levels |
| --- | --- | --- |
| deepseek-v4-flash | high, max | high, max |
| deepseek-v4-flash-0731 | low, medium, high, xhigh, max | low, medium, high, xhigh, max |
| deepseek-v4.1-flash | low, high, xhigh, max | low, high, xhigh, max |
| glm-5.3-flash | low, high, max | low, high, max |
| mimo-v2.5 | (none declared) | off |
| qwen3.8-27b | low, medium, xhigh, none | off, low, medium, xhigh |

`off → "none"` only for qwen3.8-27b. For every other model `off → null` (Verboo declares no way to
disable reasoning there), so Pi's clamp walks up to `high` — which matches Verboo's own
`default_effort` for those models.

### maxTokens policy

Verboo never publishes the output cap. Probe measured the safe envelope: `262144` accepted on all
1M-context models, rejected upstream with `502 {"error":"upstream unavailable"}` on `qwen3.8-27b`
whose context is `262144`; `131072` accepted there. Ship a conservative `65536` default — the value
the user's working OpenCode config already uses — and record the measured headroom in `notes`.
`models.json` `modelOverrides` remains the escape hatch. Never present 65536 as a published cap.

`cost` is `{0,0,0,0}`: Verboo publishes no pricing in `/models`. Recorded as unknown, never invented.

### Error classifier (src/verboo-errors.ts)

Map documented signals to either a Pi-recognized context-overflow error (so Pi compacts + retries) or
an actionable message. `413` and an over-window request ⇒ overflow wording Pi matches. `428` ⇒ surface
`acceptUrl` + `version`. `402`/`403`/`404` ⇒ name the cause and the fix (`/models`, plan, balance).
`429` ⇒ honour `Retry-After` and stay retryable. Rewrite only when the request is estimated over the
model window for the generic-`400` case; never mislabel an unrelated error.

## Tasks

- [x] T1 — Scaffolding: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `LICENSE`.
      Route: inline (mechanical, no research).
- [x] T2 — Probe: `scripts/probe-verboo.ts` measuring stream_options acceptance, reasoning_effort
      values (incl. `none`/`xhigh`/`max`), unknown-field rejection, `developer` role, empty `tools`,
      output-token cap. Emits `scripts/probe-report.json`. Route: inline (one file + bounded live
      verification; its results are the evidence T3/T4/T7 depend on).
- [x] T3 — `src/thinking-levels.ts`: exact per-model `ThinkingLevelMap`, unsupported ⇒ `null`,
      `off` mapped to Verboo `none` only where that effort is accepted. Route: delegated.
- [x] T4 — `src/catalog.ts` + `scripts/generate-catalog.ts` + `manual-overrides.ts` +
      `src/catalog.generated.ts`. Route: delegated.
- [x] T5 — `src/verboo-errors.ts`. Route: delegated.
- [x] T6 — `src/pi-ai-loader.ts` (compact port of the reference, host-anchored, loud failure).
      Route: delegated.
- [x] T7 — `src/providers.ts`, `src/provider-factory.ts`, `src/index.ts`. Route: delegated.
- [x] T8 — Tests: network guard + thinking-levels + catalog merge + error classifier +
      extension-load contract + one integration turn against a mock SSE gateway. Route: delegated.
- [x] T9 — README + verification (`bun run typecheck`, `bun test`, `pi --list-models verboo` smoke).
      Route: delegated (docs) + parent spot check.

## Work units

- `0fc6e9b` — `chore(scaffold): bootstrap pi-verboo-provider package` (T1)
- `bd60394` — `feat(thinking-levels): derive per-model pi thinking levels from Verboo efforts` (T3)
- `c9f39d0` — `feat(catalog): add Verboo catalog with live merge and generated snapshot` (T4)
- `bc95e66` — `feat(errors): classify documented Verboo errors into pi-actionable messages` (T5)
- `c0c2a99` — `feat(loader): resolve the host pi-ai openai-completions factory` (T6)
- `97d49f4` — `feat(provider): register Verboo Code via the shared pi-ai factory` (T7)
- `2aff867` — `test(suite): cover catalog, thinking levels, errors, provider, extension load and a mock-SSE turn` (T8)
- `d9114fd` — `docs(readme): document install, models, thinking levels, errors and provenance` (T9)

## Acceptance criteria

1. `bun run typecheck` and `bun test` pass with no network access (network guard proves it).
2. The extension loads under pi 0.87.1 and `pi --list-models verboo` lists the 6 live models.
3. Each model's offered thinking levels exactly match its Verboo `effort_levels` (mimo-v2.5: only `off`).
4. No fabricated value: every compat flag and limit traces to Verboo docs, the probe report, or a
   manual override with a note.
5. `VERBOO_API_KEY` works with no config file; `/login verboo` stores a key and takes precedence.

## Open questions

- Does Verboo reject replayed `reasoning_content` on assistant messages? Probe P9. If it rejects it,
  add a targeted sanitizer; if not, leave the adapter untouched (no speculative sanitizer).
- Real output-token caps are undocumented. Probe P8 attempts to reveal them; otherwise a conservative
  default ships and `models.json` `modelOverrides` remains the escape hatch.

## Progress

- Created branch `feat/verboo-provider`. Research complete: Pi 0.87.1 extension API mapped,
  reference repo mapped, Verboo live catalog + docs captured. Task document committed.
- T2 (probe) done inline: `scripts/probe-verboo.ts` written and run against the live API;
  `scripts/probe-report.json` committed as evidence. Findings folded into the Design section above.
  Consequence: the sanitizer is dropped, `supportsUsageInStreaming`/`supportsFinishReason` are true,
  and the `maxTokens` policy is settled.
- T1 (scaffold) done: manifest/tsconfig/bunfig/network-guard/LICENSE committed. `bun install` resolved
  `@earendil-works/pi-ai@0.87.1` and `@earendil-works/pi-coding-agent@0.87.1` from npm (`bun.lock`).
- T3 (thinking-levels) done: pure module mapping Verboo `effort_levels` to `ThinkingLevelMap`; emits
  explicit `null` for every unsupported pi level (omission is a bug for all levels except
  `xhigh`/`max`), so pi-ai offers exactly the declared efforts.
- T4 (catalog) done: tolerant live-capability parser + generated snapshot produced by
  `scripts/generate-catalog.ts`. Regeneration is byte-for-byte idempotent (it preserves `fetchedAt`
  when the payload is unchanged) and fails loudly on a missing key or a failed/empty live fetch.
- T5 (errors) done: pure `classifyVerbooError` + `withVerbooErrorClassification`. Overflow emits
  pi's recognized phrase (400 only when over-window; 413 always), terms surfaces acceptUrl/version,
  access/balance/model name cause and fix, 429 reports the body's retry delay (no header claim),
  500/502/503 transient, and a non-overflow 400 returns `undefined` (never mislabelled).
- T6 (loader) done: host-anchored resolution of `openAICompletionsApi`; bare root first, then file
  URLs derived from the host entrypoint's package root, failing with a loud typed
  `PiAiStreamingApiResolutionError` that carries the resolved root and attempted URLs.
  `PiAiLoaderHost` seam preserved.
- T7 (provider) done: `VERBOO_PROVIDER`/`PROVIDERS`, `createVerbooProvider` (envApiKeyAuth +
  generated baseline + live fetchModels/filterModels + error-classified api), and the default-export
  extension with a warned legacy fallback. `piAi.envApiKeyAuth` is exported by pi-ai 0.87.1, so no
  local auth equivalent was needed.
- T8 (tests) done: 7 files / 68 tests, no network. The network guard gained an explicit
  `installMockFetch`/`restoreNetworkGuard` hatch that still refuses non-mocked URLs. Coverage:
  thinking-level table + explicit-null regression, catalog parse/merge/fallback, error taxonomy +
  `result()`/iteration Proxy agreement, auth precedence + `filterModels`, extension registration
  (native + warned legacy fallback + pi-ai subpath scan), and a real pi-ai `openai-completions` turn
  against a mock SSE gateway (reasoning blocks, usage, finish_reason, over-window 400 overflow).
- T9 (README + acceptance) done: English README with quick path, model table, `maxTokens` caveat,
  auth, thinking-level behavior, error taxonomy, `models.json` `modelOverrides` example, development
  and provenance. Isolated `PI_CODING_AGENT_DIR` acceptance listed all 6 models; the real
  `~/.pi/agent/settings.json` was never touched.

## Verification evidence

- `scripts/probe-report.json` — 8 behavior probes + per-model output-cap probes against
  `https://code.verboo.ai/router/v1`, all recorded with status and response body.
- Live `/models` returns 6 models with `context_window`, `vision`, `reasoning.effort_levels`.
  It does **not** return `display_name`, output cap, or pricing.
- Streaming tail check: `usage` and `finish_reason` present with and without
  `stream_options: { include_usage: true }`.
- `bun run typecheck` / `bun test` — `bun run typecheck` (`bunx tsc --noEmit`) exits 0 on all tasks.
  `bun test`: `74 pass, 0 fail`, 276 expect() calls, 8 files (~0.5s), with the network guard active.
- End-to-end acceptance (isolated agent dir, real config untouched):
  `TMP=$(mktemp -d)`; `settings.json` = `{"packages":["<absolute repo path>"]}`;
  `PI_CODING_AGENT_DIR=$TMP VERBOO_API_KEY=... pi --list-models verboo` listed all 6 models with the
  expected context/max-out/thinking/images columns (exit 0).
- No-network runtime smoke (`bun -e`, `createVerbooProvider` + `getModels()`): observed
  `6 deepseek-v4-flash:map,deepseek-v4-flash-0731:map,deepseek-v4.1-flash:map,glm-5.3-flash:map,mimo-v2.5:nomap,qwen3.8-27b:map`.
  No fetch is performed.
- pi-ai 0.87.1 runtime exports: `envApiKeyAuth`, `createProvider` are functions on the bare root;
  `openAICompletionsApi` is NOT (the loader's host-anchored fallback loads it), so the factory's
  `envApiKeyAuth` path is used directly — no local auth equivalent.
- `ExtensionAPI` and `ProviderConfig` type imports resolve from the `@earendil-works/pi-coding-agent`
  root (`dist/index.d.ts`, re-exported from `core/extensions/types.ts`).
- `bun install` — resolved `@earendil-works/pi-ai@0.87.1` and
  `@earendil-works/pi-coding-agent@0.87.1` from npm; `bun.lock` committed. No faking needed.
- `bun run generate-catalog` (with `VERBOO_API_KEY`) — fetched the 6 live models and wrote
  `src/catalog.generated.ts`; a second plain run produced a byte-for-byte identical file (empty diff).
  Missing-key and failed-fetch paths both exit non-zero with a clear refusal message.

## Independent verification (2026-09-25)

An independent verifier reviewed the whole implementation. All findings were addressed in follow-up
work units:

- **C1 — Capability auditability**: `scripts/generate-catalog.ts` now also writes
  `scripts/models-capabilities.json` (source URL, `fetchedAt`, the raw `/models` rows exactly as
  received) on every successful run, so `contextWindow`/`vision`/`effort_levels` in
  `src/catalog.generated.ts` can be checked from the repo (acceptance criterion #4). The snapshot is
  committed and a rerun left `src/catalog.generated.ts` byte-identical.
- **C2 — Live reasoning trap**: `entryFromLiveCapability` derives `reasoning` from a usable
  `effort_levels` list, not from the presence of a `reasoning` object, so a model without efforts is
  `reasoning: false` with no `thinkingLevelMap` (pi-ai would otherwise treat omitted keys as
  supported). Regression test added in `test/catalog.test.ts`.
- **C3 — Loader typed failure**: the resolver result may be a `file://` URL or a filesystem path;
  URL derivation is wrapped so a runtime without `import.meta.resolve` raises
  `PiAiStreamingApiResolutionError` (resolved root + attempted URLs), never a raw `TypeError`. The
  vacuous `startsWith(rootDir)` comment and the `import.meta.resolve` comment now match the code.
- **C4 — Network-guard bypass**: `originalFetch` is no longer exported, so the hatch cannot restore
  real network access; the doc states the guard only routes and that narrowness is the supplied
  handler's responsibility. `test/network-guard.test.ts` stays green.
- **C5 — Loader tests**: `test/pi-ai-loader.test.ts` covers branch 1, branch 2, a throwing resolver,
  and a filesystem-path resolver result via the `PiAiLoaderHost` seam (no network, no writes).
- **C6 — Dependency hygiene**: `@types/node ^24` added explicitly to `devDependencies`
  (`import.meta.resolve` is not declared by bun-types).
- **C7 — Retry-After honesty**: the classifier reads the delay from the JSON body only, so the 429
  message and the README no longer imply HTTP header handling.

Deferred (recorded, intentionally not changed):

- `filterModels` does not prune on the stored-models/cache-only path (`liveIds` unset) — cosmetic;
  the generated baseline still shows.
- `estimateRequestTokens` counts base64 image data and tool schemas — the documented chars/3.47
  heuristic.
- No hard rejection of extension-relative resolution when `import.meta.resolve` ignores its `parent`
  argument — accurate comments and typed errors only, so a working load is never broken.

New/changed evidence paths: `scripts/models-capabilities.json`, `test/pi-ai-loader.test.ts`.

## Next step

All tasks T1–T9 are complete, verified, and independently reviewed; corrections C1–C7 are applied and
the deferred items above are recorded. Remaining work is release prep (not in scope): publish to npm,
add CI, and a Spanish README if desired.

- `README.es.md` added (Spanish translation of `README.md`, linked from both files) — commit `adb32c4`.
