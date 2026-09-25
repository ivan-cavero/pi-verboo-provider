# pi-verboo-provider

**Verboo Code as a first-class pi provider** — a live, capability-rich model catalog with per-model
thinking levels and a documented error taxonomy, instead of a hand-maintained list of model IDs.

Pi ships a declarative Verboo integration (`~/.pi/agent/models.json`): you hardcode IDs and nothing
validates them against your key, exposes reasoning-effort capability, or explains Verboo's structured
errors. This package registers `verboo` programmatically and fills those gaps.

## Quick path

```bash
pi install /path/to/pi-verboo-provider   # or npm:@ivan-cavero/pi-verboo-provider once published

export VERBOO_API_KEY=...                # or run: /login verboo
pi --list-models verboo                  # expected: 6 models
```

## What you get

| Capability | This package | Verboo's declarative `models.json` | `pi-nan-provider` |
|---|---|---|---|
| Model discovery | Live `/models` capabilities × committed fallback | IDs you type by hand | Live IDs × models.dev |
| Per-model thinking levels | Derived from each model's `effort_levels` | You configure them manually | Fixed per catalog |
| Context window / vision | Read from Verboo itself | You guess/type | From models.dev |
| Error handling | Documented status/code → cause + fix | Raw provider text | Opaque-400 overflow heuristic |
| Auth | `VERBOO_API_KEY` + `/login verboo` (stored key wins) | Env interpolation only | Stored/env key |

Deliberately out of scope: MCP bridges, a usage/quota command, and a payload sanitizer (the probe
proved Verboo accepts every payload shape that broke Nan — see [Provenance](#provenance)).

## Models

Thinking levels are the pi levels actually offered, derived from Verboo's declared efforts.
`maxTokens` is `65536` for every model — see the caveat below.

| Model id | Context window | Vision | Supported pi thinking levels |
|---|---:|---:|---|
| `deepseek-v4-flash` | 1,048,576 | no | `high`, `max` |
| `deepseek-v4-flash-0731` | 1,048,576 | no | `low`, `medium`, `high`, `xhigh`, `max` |
| `deepseek-v4.1-flash` | 1,048,576 | yes | `low`, `high`, `xhigh`, `max` |
| `glm-5.3-flash` | 1,048,576 | yes | `low`, `high`, `max` |
| `mimo-v2.5` | 1,048,576 | yes | `off` only |
| `qwen3.8-27b` | 262,144 | yes | `off`, `low`, `medium`, `xhigh` |

Notes recorded in the generated catalog: Verboo reports `vision: true` for `deepseek-v4.1-flash`
(the pi/OpenCode config used to mark it text-only), and `mimo-v2.5` declares no reasoning capability
yet emits `reasoning_content` in responses.

### `maxTokens` caveat

Verboo publishes **no output-token cap**. `65536` is a conservative envelope, not a published limit:
the probe measured `262144` accepted on the 1M-context models and rejected upstream (`502`) on
`qwen3.8-27b`, where `131072` was accepted. Override it per model when you need the headroom:

```json
{
  "providers": {
    "verboo": {
      "modelOverrides": {
        "deepseek-v4-flash": { "maxTokens": 262144 }
      }
    }
  }
}
```

`modelOverrides` changes metadata for the extension-provided models without replacing the catalog.
The same mechanism can pin `contextWindow`, `thinkingLevelMap`, `input`, or `compat`.

## Auth

| Source | Precedence |
|---|---|
| `VERBOO_API_KEY` | Used when no credential is stored |
| `/login verboo` | Stored credential wins over the env var |

An empty env var does not count as configured. The provider is unconfigured until one of the two
sources yields a non-empty key.

## Thinking levels

Each model's `thinkingLevelMap` comes from that model's Verboo `effort_levels`: `none` maps to pi
`off`, same-named efforts pass through, and every unsupported pi level is an explicit `null` so pi
does not offer it. The distinction matters because pi-ai treats an *omitted* level as supported.

**Reasoning cannot be disabled on most models.** Only `qwen3.8-27b` declares `none`, so it is the
only model whose `off` is real. Elsewhere `off` is unsupported and pi clamps the request up to the
nearest supported level (usually Verboo's own `default_effort`).

## Error taxonomy

Verboo errors are documented and structured. The provider turns them into an actionable message —
and a context overflow into pi's recognized overflow wording, so pi compacts and retries.

| Verboo signal | Classification | What to do |
|---|---|---|
| `413`, or a `400` on an over-window request | context overflow | pi compacts and retries automatically |
| `428` / `terms_acceptance_required` | terms | accept at the returned `acceptUrl` (version shown) |
| `401` | access | check `VERBOO_API_KEY` is valid |
| `403` | access | check your plan includes the feature; list models with `GET /models` |
| `402` | balance | add credit; the fix is balance, not the catalog |
| `404` | model | refresh the catalog and pick a listed id |
| `429` | rate limit | wait for the server's rate-limit window, then retry |
| `500` / `502` / `503` | transient | retry shortly |

A `400` that is not over the model window is left untouched — unrelated validation errors are never
relabelled as overflow.

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit
bun test                 # no network; fetch is guarded in tests
bun run probe-verboo     # live compat/cap probes -> scripts/probe-report.json
bun run generate-catalog # rebuild src/catalog.generated.ts from /models
```

`probe-verboo` and `generate-catalog` need `VERBOO_API_KEY`; they fail loudly without it and never
write the key anywhere. `generate-catalog` is byte-for-byte idempotent and refuses to guess
capability data.

## Provenance

Compat flags are **measured, not assumed**: `scripts/probe-report.json` records the live probes
(stream usage with and without `stream_options`, `reasoning_effort: "max"`, empty `tools`, unknown
fields, replayed `reasoning_content`, and per-model output-cap attempts). The headers in
`src/catalog.generated.ts` carry the fetch time and per-model notes. Pricing is zero because Verboo
publishes none — unknown values are recorded, never invented.
