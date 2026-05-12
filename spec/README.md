# Fang — Production Specification

This folder is the **single place** for vision, corrected assumptions, architecture targets, and delivery workflow. It is meant to stay ahead of marketing copy and playground prototypes.

---

## Active Specs (12 files, ~36K chars)

| File | Purpose | Phase |
|------|---------|-------|
| [00-CHARTER-AND-SCOPE.md](./00-CHARTER-AND-SCOPE.md) | What Fang is, isn't, who it serves, canonical terms | 0 |
| [01-A2A-HTTP-PROFILE.md](./01-A2A-HTTP-PROFILE.md) | HTTP endpoints, A2A protocol, version matrix, security | 0 |
| [02-TASK-LIFECYCLE.md](./02-TASK-LIFECYCLE.md) | Task model, SSE streaming, cancellation, resume, artifacts | 0 |
| [03-CLI-ADAPTER-CONTRACT.md](./03-CLI-ADAPTER-CONTRACT.md) | Adapter interface, conformance, fixtures, version probing | 0 |
| [04-PROVIDER-MATRIX.md](./04-PROVIDER-MATRIX.md) | Claude Code, Cursor, OpenCode, Pi — versions, known drifts | 0 |
| [05-CONFIG-IDENTITY-BOOT.md](./05-CONFIG-IDENTITY-BOOT.md) | Config YAML, identity, boot sequence, auth, hot reload | 0 |
| [06-INK-LITE.md](./06-INK-LITE.md) | Envelope, idempotency, budget headers — no routing/fitness | 0 |
| [07-ERRORS-CANCELLATION.md](./07-ERRORS-CANCELLATION.md) | Error codes, cancellation protocol, crash recovery, retry | 0 |
| [08-CONFORMANCE-SUITE.md](./08-CONFORMANCE-SUITE.md) | Fixtures, CI integration, golden transcripts, drift detection | 0 |
| [09-HOSTILE-FIXTURES.md](./09-HOSTILE-FIXTURES.md) | Orphan, refund, disk-full, circuit-breaker, cold-resume, ANSI | 0-2 |
| [10-PHASE-GATES.md](./10-PHASE-GATES.md) | Binary exit criteria per phase, release checklist | all |
| [11-BUDGETS-AND-OBSERVABILITY.md](./11-BUDGETS-AND-OBSERVABILITY.md) | Performance budgets, kill switches, logging, metrics, pulse sink | 0-2 |
| [12-DEFERRED-ARCHITECTURE.md](./12-DEFERRED-ARCHITECTURE.md) | Full INK, PACT, SIPHON, security — Phase 2+ only | 2-3 |

## Reading Order for Phase 0

Start with specs 00 → 01 → 02 → 03 → 05 → 06 → 07 → 08 → 10 → 11. Total ~35K chars, read in 45 minutes.

## Archive

The previous 30-file corpus (SPEC-00 through SPEC-29, ~250K chars) is preserved in [`archive/`](./archive/) for reference. The active spec is the 12 files above.

## Three-Model Audit

See [`SPEC-AUDIT-CONSENSUS.md`](./SPEC-AUDIT-CONSENSUS.md) — consolidated review by VENOM Agent, Claude Opus 4.7, GPT-5.5, and Gemini 3.1 Pro (2026-05-12).

---

## Document Control

When you change behavior in code, update the relevant spec first or in the same PR. Spec drift is a bug.

All commits use the **🐺 (wolf) prefix** + conventional commit format.
