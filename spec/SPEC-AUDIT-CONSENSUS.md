# SPEC AUDIT — Three-Model Consensus (VENOM + Opus 4.7 + GPT-5.5 + Gemini 3.1 Pro)

> Four models reviewed the full 30-spec corpus (~250K chars). This is the consolidated verdict, the unified restructure plan, and the path to shipping.

**Date:** 2026-05-12
**Reviewed by:** VENOM Agent, Claude Opus 4.7, GPT-5.5, Gemini 3.1 Pro
**Target:** github.com/kariemSeiam/fangai/spec/

---

## 0. Rating Summary

| Reviewer | Rating | Core Thesis |
|----------|--------|-------------|
| VENOM | 8.5/10 | Exceptional depth, spec-to-code gap is biggest risk |
| Opus 4.7 | 7.5/10 | 250K spec + 0 code is not yellow gap — it's THE problem |
| GPT-5.5 | 7.0/10 | Semantic instability at wrapper boundary — CLI drift is fatal risk |
| Gemini 3.1 Pro | 6.5/10 | Architecture astronautics — building cathedral before baking a brick |

**Consensus: 7.4/10** — excellent spec hygiene, severe implementation gap, structural risk at the adapter boundary.

---

## 1. The Blind Spot All Four Found

### Upstream Volatility — The Real Structural Risk

Every model independently identified the same risk that was NOT in the original review:

> **CLI agents are not stable APIs.** Their streams, prompts, permissions, auth state, cancellation behavior, and failure modes are product surfaces controlled by other vendors and change weekly. Fang can write elegant specs forever and still fail if the wrapper contract cannot survive real CLI drift.

**The central question:** Can Fang define a small, testable, lossy-but-useful adapter contract that survives Claude Code, Cursor, OpenCode, Pi, and future agents changing underneath it?

If not, Fang is a beautiful protocol over sand.

---

## 2. Per-Spec Verdict (00-29)

| Spec | Consensus Verdict | Rationale |
|------|-------------------|-----------|
| `00-RESEARCH-PROGRAM` | KEEP (cap at 1 page) | Charter is needed but must not expand |
| `01-VISION-AND-SCOPE` | KEEP | Core identity — what Fang is/isn't |
| `02-SOURCE-OF-TRUTH` | MERGE → `01-VISION` | Corrections belong with scope, not separate |
| `03-ARCHITECTURE-TARGET` | KEEP | Foundational — HTTP surface + executor model |
| `04-VERSION-MATRIX` | MERGE → `15-UPSTREAM` | Relay table belongs with provider matrix |
| `05-ROADMAP-PHASES` | KEEP (revised) | Phase gates must be binary exit criteria, not prose |
| `06-WORKFLOW` | MERGE → `05-ROADMAP` | Workflow is part of phases |
| `07-PRIORITY-RECONCILIATION` | DELETE | Historical artifact — dual-track already resolved |
| `08-ECOSYSTEM-MAP` | MERGE → `01-VISION` | Ecosystem context belongs in vision doc |
| `09-GLOSSARY` | KEEP (shrunk) | Canonical terms only, remove organism metaphor |
| `10-RESEARCH-BACKLOG` | MERGE → `00-RESEARCH` | Backlog belongs with research program |
| `11-DISTRIBUTION` | MERGE → `05-ROADMAP` | Publishing is a phase gate, not a standalone spec |
| `12-TESTING-AND-CONTRACTS` | KEEP (expanded) | Must include conformance suite + fixtures |
| `13-NAMING-AND-DISCOVERY` | MERGE → `01-VISION` | Branding belongs in vision |
| `14-SECURITY-BOUNDARIES` | KEEP (as section) | Security belongs with config/identity/boot |
| `15-UPSTREAM-PI-OPencode` | KEEP (expanded) | MUST become fat versioned adapter contracts |
| `16-RELEASE-CHECKLIST` | MERGE → `05-ROADMAP` | Release criteria are phase gates |
| `17-INK-WIRE` | DEFER (keep INK-lite) | Full INK → Phase 3. Lite: envelope + idempotency + budget headers |
| `18-PACT` | DEFER to Phase 3 | Signature-chained constitution — not needed until federation |
| `19-BODY-BOOT` | MERGE → config/identity | Boot sequence folds into startup config |
| `20-PHASE-0-PLAN` | KEEP (rewritten) | Day-by-day plan with binary exit criteria |
| `21-TESTING` | DELETE | Merged into `12-TESTING-AND-CONTRACTS` |
| `22-CLAW` | DEFER to Phase 2 | System operations muscle — needs running body first |
| `23-DATA-STRUCTURES` | SPLIT (31K → per-organ files) | Canonical types are valuable but monolith is trap |
| `24-EDGE-CASES` | KEEP AS FIXTURES | Convert prose to executable conformance cases |
| `25-FAILURE-MODES` | KEEP AS FIXTURES | Convert to failure simulation tests |
| `26-RECOVERY-PATTERNS` | KEEP AS FIXTURES | Convert to recovery protocol tests |
| `27-SIPHON` | DEFER to Phase 3 | Cold-recap merge — no multi-agent yet |
| `28-SECURITY-MODEL` | DEFER to Phase 2 | 5-layer defense — needs running system to defend |
| `29-RECONCILIATION` | SHRINK | Anti-drift reconciliation → bind to CI, not prose |

