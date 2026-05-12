# Risks and open questions

## High impact

| Risk | Mitigation |
|------|------------|
| **Upstream CLI breaks output format** | Pin versions in docs; adapter version probes; fixtures in CI |
| **A2A SDK breaking changes** | Lock semver range; spec alignment section each release |
| **Persistent mode bugs** (task isolation, leaks) | Strict task IDs; stress tests; kill switch |
| **Security: command injection** | Never `shell: true` with user input; allowlists for adapters |

## Medium

| Risk | Mitigation |
|------|------------|
| Silent **generic** adapter masks misconfiguration | Warn/error flags (Phase 1) |
| **Windows vs POSIX** spawn differences | CI matrix; document WSL for dev |
| **TUI agents** spew ANSI | Strip or refuse unless raw mode documented |

## Open questions (need decisions)

1. **Canonical Agent Card URL** — single source in SDK + our aliases; document for clients.
2. **`fang stop`** — **partially addressed:** `fang stop` probes `GET /health` for `bridge: "fang"` then frees the port (`kill-port`). Full PID tracking / supervisor is still optional for multi-process setups.
3. **@fangai/client** — thin re-export vs full ergonomic API; timeline vs “use SDK client.”
4. **Auth default** — **partially addressed:** optional shared secret via `FANG_API_KEY` / `--api-key` (Bearer or `X-Api-Key`); defaults off. Generated per-client tokens / OAuth remain future work.
5. **Multi-agent single process** — out of scope until explicitly scheduled.

## Resolved in spec (do not reopen without ADR)

- **Server stack:** Express + `@a2a-js/sdk`, not Hono-first for A2A HTTP.
- **Aider:** structured `--json` path is real in v3 — update all tier tables.
