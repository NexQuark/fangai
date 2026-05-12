# 02 — Task Lifecycle

**Status:** Active · **Date:** 2026-05-12

---

## Task Model

```typescript
interface Task {
  id: string;              // UUIDv7, sortable
  status: 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled';
  submittedAt: string;     // ISO 8601
  startedAt?: string;
  completedAt?: string;
  input: {
    role: 'user';
    parts: Array<{ kind: 'text'; text: string }>;
  };
  output?: {
    role: 'agent';
    parts: Array<{ kind: 'text'; text: string } | { kind: 'artifact'; data: string; mimeType: string }>;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata: {
    agentId: string;
    adapterVersion: string;
    upstreamVersion: string;
    idempotencyKey?: string;
    traceId?: string;
    budget?: { tokens?: number; durationMs?: number; costUsd?: number };
  };
}
```

## Event Stream (SSE)

```
event: task-status
data: {"taskId": "...", "status": "submitted", "ts": "2026-05-12T..."}

event: task-status
data: {"taskId": "...", "status": "running", "ts": "..."}

event: task-output
data: {"taskId": "...", "text": "...partial output...", "ts": "..."}

event: task-output
data: {"taskId": "...", "artifact": {"id": "...", "data": "...", "mimeType": "..."}, "ts": "..."}

event: task-status
data: {"taskId": "...", "status": "completed", "ts": "..."}
```

On `failed` or `cancelled`, the final event includes `error` object.

## Streaming Protocol

1. Client POSTs to `/a2a/jsonrpc` or `/a2a/rest`
2. Server validates request, assigns task ID, returns `202 Accepted`
3. Server spawns CLI adapter, transitions task to `running`
4. Adapter emits `task-output` events as CLI produces stdout
5. CLI exits → adapter parses final output → transitions to `completed`/`failed`
6. Server appends final event to ledger
7. Client can poll `/tasks/{id}` or consume SSE from `/tasks/{id}/events`

## Cancellation

- Client sends `POST /tasks/{id}/cancel`
- Server transitions to `cancelled`, sends SIGTERM to child process
- If child survives 5s after SIGTERM → SIGKILL
- Ledger records: `task-status: cancelled` with `error.code: "TASK_CANCELLED"`

## Resume (Phase 0)

- Cold resume: re-fetch task from ledger by task ID
- No cross-agent merge (SIPHON deferred to Phase 3)
- If task was `running` at crash time → mark `failed` with `error.code: "TASK_INTERRUPTED"`

## Artifacts

- Text output: `{ kind: 'text', text: '...' }`
- File output: `{ kind: 'artifact', data: '<base64>', mimeType: 'text/x-diff' }`
- Inline artifacts ≤ 64 KiB; larger artifacts get `uri` reference
- Artifact IDs are deterministic: `artifact-{task-id}-{index}`

## Workspace Isolation (Phase 0)

- Single shared workspace: `/home/fangai/project`
- No parallel task isolation (one task per agent at a time)
- Phase 1: per-task worktree or temp directory
