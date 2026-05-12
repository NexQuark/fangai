# 00 — Charter and Scope

**Status:** Active · **Author:** VENOM + Cursor Opus 4.7 + GPT-5.5 + Gemini 3.1 Pro · **Date:** 2026-05-12

---

## One Sentence

**Fang turns CLI coding agents into standards-based A2A servers** so orchestrators can delegate work without turning each full agent into a giant MCP tool schema in the caller's context.

## What Fang Is

- A **protocol bridge**: subprocess in, A2A out (and reverse for control messages).
- A **family of adapters**: one module per agent translating native stdout/stdin protocols into A2A task lifecycle + artifacts.
- A **host process** using `@a2a-js/sdk` for protocol compliance (Agent Card, JSON-RPC, REST/SSE).
- A **deployment story**: Docker, systemd, health checks — "works on my laptop" → "works in a fleet."

## What Fang Is Not (v0.x)

- A replacement for the CLI agent's internal tools (grep, edit, test) — those stay inside the agent.
- A full orchestrator — routing/cost/fan-out is a separate product concern.
- A guarantee that every agent is pleasant to wrap (TUI-only, no machine-readable mode) — Tier-3 agents remain best-effort.

## Personas

| Persona | Need |
|---------|------|
| **Host operator** | Run `fang wrap` / `fang start`, stable ports, auth, logs |
| **Agent author** | Clear adapter contract, tests, fixtures |
| **Orchestrator builder** | Discoverable Agent Card, predictable JSON-RPC |
| **Pi / IDE integrator** | Persistent RPC — no pointless respawn |

## Canonical Terms

| Term | Definition |
|------|------------|
| **A2A** | Agent2Agent protocol — agent card discovery, JSON-RPC methods, task lifecycle, SSE streaming |
| **Agent Card** | JSON document describing an agent's capabilities, skills, transports |
| **Adapter** | Module translating a CLI agent's native protocol to/from A2A events |
| **Bridge** | Express HTTP server + SDK handlers wrapping one CLI agent |
| **Task** | Unit of work: submit → run → complete/fail/cancel |
| **Ledger** | Append-only JSONL log of all task events (crash-survivable) |
| **Pulse** | Internal lifecycle event (submitted, running, completed, failed, cancelled) |
| **Fixture** | Golden transcript of real CLI stdout used for adapter conformance testing |
| **Conformance** | Adapter passes all fixtures for its upstream version without regression |

## Out of Scope Until Explicitly Scheduled

- First-class multi-tenant SaaS
- GUI for configuration
- Automatic installation of upstream CLIs
- Full INK dispatch language (see `12-DEFERRED-ARCHITECTURE.md`)
- PACT constitution (see `12-DEFERRED-ARCHITECTURE.md`)
- SIPHON cold-recap merge (see `12-DEFERRED-ARCHITECTURE.md`)

## Research Program

Upstream CLI protocols change weekly. This spec must track:
- Pi `--mode rpc` event types (currently ~30) — source: `github.com/badlogic/pi-mono`
- Claude Code stream-json format — source: `github.com/anthropics/claude-code`
- Cursor Agent JSONL protocol — source: Cursor SDK
- OpenCode `--format json` output — source: `github.com/anomalyco/opencode`

Each upstream change triggers: version probe → fixture update → conformance test → spec revision.

## Naming

- **Brand:** Fang
- **Packages:** `@fangai/*` (scoped npm)
- **CLI binary:** `fang`
- **Commit convention:** 🐺 + conventional commit format
