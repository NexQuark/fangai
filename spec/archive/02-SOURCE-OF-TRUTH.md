# Source of truth — blueprint corrections

The public “definitive blueprint” is a strong **narrative**. These items are **facts from the repos and SDK** that must override the narrative when they conflict.

---

## 1. HTTP stack: Express + SDK, not Hono-first

- **`@a2a-js/sdk`** ships **Express** middleware (`agentCardHandler`, `jsonRpcHandler`, `restHandler`).
- Production direction (`playgorund/a2a-cli`) already uses **Express** in `@fangai/core`.
- The blueprint’s “Hono + streamSSE” describes the **v2 `fang`** experiment. That path **reimplemented** JSON-RPC/SSE and drifts from spec updates.

**Rule:** New server work extends **FangServer** on Express + SDK unless there is a written ADR for an alternate binding (gRPC, etc.).

---

## 2. “No A2A client” is overstated

The ecosystem gap is not “zero clients” — **`@a2a-js/sdk` includes client types** (e.g. `A2AClient` in the client entry). What we lack is:

- A **documented, productized** `@fangai/client` (ergonomics, Pi-orchestrator presets), **or**
- Clear guidance: “import `A2AClient` from `@a2a-js/sdk` and …”

**Rule:** Track **orchestrator UX** separately from **server** UX; do not claim total absence of client APIs.

---

## 3. Aider: not “text-only” for Fang

The blueprint’s Tier-3 row for Aider is **out of date** for this codebase:

- This codebase implements **`aider --json`** (structured lines) via the aider adapter.
- Example configs use `aider … --json-output` / `--json` depending on convention.

**Rule:** Docs and tier tables must say **structured mode when available**, **text fallback** when not.

---

## 4. “a2a-cli on npm is purely a client”

That sentence refers to **another** npm package name collision. **This product** uses scoped packages **`@fangai/cli`** etc. Disambiguate in all public copy:

- **Upstream generic name** `a2a-cli` (if it exists) ≠ **Fang** `@fangai/cli`.

---

## 5. Agent Card path

Verify against **SDK + deployed handlers**. The blueprint mentions `/.well-known/agent-card.json`; implementations sometimes expose **aliases** (e.g. `agent.json`). Document **canonical + aliases** in A2A compliance docs and keep handlers consistent.

---

## 6. Competitive claim: “no tool bridges CLI → A2A”

Keep the claim **narrow and falsifiable**:

- Vendor-neutral
- Open-source
- Subprocess-based **coding** agents
- Standards-based **A2A** server

Otherwise competitors (REST wrappers, single-vendor A2A shims) will “well actually” the launch.

---

## 7. Blueprint v0.1 priorities vs merge priorities

The blueprint suggests: Claude first → Gemini → Aider text.

**Engineering merge order** (from `COMPARISON.md` + Pi reality):

1. **SDK-first server** (already in v3).
2. **Persistent execution** for agents that need it (Pi RPC) — from v1.
3. **ProcessManager-grade** bridging — from v2 patterns.
4. **Detector / discover UX** — v2 Detector + v3 commands.
5. Deep adapter expansion (Claude, OpenCode, Codex, Gemini…) against stable plumbing.

Marketing priority can differ; **spec priority** follows plumbing first.
