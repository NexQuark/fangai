# Priority reconciliation — spec folder vs Venom field plan (2026-04)

This doc answers: **Is the `spec/` plan “better” than the priorities from the deep research chat?**  

**Short answer:** Neither replaces the other. The chat produced **discoveries and a correct fork** (SDK-first, Express, competitors). The spec folder produces **durability** (phases, risks, single source of truth). The **best** path uses **both**, with two different “axes” of priority.

---

## What the research chat got right (keep forever)

| Insight | Where it lives in spec |
|---------|------------------------|
| **agentapi** (Coder) — real competitor, REST not A2A | `00-RESEARCH-PROGRAM.md` Tier-3 competitive refresh |
| **@google/gemini-cli-a2a-server** — validates pattern, vendor-specific | Same + `04` capability notes |
| **Token economy** — sharp *story*, cite sources carefully | `00` + `01` (not a build requirement) |
| **ACP** — Gemini / Goose / OpenCode share a stdio JSON-RPC shape | `03` (ACP bridge as adapter family), Phase 6 |
| **Paperclip** — similar architecture, proprietary protocol | Competitive positioning |
| **Hono recommendation wrong** for v0.1 — **Express + `@a2a-js/sdk`** | `02-SOURCE-OF-TRUTH.md` |
| **Rebuild on SDK** — `AgentExecutor` + `DefaultRequestHandler` + Express handlers | Done in shipped `a2a-cli-01` / monorepo v3 |
| **Client gap** — three servers, orchestrator needs more than curl | `03`, Phase 5, `02` (SDK has `A2AClient`) |

---

## Where the two plans looked different (not a contradiction)

### Axis A — **Go-to-market adapter order** (Venom)

Roughly: **Claude Code first** (largest surface, best stream-json) → **ACP adapter** (unlocks Gemini + Goose + OpenCode with one bridge) → **generic / text** (Aider, Crush, …).

This optimizes **2026 launch narrative** and **breadth per week of work**.

### Axis B — **Engineering merge order** (spec `05`)

Roughly: **harden v3** → **persistent Pi RPC** (from v1) → **ProcessManager-style I/O** (from v2) → **Detector UX** → **client ergonomics** → **adapter breadth** (Codex, Gemini, …).

This optimizes **no regressions**, **Pi RPC correctness**, and **one foundation** for all adapters.

These axes are **orthogonal**. You can ship **Claude-first** on the current executor **while** plumbing persistent mode in parallel — as long as you do not promise “Pi RPC without respawn” until Axis B catches up.

---

## Recommended combined strategy (legendary release, realistic)

1. **Lock the foundation** — Express + SDK (already aligned with Venom’s choice **(a)**). No custom JSON-RPC server.

2. **Parallel tracks after Phase 1**

   | Track | Owner focus | Outcome |
   |-----|-------------|---------|
   **B1 — Market adapters** | Venom order | Claude stream-json hardened → ACP module → text/structured fallbacks |
   **B2 — Plumbing** | spec `05` Phases 2–3 | Persistent Pi + timeouts + readline |

   Merge B2 into main **before** you market “Pi `--mode rpc` without respawn” as a guarantee.

3. **Naming** — Venom is right that **`a2a-cli` is clearer for SEO**; brand **`fang`** + scope **`@fangai/cli`** is clearer for npm reality. Document both in README: *“Fang (`@fangai/cli`) — CLI agents as A2A servers.”*

4. **Aider** — Venom’s old ordering said “text third”; the **current** codebase uses **`--json`**. Treat Aider as **structured-first, text fallback** — not pure Tier-3 only.

---

## Verdict: is `spec/` “better”?

- **Better for:** not losing decisions, research hygiene, merge thesis, risks, and **long-horizon** consistency.
- **Not a replacement for:** the competitive research, the SDK rewrite decision, or the **Claude → ACP → rest** adapter momentum.

**Best = spec folder + Venom’s research conclusions + explicit dual-track roadmap above.**

If this file ever conflicts with `05-ROADMAP-PHASES.md`, update **both** in the same PR and note the release (e.g. “0.3 focused on B1; 0.4 merged B2 persistent”).

---

## 2026-04 adjustment (ship path)

The **Claude → ACP → rest** adapter momentum in the verdict above is **not** a gate for **1.0**. Current tree prioritizes **JSON-RPC `/a2a`**, **Agent Card**, **optional API key**, **Codex + OpenCode + Pi**, and **release checklist** — see **`05` Phase 6 “Deferred”** and **`16-RELEASE-CHECKLIST.md`**. Revisit unified ACP or extra REST only when a concrete product asks for it.
