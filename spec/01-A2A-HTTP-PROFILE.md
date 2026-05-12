# 01 — A2A HTTP Profile

**Status:** Active · **Date:** 2026-05-12

---

## Server Stack

- **Framework:** Express.js (via `@a2a-js/sdk`)
- **Protocol:** JSON-RPC 2.0 over HTTP POST
- **Streaming:** SSE for task events
- **Package layout:** `pnpm` workspace with `@fangai/core`, `@fangai/cli`, `@fangai/client`

## Endpoints (Phase 0)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/agent-card.json` | GET | A2A agent discovery |
| `/healthz` | GET | Health check (server alive) |
| `/readyz` | GET | Readiness check (agent ready) |
| `/a2a/jsonrpc` | POST | JSON-RPC 2.0 task submission |
| `/a2a/rest` | POST | HTTP+JSON REST task submission |
| `/tasks/{id}` | GET | Task status lookup |
| `/tasks/{id}/events` | GET | SSE stream of task events |

## Agent Card (required fields)

```json
{
  "name": "fang-<agent>",
  "version": "0.1.0",
  "description": "A2A bridge for <agent>",
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [{"name": "code-edit", "description": "Edit code files"}],
  "capabilities": {"streaming": true, "pushNotifications": false},
  "security": {},
  "url": "http://localhost:<port>",
  "preferredTransport": "jsonrpc"
}
```

## Task Lifecycle States

```
submitted → running → completed
                      → failed
                      → cancelled
```

State transitions are irreversible (no `running → submitted`).

## Idempotency

- `X-Fang-Idempotency-Key` header (UUIDv7 recommended)
- Duplicate key → return previous response, do not re-execute
- Key expires after 24 hours

## Budget Headers (Phase 0 subset)

| Header | Purpose | Format |
|--------|---------|--------|
| `X-Fang-Budget-Tokens` | Token ceiling | integer |
| `X-Fang-Budget-Duration-Ms` | Wall-clock ceiling | integer |
| `X-Fang-Budget-Cost-Usd` | Cost ceiling | float |
| `X-Fang-Trace-Id` | Correlation ID | UUIDv7 |

## Security (Phase 0)

- Optional shared secret via `FANG_API_KEY` / `--api-key` (Bearer or `X-Api-Key`)
- Defaults: auth OFF
- Never `shell: true` with untrusted strings
- Sandboxing is agent-dependent — Fang documents flags, does not promise kernel-level isolation

## Version Matrix

| Version | Agent | CLI Version | Adapter Status | Known Drifts |
|---------|-------|-------------|----------------|--------------|
| v0.1 | Claude Code | latest | stable | stream-json format changes on minor releases |
| v0.1 | Cursor Agent | latest | stable | JSONL event shape varies by model |
| v0.1 | OpenCode | latest | stable | `--format json` nesting may change |
| v0.1 | Pi | latest | stable | `--mode rpc` event types evolve frequently |

Each upstream minor release triggers re-verification of all fixtures.
