# 12 — Deferred Architecture (Phase 2+)

**Status:** Deferred · **Date:** 2026-05-12

> These specs are complete and valid but deferred until the running implementation creates feedback pressure. Do NOT implement these until Phase 2 or later.

---

## Deferred Items

### Full INK Dispatch Language (SPEC-17)
- AgentSelector with fitness-weighted routing
- Counter-offer protocol (agent negotiates budget/deadline)
- Recursion guard (max depth 4, cycle detection, fan-out limit 6)
- Budget propagation with split policies (fair/priority/manual)
- Lineage HMAC chain for identity binding and replay defense
- `ink/*` method namespace, two transports (host-tool Phase 1, `/ink` HTTP Phase 2)

### PACT Constitution (SPEC-18)
- Append-only YAML constitution
- Signature-chained amendments
- SoulPump rejection before TaskPump execution
- 10 error codes for constitutional violations
- Phase 3 only — needed when Fang nodes federate or third parties propose amendments

### SIPHON Cold-Recap Merge (SPEC-27)
- Unified extraction pipeline across Pi/Cursor/Claude/OpenCode/A2A
- Multi-agent session merge with conflict resolution
- Non-Cursor recap injection
- Phase 3 only — needed when multiple agents work on overlapping context

### Security Model (SPEC-28)
- 5-layer replay defense (bootstrap, identity, frame replay, transport, audit)
- Trust bootstrap with founder key
- HMAC-signed lineage chain verification
- Audit tool with replay verification
- Phase 2 minimum — needs running system to defend

### Full Data Structures (SPEC-23 §§23.11-§23.19)
- Lineage chain with HMAC
- TaskEnvelope, PactPin, Reservations
- Muscle Identity & Transport Binding
- Checkpoint, Orphan, Harvest types
- SIPHON NormalizedEvent, Distiller, Recap
- CircuitBreaker, Disk-Full Policy
- Audit & Security types
- Consolidated Error & Pulse Catalogue

### Claw System Ops (SPEC-22)
- Whitelist registry for system operations
- Three-layer defense (PACT → Muscle → OS)
- Diagnostic instrument

### Organism Theory
- Body metaphor (Skeleton, Muscles, Nerves, Blood, Memory, Senses, Skin, Bones, Hearts)
- Internal design language only — NOT for user-facing surfaces, API, CLI, or docs

---

## Reading Order for Phase 0 Implementation

1. `00-CHARTER-AND-SCOPE.md` — what Fang is
2. `01-A2A-HTTP-PROFILE.md` — HTTP endpoints and protocol
3. `02-TASK-LIFECYCLE.md` — task model and states
4. `03-CLI-ADAPTER-CONTRACT.md` — adapter interface
5. `05-CONFIG-IDENTITY-BOOT.md` — config and startup
6. `06-INK-LITE.md` — envelope and validation
7. `07-ERRORS-CANCELLATION.md` — error codes and cancellation
8. `08-CONFORMANCE-SUITE.md` — fixtures and CI
9. `10-PHASE-GATES.md` — what "done" means per phase
10. `11-BUDGETS-AND-OBSERVABILITY.md` — budgets and tracing

Total: 10 files, ~35K chars. Read in 45 minutes. Implement in 14 days.
