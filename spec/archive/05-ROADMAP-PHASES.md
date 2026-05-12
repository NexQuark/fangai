# Roadmap — phases to production

Phases are **sequential** unless marked parallel. Each phase ends with **mergeable artifacts** (code + docs + tests).

---

## Phase 0 — VENOM∞ Body Machine Blueprint ✅ (2026-05-12)

**Status:** COMPLETE — specs written by VENOM + Cursor Opus 4.7

**Specs delivered:**
- `17-INK-WIRE.md` — INK dispatch language (14-field payload, selectors, budget, recursion, decline/counter-offer)
- `18-PACT.md` — Body constitution (YAML schema, signature chain, enforcement, 10 error codes)
- `19-BODY-BOOT.md` — Body.boot() entry point (11-phase sequence, config, health, hot reload)
- `20-PHASE-0-PLAN.md` — Day-by-day migration plan (5 days, 5 commits, zero test breakage)
- `21-TESTING.md` — Testing strategy (unit, integration, contract, SIPHON, fitness, pact, E2E, CI)
- `22-CLAW.md` — System operations muscle (whitelist registry, 3-layer defense, diagnostic instrument)
- `23-DATA-STRUCTURES.md` — Complete cross-organ types (Frame, Blood, Memory, INK, Pulse, Fitness, Errors)

**Next:** Phase 0 Implementation — Day 1: folder structure + package manifest (see SPEC-20)

---

## Phase 1 — Foundation hardening (v3 baseline)

**Goals**

- `pnpm install && pnpm -r build && pnpm -r test` green on supported Node.
- Remove or isolate **dead code** (`TaskManager`, `SSEEmitter`, unused `AgentCard` paths) — prove via grep + coverage that SDK path owns lifecycle.
- **Adapter registry:** warn or error when an adapter package is missing instead of silent generic fallback (configurable).

**Exit:** Release candidate **0.2.x** with no behavioral regressions.

---

## Phase 2 — Persistent execution (v1 → v3)

**Goals**

- Port **persistent** BridgeExecutor semantics for **`pi --mode rpc`** into `@fangai/core` executor.
- Single long-lived child; task demux; **cancel/abort** path mapped where Pi supports it.
- Tests with **mocked** stdin/stdout JSONL (fixtures).

**Status (2026-04):** Implemented in [`packages/core/src/FangAgentExecutor.ts`](https://github.com/kariemSeiam/fangai/blob/main/packages/core/src/FangAgentExecutor.ts): `BaseAdapter.executionMode`, `PiAdapter` → `persistent`, `splitCli()` for argv, persistent shell + stdout routing, abort on cancel. Integration tests against real `pi` still manual.

**Exit:** `fang wrap "pi --mode rpc"` on v3 matches v1 behavior for basic send/stream scenarios.

---

## Phase 3 — Process layer (v2 → v3)

**Goals**

- Introduce **readline**-based stdout processing and **SIGTERM → SIGKILL** with timeouts for oneshot adapters.
- Shared module used by both persistent and oneshot paths where applicable.

**Status (2026-04):** `FangAgentExecutor` uses Node **`readline.createInterface`** on **stdout** for both oneshot and persistent shells (`crlfDelay: Infinity`). Oneshot **timeout** and **adapter-reported failure** send **SIGTERM**, then **SIGKILL** after **5s** if the child is still running (`scheduleKillAfterSigterm`).

**Exit:** Documented timeout and kill behavior; integration tests for hung child.

---

## Phase 4 — Detection & operator UX

**Goals**

- Merge **Detector** ideas: `which`, version probes, sorted tiers.
- `discover` / `detect` output is **actionable** (path, confidence, suggested CLI string).

**Status (2026-04):** `@fangai/core` exports **`detectHostAgents()`** (`hostDetect.ts`) — `which` + `--version`, tier-sorted probes (pi, claude, codex, gemini, goose, opencode, aider) with **`wrapExample`** hints. CLI adds **`fang detect`** (`--json`). **`fang discover`** shows protocol version, skill count, and JSON-RPC URL; empty state points to **`fang detect`**.

**Exit:** One-screen `fang detect` that a new user trusts.

---

## Phase 5 — Client / orchestration ergonomics

**Goals**

- Publish **`@fangai/client`** *or* ship docs + tiny examples using **`A2AClient`** from `@a2a-js/sdk`.
- Optional: YAML-driven **fleet** file for multi-agent local dev (extends `start`).

**Status (2026-04):** New workspace package **`@fangai/client`** (`packages/client`) with **`FangClient`** (`getAgentCard`, `sendMessage`, `streamMessage`), **`discoverRunningAgents`**, **`callJsonRpc`**. CLI **`fang send`** uses **`FangClient`** internally.

**Exit:** Pi (or any host) can delegate without hand-written `curl`.

---

## Phase 6 — Adapter breadth

**Goals**

- Port **Codex** / **Gemini (ACP)** from v2 when Phase 2–4 are stable.
- Crush / Tier-3: explicit “best effort” or out of scope.
- **Pi** and **OpenCode** track upstream: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (`--mode rpc`, `rpc-types.ts`) and [anomalyco/opencode](https://github.com/anomalyco/opencode) (`run --format json`, `serve`). See **`spec/15-UPSTREAM-PI-AND-OPencode.md`**.

**Status (2026-04):** **`@fangai/adapter-codex`** — `codex --json` JSONL. **OpenCode** covered via process adapter + optional **`opencode serve`** HTTP bridge (`--open-code-url`). **Pi** RPC aligned with upstream `prompt` command.

**Deferred (not blocking 1.0)** — *explicit skip for now*

- **ACP-class adapters** (Gemini CLI, Goose `acp`, unified stdio ACP module): post-1.0 unless a sponsor milestone. Fang’s bet remains **JSON-RPC `/a2a`** + subprocess/HTTP bridges already shipped.
- **Extra REST surface** beyond what **`@a2a-js/sdk`** exposes (`restHandler`): no parallel custom REST API until there is a concrete integrator requirement; use **Agent Card + JSON-RPC** as the contract.

**Exit:** Adapter matrix in docs matches code; deferrals listed above stay explicit.

---

## Phase 7 — Production ops

**Goals**

- Auth (API key), hardened Docker, CI on main, release checklist.

**Status (2026-04):** GitHub Actions **CI** (`.github/workflows/ci.yml`) runs on `main` PRs/pushes: `pnpm install --frozen-lockfile`, **`pnpm run release:verify`** (build + test + core ESLint); Docker builds for `Dockerfile.pi` / `Dockerfile.claude`. **Optional API key** for `/a2a` + SDK REST (`FANG_API_KEY`, `fang wrap --api-key`, `@fangai/client` / `fang send --api-key`). **`fang discover`** shows **`auth`** from `/health` when present. **`fang wrap --host`** / **`FANG_HOST`** for localhost-only bind; default listen behavior and ops notes in **`14-SECURITY-AND-TRUST-BOUNDARIES.md`**. Baseline changelog: **`fang/CHANGELOG.md`**.

**Next (from current tree):** burn down **`16-RELEASE-CHECKLIST.md`**, bump versions if needed, **`npm publish`** **`@fangai/*`** — **not** ACP/Gemini unless priorities change.

**Exit:** **1.0.0** candidate with runbooks — see **`spec/16-RELEASE-CHECKLIST.md`**.

---

## What we are *not* waiting for

- Perfect token benchmarks — cite research separately (`00-RESEARCH-PROGRAM.md`).
- Every agent in tier 1 — ship **correct** Pi + Claude + Aider first.
- **Full ACP coverage** or **custom REST** beyond the SDK — see Phase 6 **Deferred**.
