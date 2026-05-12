# 06 — INK Lite (Envelope Only)

**Status:** Active · **Date:** 2026-05-12

> Phase 0 INK subset. Full INK (routing, fitness, counter-offers, recursion) deferred to Phase 3.

---

## Envelope

```typescript
interface InkEnvelope {
  inkVersion: '1';
  correlationId: string;           // uuidv7
  taskId: string;                  // uuidv7
  parentId: string | null;         // null for root tasks
  depth: number;                   // 0 for root, incremented for subtasks
  intent: string;                  // verb-object, ≤ 60 chars
  prompt: string;                  // the actual ask, ≤ 64 KiB
  budget?: {
    tokens?: number;
    durationMs?: number;
    costUsd?: number;
  };
  deadline?: string;               // ISO 8601
  meta?: {
    labels?: Record<string, string>;
    priority?: 0 | 1 | 2 | 3;
  };
}
```

## Idempotency

- `correlationId` must be unique within ledger window (24 hours)
- Duplicate `correlationId` → return cached result, do not re-execute
- Error code: `INK_DUP_CORRELATION`

## Validation Rules

| Field | Rule | Error Code |
|-------|------|------------|
| `inkVersion` | exactly `'1'` | `INK_VERSION` |
| `correlationId` | uuidv7, unique | `INK_DUP_CORRELATION` |
| `prompt` | ≤ 64 KiB | `INK_PROMPT_TOO_LARGE` |
| `budget.tokens` | positive integer | `INK_BUDGET_INVALID` |
| `deadline` | > now + 1s, ≤ now + 24h | `INK_DEADLINE_INVALID` |

## Headers (HTTP mapping)

| Header | Maps to | Required |
|--------|---------|----------|
| `X-Fang-Ink-Version` | `inkVersion` | Yes |
| `X-Fang-Correlation-Id` | `correlationId` | Yes |
| `X-Fang-Task-Id` | `taskId` | Yes |
| `X-Fang-Parent-Id` | `parentId` | No |
| `X-Fang-Depth` | `depth` | No |
| `X-Fang-Intent` | `intent` | No |
| `X-Fang-Budget-Tokens` | `budget.tokens` | No |
| `X-Fang-Budget-Duration-Ms` | `budget.durationMs` | No |
| `X-Fang-Budget-Cost-Usd` | `budget.costUsd` | No |
| `X-Fang-Deadline` | `deadline` | No |
| `X-Fang-Trace-Id` | `meta.labels.traceId` | No |
| `X-Fang-Priority` | `meta.priority` | No |

## Reply

```typescript
interface InkReply {
  correlationId: string;
  taskId: string;
  status: 'ok' | 'partial' | 'failed' | 'timeout';
  output: {
    text?: string;
    artifacts?: Array<{ id: string; data: string; mimeType: string }>;
  };
  error?: {
    code: string;
    message: string;
  };
  spentBudget?: {
    tokens?: number;
    durationMs?: number;
    costUsd?: number;
  };
}
```

## Deferred (Phase 3)

- AgentSelector (skill/any/direct routing with fitness scoring)
- Counter-offer protocol (agent can negotiate budget/deadline)
- Recursion guard (max depth, cycle detection, fan-out limits)
- Budget propagation with split policies (fair/priority/manual)
- Lineage HMAC chain (identity binding, replay defense)