---

## 3. Target Restructure: 30 → 12 Files

| New File | Source Specs | Content |
|----------|-------------|---------|
| `00-CHARTER-AND-SCOPE.md` | 00, 01, 02, 07, 08, 09, 10, 13 | What Fang is, isn't, who it serves, canonical terms |
| `01-A2A-HTTP-PROFILE.md` | 03, 04 | HTTP surface, A2A server behavior, version matrix |
| `02-TASK-LIFECYCLE.md` | 05, 06, 16 | Task/session model, streaming, artifacts, workspace |
| `03-CLI-ADAPTER-CONTRACT.md` | 15 | How adapters work — versioned, with fixture requirements |
| `04-PROVIDER-MATRIX.md` | (new) | Claude Code, Cursor, OpenCode, Pi — versions, known drifts |
| `05-CONFIG-IDENTITY-BOOT.md` | 14, 19 | Auth, identity, startup sequence, security boundaries |
| `06-INK-LITE.md` | 17 (subset) | Envelope, idempotency, budget headers — no routing/fitness/recursion |
| `07-ERRORS-CANCELLATION.md` | 05 (subset), 09 | Error taxonomy, cancellation protocol, resume strategy |
| `08-CONFORMANCE-SUITE.md` | 12, 21 | Golden fixtures, conformance tests, CI gates |
| `09-HOSTILE-FIXTURES.md` | 24, 25, 26, 27, 28 | Executable test cases for seams, failures, recovery |
| `10-PHASE-GATES.md` | 05, 11, 16 | Binary exit criteria per phase, release checklist, publishing |
| `11-BUDGETS-AND-OBSERVABILITY.md` | (new: SPEC-30/31/32) | Performance budgets, kill switches, tracing, pulse sink |
| `12-DEFERRED-ARCHITECTURE.md` | 17 (full), 18, 22, 23, 27, 28 | Full INK, PACT, SIPHON, organism theory — Phase 2+ only |

**Total: 12 files. Target: ~45K chars. Cut from 250K.**

The graveyard (`/spec/archive/`) holds the original 30 files as reference. The 12 new files are the active spec.

---

## 4. SPEC-30/31/32 — Mandated Content

### SPEC-30: Phase Gates (binary exit criteria)

```
Phase 0 (Days 1-14): Single-agent path
- One agent (Claude Code, stream-json), one transport (HTTP/JSON)
- One task type (code-edit), one ledger (append-only JSONL)
- Acceptance: orchestrator POSTs envelope → gets stream → ledger survives crash → replay produces identical artifacts

Phase 1 (Days 15-45): Multi-agent + budgets
- Add Cursor + OpenCode adapters
- Wire INK subset: envelope, idempotency, budget header, parent-task
- NO fitness routing, NO counter-offers, NO recursion guard

Phase 2 (Days 46-90): Seams + observability
- Wire failure modes, circuit breakers, recovery protocols
- Pulse emission → SQLite sink → export to external observability
- PACT-lite: versioned config + signed release artifacts

Phase 3 (Days 91+): Full INK + PACT + SIPHON
- Full dispatch language with fitness routing
- Signature-chained constitution
- Cold-recap merge across agents
```

