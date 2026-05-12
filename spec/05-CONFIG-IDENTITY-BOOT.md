# 05 — Config, Identity, Boot

**Status:** Active · **Date:** 2026-05-12

---

## Configuration (Phase 0)

```yaml
# fang.yaml
agent:
  name: "claude"
  cli: "claude"
  cliArgs: []
  workdir: "/home/fangai/project"
  timeout: 300

server:
  port: 3002
  host: "127.0.0.1"
  apiKey: ""  # empty = no auth

logging:
  level: "info"
  format: "json"  # or "text"

ledger:
  path: "/home/fangai/ledger/claude.jsonl"
  fsync: true
  maxSize: "100MB"
  maxAge: "30d"
```

## Identity

- Each agent is identified by `agentId` = `<provider>-<port>` (e.g., `claude-3002`)
- Agent Card includes `agentId` in `name` field
- Ledger entries include `agentId` for audit trail
- Phase 1+: HMAC-signed lineage (see `12-DEFERRED-ARCHITECTURE.md`)

## Boot Sequence (Phase 0)

1. Load config from `fang.yaml` or CLI args
2. Validate config (required fields, valid port, valid workdir)
3. Detect upstream CLI binary (`which <binary>`)
4. Probe upstream version (`<binary> --version`)
5. Check auth (env var or auth file exists)
6. Initialize ledger (create file if needed, verify write access)
7. Start Express server on configured port
8. Emit `/healthz` → `ok`, `/readyz` → `ok`
9. Log: `agent started agentId=<id> port=<port> version=<upstream>`

If any step fails → exit 1 with structured error to stderr.

## Security (Phase 0)

- Auth: optional shared secret via `FANG_API_KEY` env var or `--api-key` CLI flag
- Transport: HTTP only (no TLS in Phase 0 — localhost binding)
- Input sanitization: never pass untrusted strings to `shell: true`
- Auth middleware: `Bearer <token>` or `X-Api-Key: <token>` header
- Missing/invalid auth → `401 Unauthorized`

## Hot Reload (Phase 1)

- `SIGHUP` → reload config without restarting
- Ledger continues writing during reload
- In-flight tasks are not interrupted
- New config applies to new tasks only
