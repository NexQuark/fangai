# 07 — Errors and Cancellation

**Status:** Active · **Date:** 2026-05-12

---

## Error Codes

### Server Errors

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `SERVER_INTERNAL` | 500 | Unhandled server error |
| `SERVER_OVERLOAD` | 503 | Too many concurrent tasks |
| `SERVER_SHUTDOWN` | 503 | Server is shutting down |

### Task Errors

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `TASK_NOT_FOUND` | 404 | Task ID does not exist |
| `TASK_ALREADY_COMPLETED` | 409 | Task already in terminal state |
| `TASK_CANCELLED` | 409 | Task was cancelled by client |
| `TASK_TIMEOUT` | 408 | Task exceeded adapter timeout |
| `TASK_INTERRUPTED` | 500 | Server crashed mid-task |
| `TASK_BUDGET_EXCEEDED` | 402 | Task exceeded budget limit |

### Adapter Errors

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `CLI_RUNTIME_ERROR` | 500 | CLI crashed or auth failed |
| `CLI_TIMEOUT` | 408 | CLI exceeded timeout |
| `CLI_KILLED` | 500 | CLI was SIGKILLed (hung) |
| `CLI_CANCELLED` | 409 | CLI was SIGINTed |
| `CLI_UNKNOWN_ERROR` | 500 | Unclassified CLI failure |
| `ADAPTER_PARSE_ERROR` | 500 | Adapter could not parse CLI output |
| `ADAPTER_NO_OUTPUT` | 500 | CLI produced no parseable output |

### Validation Errors

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INK_VERSION` | 400 | Invalid INK version |
| `INK_DUP_CORRELATION` | 409 | Duplicate correlation ID |
| `INK_PROMPT_TOO_LARGE` | 413 | Prompt exceeds 64 KiB |
| `INK_BUDGET_INVALID` | 400 | Invalid budget value |
| `INK_DEADLINE_INVALID` | 400 | Invalid deadline |

## Error Response Format

```json
{
  "error": {
    "code": "TASK_TIMEOUT",
    "message": "Task timed out after 300s",
    "details": {
      "taskId": "task-123",
      "elapsedMs": 300123,
      "adapterTimeoutMs": 300000
    }
  },
  "correlationId": "corr-456"
}
```

## Cancellation Protocol

1. Client: `POST /tasks/{id}/cancel`
2. Server: validate task is `running` → transition to `cancelling`
3. Server: send SIGTERM to child process
4. Server: wait up to 5s for graceful exit
5. If still running → send SIGKILL
6. Server: transition to `cancelled`, append to ledger
7. Server: return `200 OK` with final task state

## Resume After Crash

- On server restart, scan ledger for tasks in `running` or `cancelling` state
- Mark all as `failed` with `error.code: "TASK_INTERRUPTED"`
- Emit pulse: `task.interrupted` for each
- No auto-retry (client decides)

## Retry Policy (Client-Side)

- `408` / `500` / `503` → retry with exponential backoff (max 3 attempts)
- `400` / `401` / `404` / `409` / `413` → do NOT retry
- Use same `correlationId` for idempotent retries