### SPEC-31: Budgets (measurable, not aspirational)

| Budget | Default | Hard Limit | Failure Behavior |
|--------|---------|------------|------------------|
| Server startup time | 5s | 15s | Exit 1 |
| Agent-card latency | 50ms | 200ms | Log warning |
| Task accepted latency | 100ms | 500ms | Log warning |
| First stream event | 500ms | 5s | Log warning |
| Cancellation latency | 200ms | 2s | SIGTERM → SIGKILL |
| Adapter timeout | 300s | 600s | SIGKILL + task failed |
| Memory ceiling (idle) | 100MB | 500MB | Restart adapter |
| Max log per task | 10MB | 50MB | Truncate + warning |
| Token budget | inherited | parent.remaining | Reject with budget error |
| Concurrent tasks (per agent) | 1 | 3 | Queue or reject |

### SPEC-32: Observability (non-optional)

- Correlation IDs across HTTP request → task → adapter process → stream events
- Structured JSON logs (level, taskId, adapterId, timestamp)
- Metrics: task count, active tasks, failures, cancels, timeouts, adapter exits, stream latency
- Event schema for lifecycle transitions (submitted → running → completed/failed/cancelled)
- Health/readiness endpoints (`/healthz`, `/readyz`)
- Trace/span model (OpenTelemetry-compatible)
- Redaction rules (no API keys, no tokens in logs)
- **Pulse sink:** SQLite append-only in Phase 0, export to external in Phase 2
- Retention: configurable age cap (default: 30 days)
- Alerting: pulse query with threshold → webhook

---

## 5. The First Commit — Consensus

All four models agree: **do NOT start with Claude Code. Do NOT start with Cursor. Start with the protocol skeleton.**

> **`feat: add minimal A2A server with echo adapter and conformance smoke test`**

Exact scope:
- `GET /.well-known/agent-card.json`
- `GET /healthz`
- `POST /tasks/send`
- `GET /tasks/{id}`
- `GET /tasks/{id}/events` (SSE or A2A streaming shape)
- One in-process `echo` adapter (implements same interface real CLIs will use)
- Idempotency key parsing
- Budget header parsing
- Task state machine: `submitted → running → completed/failed/cancelled`
- One golden conformance test that starts the server, submits a task, receives stream events, verifies final task state

**Why echo first:** So the protocol can fail in CI before vendor weirdness enters the room. Prove the server works. Then prove one adapter works. Then prove two. Then prove three.

---

## 6. What Fang Actually Becomes — Three Predictions

| Outcome | Probability | Description |
|---------|-------------|-------------|
| **Category creator** | 10-15% | A2A becomes real infrastructure. Fang is the reference wrapper layer. |
| **Niche but valuable** | 45-60% | "jQuery of the early A2A era." Respected tool, 2-year window, graceful deprecation as vendors ship native APIs. |
| **Respected spec, no traction** | 15-30% | Great architecture document. Nobody ships it. |
| **Dead weight** | 15-25% | Vendor-native APIs commoditize the wrapper layer. |

**Consensus: Fang is a polyfill.** A wrapper with ambition and good taste. Viable as a niche tool, but only if it ships. The 250K spec corpus is a recruiting document, not a product document.

**The unflattering truth:** if Fang shipped a 2,000-line MVP in 30 days that wrapped Claude Code with a ledger and an A2A endpoint, it would have more validation today than 250K chars of spec.

---

## 7. Action Items

1. **Create `/spec/archive/`** — move all 30 existing files there
2. **Write 12 new spec files** — the restructured corpus (~45K chars)
3. **Write SPEC-30/31/32** — Phase Gates, Budgets, Observability (above)
4. **Ship first commit** — echo adapter + conformance test
5. **Ship second commit** — Claude Code adapter (real CLI, real stdout parsing)
6. **Ship third commit** — ledger + replay (append-only JSONL, fsync, crash recovery)

**Stop speccing. Start the echo adapter. Today.**
