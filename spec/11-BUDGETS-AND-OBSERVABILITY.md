# 11 — Budgets and Observability

**Status:** Active · **Date:** 2026-05-12

---

## Performance Budgets

| Metric | Default | Hard Limit | Failure Behavior |
|--------|---------|------------|------------------|
| Server startup time | 5s | 15s | Exit 1 |
| Agent-card latency | 50ms | 200ms | Log warning |
| Task accepted latency | 100ms | 500ms | Log warning |
| First stream event | 500ms | 5s | Log warning |
| Cancellation latency | 200ms | 2s | SIGTERM → SIGKILL |
| Adapter timeout | 300s | 600s | SIGKILL + task failed |
| Memory ceiling (idle) | 100MB | 500MB | Restart adapter |
| Max log per task | 10MB | 50MB | Truncate + warning |
| Concurrent tasks (per agent) | 1 | 3 | Queue or reject |
| Ledger write latency | 10ms | 100ms | Degrade (async write) |

Budget enforcement:
- Server startup: measured from `node src/index.ts` to `/healthz` returning `ok`
- Latencies: measured from request arrival to first response byte
- Memory: checked every 30s via `process.memoryUsage()`
- Concurrent tasks: tracked in memory, enforced at task submission

## Kill Switches

| Trigger | Action | Recovery |
|---------|--------|----------|
| Adapter timeout exceeded | SIGKILL child, mark task failed | Manual retry |
| Memory ceiling exceeded | SIGKILL adapter, restart | Auto-restart (systemd) |
| Disk full (95%) | Degrade ledger (async), alert | Free disk space |
| 5 consecutive adapter failures | Trip circuit breaker, reject tasks | Auto-probe after 60s |
| Server OOM | Exit 1 | Auto-restart (systemd) |

## Observability

### Correlation IDs

Every request carries a trace chain:
```
HTTP X-Fang-Trace-Id → Task.correlationId → Adapter process → Ledger entry → Pulse
```

### Structured Logging

```json
{"ts":"2026-05-12T...","level":"info","event":"task_started","taskId":"...","agentId":"...","adapterVersion":"..."}
{"ts":"2026-05-12T...","level":"warn","event":"budget_warning","taskId":"...","budget":{"tokens":1000,"remaining":200}}
{"ts":"2026-05-12T...","level":"error","event":"adapter_failed","taskId":"...","error":{"code":"CLI_RUNTIME_ERROR","message":"..."}}
```

Fields: `ts`, `level`, `event`, `taskId`, `agentId`, `traceId`, plus event-specific fields.

### Metrics (Prometheus-compatible)

| Metric | Type | Labels |
|--------|------|--------|
| `fang_tasks_total` | Counter | `agentId`, `status` |
| `fang_tasks_active` | Gauge | `agentId` |
| `fang_task_duration_seconds` | Histogram | `agentId`, `status` |
| `fang_adapter_exits_total` | Counter | `agentId`, `exitCode` |
| `fang_budget_remaining` | Gauge | `agentId`, `budgetType` |
| `fang_circuit_breaker_state` | Gauge | `agentId` |

### Pulse Sink (Phase 0)

- SQLite append-only database at `~/.fang/pulses.db`
- Schema: `pulses(id, ts, kind, taskId, agentId, data)`
- Retention: configurable age cap (default: 30 days)
- Query: `SELECT * FROM pulses WHERE kind = 'task.failed' AND ts > datetime('now', '-1 day')`

### Pulse Sink (Phase 2)

- Export to external observability (OpenTelemetry, Datadog, etc.)
- Real-time pulse streaming via WebSocket endpoint
- Alerting: pulse query with threshold → webhook

### Health Endpoints

```json
// GET /healthz
{"status": "ok", "agent": "claude", "uptime": 3600}

// GET /readyz
{
  "status": "ok",
  "agent": "claude",
  "agentAlive": true,
  "ledger": "healthy",
  "disk": {"used": "45%", "available": "55GB"},
  "memory": {"used": "85MB", "ceiling": "500MB"},
  "circuitBreaker": "closed",
  "concurrentTasks": 1
}
```

### Redaction Rules

- Never log: API keys, tokens, passwords, PII
- Redact: `Authorization` headers, `X-Api-Key` headers
- Truncate: prompt text to 200 chars in logs (full text in ledger)
- Mask: file paths containing `home/` → `~/...`
