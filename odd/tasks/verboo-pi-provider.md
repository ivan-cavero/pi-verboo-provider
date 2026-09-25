# Feature: pi-verboo-provider

## Objective

Build `@gtrabanco/pi-verboo-provider`, a Pi (earendil-works/pi) extension package that registers
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

### Compat defaults (each backed by evidence)

- `thinkingFormat: "openai"` (default) — Verboo documents `reasoning_effort` as the wire field.
- `supportsReasoningEffort: true` — same.
- `supportsDeveloperRole: false` — Verboo message roles are only `system|user|assistant|tool`.
- `maxTokensField: "max_tokens"` — Verboo documents both; `max_tokens` is the wider-accepted one.
- `supportsFinishReason: true` — Verboo documents a `finish_reason` chunk. Fail-visible on truncation.
- `supportsUsageInStreaming` — set from the probe report (Verboo documents a final `usage` chunk).
- Explicitly **not** set: `requiresReasoningContentOnAssistantMessages` (unproven) — unless the probe
  shows Verboo requires it.

### Error classifier (src/verboo-errors.ts)

Map documented signals to either a Pi-recognized context-overflow error (so Pi compacts + retries) or
an actionable message. `413` and an over-window request ⇒ overflow wording Pi matches. `428` ⇒ surface
`acceptUrl` + `version`. `402`/`403`/`404` ⇒ name the cause and the fix (`/models`, plan, balance).
`429` ⇒ honour `Retry-After` and stay retryable. Rewrite only when the request is estimated over the
model window for the generic-`400` case; never mislabel an unrelated error.

## Tasks

- [ ] T1 — Scaffolding: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `LICENSE`.
      Route: inline (mechanical, no research).
- [ ] T2 — Probe: `scripts/probe-verboo.ts` measuring stream_options acceptance, reasoning_effort
      values (incl. `none`/`xhigh`/`max`), unknown-field rejection, `developer` role, empty `tools`,
      output-token cap. Emits `scripts/probe-report.json`. Route: delegated (write + live verification).
- [ ] T3 — `src/thinking-levels.ts`: exact per-model `ThinkingLevelMap`, unsupported ⇒ `null`,
      `off` mapped to Verboo `none` only where that effort is accepted. Route: delegated.
- [ ] T4 — `src/catalog.ts` + `scripts/generate-catalog.ts` + `manual-overrides.ts` +
      `src/catalog.generated.ts`. Route: delegated.
- [ ] T5 — `src/verboo-errors.ts`. Route: delegated.
- [ ] T6 — `src/pi-ai-loader.ts` (compact port of the reference, host-anchored, loud failure).
      Route: delegated.
- [ ] T7 — `src/providers.ts`, `src/provider-factory.ts`, `src/index.ts`. Route: delegated.
- [ ] T8 — Tests: network guard + thinking-levels + catalog merge + error classifier +
      extension-load contract + one integration turn against a mock SSE gateway. Route: delegated.
- [ ] T9 — README + verification (`bun run typecheck`, `bun test`, `pi --list-models verboo` smoke).
      Route: delegated (docs) + parent spot check.

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
  reference repo mapped, Verboo live catalog + docs captured. No source written yet.

## Verification evidence

- Pending.

## Next step

T1 scaffolding, then T2 probe (its output feeds T3/T4/T7).
