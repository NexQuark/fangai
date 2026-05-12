# 10 — Phase Gates

**Status:** Active · **Date:** 2026-05-12

---

## Phase 0 — Skeleton (Days 1-14)

**Goals:** One agent, one transport, one ledger. Prove the protocol works.

**Exit criteria (ALL must pass):**
- [ ] `GET /.well-known/agent-card.json` returns valid A2A agent card
- [ ] `GET /healthz` returns `{"status": "ok"}`
- [ ] `POST /tasks/send` accepts task, returns `202 Accepted`
- [ ] Task transitions through `submitted → running → completed`
- [ ] SSE stream emits events for each transition
- [ ] Ledger file exists and contains valid JSONL
- [ ] Server crash mid-task → ledger survives → task marked interrupted on restart
- [ ] Echo adapter passes conformance smoke test
- [ ] `pnpm install && pnpm -r build && pnpm -r test` green

**Deliverables:**
- `packages/core/` — server, task state machine, ledger
- `packages/adapters/echo/` — fake adapter for testing
- `packages/cli/` — `fang wrap`, `fang start`
- 10+ conformance fixtures (echo-based)

## Phase 1 — Real Adapters (Days 15-45)

**Goals:** Replace echo with Claude Code, add Cursor + OpenCode.

**Exit criteria:**
- [ ] Claude Code adapter passes 19+ conformance fixtures
- [ ] Cursor adapter passes 19+ conformance fixtures
- [ ] OpenCode adapter passes 19+ conformance fixtures
- [ ] INK-lite headers parsed and validated (envelope, idempotency, budget)
- [ ] Budget headers enforced (token ceiling, duration ceiling)
- [ ] Cancellation works (SIGTERM → SIGKILL after 5s)
- [ ] Multi-agent: 3 ports running simultaneously
- [ ] `@fangai/client` published with `sendMessage`, `streamMessage`

**Deliverables:**
- `packages/adapters/claude/`
- `packages/adapters/cursor/`
- `packages/adapters/opencode/`
- `packages/client/`

## Phase 2 — Seams + Observability (Days 46-90)

**Goals:** Wire failure modes, add pulse sink, PACT-lite.

**Exit criteria:**
- [ ] All 9 hostile fixture categories pass
- [ ] Pulse sink (SQLite) operational
- [ ] Circuit breaker trips after 5 consecutive failures
- [ ] Disk-full policy operational
- [ ] OpenTelemetry trace spans for task lifecycle
- [ ] PACT-lite: versioned config + signed release artifacts
- [ ] Pi persistent adapter operational

**Deliverables:**
- Pulse sink module
- Circuit breaker module
- OpenTelemetry integration
- `packages/adapters/pi/`

## Phase 3 — Full Vision (Days 91+)

**Goals:** Full INK, PACT, SIPHON, fitness routing.

**Exit criteria:**
- [ ] Full INK dispatch language (selectors, routing, counter-offers)
- [ ] PACT constitution (signature-chained, append-only)
- [ ] SIPHON cold-recap merge across agents
- [ ] Fitness-weighted agent selection
- [ ] Recursion guard (depth, cycle, fan-out)
- [ ] Budget propagation with split policies

**Deferred specs (see `12-DEFERRED-ARCHITECTURE.md`):**
- Full INK (SPEC-17)
- PACT (SPEC-18)
- SIPHON (SPEC-27)
- Security Model (SPEC-28)
- Claw (SPEC-22)
- Full Data Structures (SPEC-23 §§23.11-§23.19)

## Release Checklist (Pre-1.0)

- [ ] `pnpm install --frozen-lockfile` green
- [ ] `pnpm -r build` green
- [ ] `pnpm -r test` green (110+ tests)
- [ ] All conformance fixtures pass
- [ ] Docker builds for `Dockerfile.pi` / `Dockerfile.claude`
- [ ] `npm publish @fangai/*` successful
- [ ] CHANGELOG.md updated
- [ ] Security audit (no `shell: true` with user input)
