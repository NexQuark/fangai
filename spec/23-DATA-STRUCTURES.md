# SPEC 23 — Complete Data Structures

> Every type that crosses organ boundaries. Single file: `packages/body/src/types.ts`. JSON Schema mirrors in `packages/body/contracts/`. CI enforces parity.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-18

---

## 23.1 Frame — The Top-Level Envelope

```ts
export type Frame =
  | { kind: 'ink.dispatch'; payload: InkPayload }
  | { kind: 'ink.progress'; payload: InkProgress }
  | { kind: 'ink.result';   payload: InkResult & { correlationId: string } }
  | { kind: 'ink.decline';  payload: InkDecline }
  | { kind: 'ink.extend';   payload: InkExtend }
  | { kind: 'a2a.task';     payload: A2ATaskFrame };

export interface A2ATaskFrame {
  taskId: string;
  message: { role: 'user'|'agent'; parts: Array<{ text?: string; data?: unknown }> };
  metadata?: Record<string, unknown>;
}
```

---

## 23.2 Blood — The Metabolic Ledger

```ts
export type BloodEntryType =
  | 'body.boot' | 'body.die'
  | 'task.start' | 'task.end' | 'task.checkpoint'
  | 'pulse'
  | 'ink.dispatched' | 'ink.received' | 'ink.declined' | 'ink.completed' | 'ink.extended'
  | 'pact.passed' | 'pact.rejected'
  | 'memory.write'
  | 'muscle.connect' | 'muscle.disconnect' | 'muscle.degraded';

export interface BloodEntry {
  id: string;                  // uuidv7
  ts: string;                  // ISO8601
  type: BloodEntryType;
  taskId?: string;
  rootTaskId?: string;
  correlationId?: string;
  agentId?: string;
  payload?: unknown;
  cost?: { tokens?: number; usd?: number; durationMs?: number };
  redacted?: boolean;          // true if secrets were scrubbed pre-write
}
```

**Storage:** Append-only JSONL at `.fang/blood/YYYY-MM-DD.jsonl`. Rotation by date.

---

## 23.3 Memory — SIPHON Storage

```ts
export type MemoryKind = 'decision' | 'observation' | 'preference' | 'failure' | 'fact';

export interface MemoryRecord {
  id: string;
  repoHash: string;
  agentId: string;             // attribution
  ts: string;
  kind: MemoryKind;
  subject: string;             // ≤ 80 chars
  body: string;                // markdown, ≤ 4 KiB
  refs: {
    taskId?: string;
    correlationId?: string;
    commitSha?: string;
    files?: string[];          // relative paths
  };
  tags?: string[];
  embedding?: number[];        // optional; cosine-similarity-indexable
  supersedes?: string;         // id of older record this replaces
}
```

**Storage layout:** MEMORY.md with sections by repoHash, agentId. Records serialized as HTML comments + markdown. Query API: `memory.query({repoHash, agent?, kind?, since?, limit, relevance?}) → MemoryRecord[]`.

---

## 23.4 Muscles & Senses — Configuration

```ts
export type MuscleKind = 'a2a-http' | 'a2a-stdio' | 'host-tool' | 'claw' | 'fake' | 'custom';

export interface MuscleConfig {
  id: string;                        // unique within body
  kind: MuscleKind;
  tier: 0 | 1 | 2 | 3;
  skills: string[];                  // for selector kind='skill'
  endpoint?: string;                 // URL for a2a-http
  command?: string;                  // CLI for a2a-stdio
  apiKey?: string;
  repoHashes?: string[];             // bodies this muscle is authorized for; '*' = all
  mcp?: McpDeclaration[];
  costTier?: 'low' | 'mid' | 'high';
  model?: string;
  maxConcurrency?: number;           // default 1
}

export interface McpDeclaration {
  serverId: string;
  transport: 'stdio' | 'http';
  command?: string;                  // for stdio
  url?: string;                      // for http
  tools?: string[];                  // explicit whitelist; '*' = all advertised
  resources?: string[];
  env?: Record<string, string>;
}
```

---

## 23.5 INK — Selectors & Budget

```ts
export type AgentSelector =
  | { kind: 'direct'; agentId: string }
  | { kind: 'skill';  skill: string;   constraints?: SelectorConstraints; fallback?: AgentSelector[] }
  | { kind: 'any';    tier?: 0|1|2|3;  constraints?: SelectorConstraints; fallback?: AgentSelector[] };

export interface SelectorConstraints {
  costTier?: 'low' | 'mid' | 'high';
  model?: string;
  minFitness?: number;
  excludeAgents?: string[];
  requireRepoHash?: string;
  maxLoadConcurrency?: number;
}

export interface BudgetRequest {
  tokens?: number;
  durationMs?: number;
  costUsd?: number;
  recursiveSlots?: number;
}

export interface BudgetAllocation {
  granted: BudgetRequest;
  splitPolicy: 'fair' | 'priority' | 'manual';
  parentRemaining: BudgetRequest;
  refundOnCompletion: boolean;
}
```

---

## 23.6 INK — Payload & Frames

```ts
export interface InkPayload {
  inkVersion: '1';
  correlationId: string;
  rootTaskId: string;
  parentTaskId: string | null;
  lineage: LineageHop[];
  depth: number;
  repoHash: string;
  pactRef: { version: number; sha: string };
  selector: AgentSelector;
  intent: string;
  prompt: string;
  inputs: ArtifactRef[];
  budget: BudgetRequest;
  deadline: string;
  replyTopic: ReplyChannel;
  tracing: Tracing;
  meta?: InkMeta;
}

export interface LineageHop { taskId: string; agentId: string; ts: string; }
export interface Tracing { traceId: string; spanId: string; baggage?: Record<string,string>; }
export interface InkMeta { labels?: Record<string,string>; priority?: 0|1|2|3; dryRun?: boolean; }

export type ReplyChannel =
  | { kind: 'host-tool'; channelId: string }
  | { kind: 'http-sse';  url: string; auth?: string }
  | { kind: 'ledger-only' };

export interface InkProgress {
  correlationId: string;
  ts: string;
  percent?: number;
  message: string;
  artifactDelta?: Artifact;
  budgetSpentDelta?: BudgetRequest;
}

export interface InkResultBase {
  correlationId: string;
  spentBudget: BudgetRequest;
  fitnessSignal: FitnessSignal;
}

export type InkResult =
  | (InkResultBase & { status: 'ok';      artifacts: Artifact[] })
  | (InkResultBase & { status: 'partial'; artifacts: Artifact[]; warnings: string[] })
  | (InkResultBase & { status: 'failed';  error: ErrorEnvelope })
  | (InkResultBase & { status: 'timeout'; partialArtifacts: Artifact[] });

export interface FitnessSignal {
  quality: number;            // -1..1 self-reported
  latencyMs: number;
  selfReportedTokens?: number;
  declinedSubdispatches?: number;
}

export interface InkDecline {
  correlationId: string;
  reason: 'capability-mismatch' | 'budget-too-low' | 'pact-conflict'
        | 'overloaded' | 'repo-not-authorized' | 'self-confidence-low';
  detail?: string;
  counterOffer?: {
    selector: AgentSelector; intent: string;
    budgetEstimate: BudgetRequest; notes?: string;
  };
}

export interface InkExtend {
  correlationId: string;
  additional: BudgetRequest;
  reason: string;
}
```

---

## 23.7 Pulse & Fitness

```ts
export type PulseKind =
  | 'body.booting' | 'body.ready' | 'body.dying'
  | 'task.started' | 'task.finished' | 'task.failed' | 'task.checkpoint'
  | 'ink.dispatched' | 'ink.received' | 'ink.declined' | 'ink.completed'
  | 'pact.passed' | 'pact.rejected'
  | 'muscle.mounted' | 'muscle.unmounted' | 'muscle.degraded' | 'muscle.recovered'
  | 'memory.written'
  | 'soul.rejection'
  | 'budget.starved' | 'budget.exhausted';

export interface Pulse<K extends PulseKind = PulseKind> {
  id: string; ts: string; kind: K; source: string; data: unknown;
}

export interface Fitness {
  agentId: string;
  score: number;              // 0..1
  components: {
    successRate: number;      // ok / total in window
    latencyP50Ms: number;     // normalized → 0..1 (lower=better)
    pactCompliance: number;   // 1 - (rejects / total)
    costEfficiency: number;   // quality / tokens, normalized
    recency: number;          // exp-decay of lastSeen
  };
  sampleSize: number;
  ttlMs: number;              // recompute after
  computedAt: string;
}
```

---

## 23.8 Artifacts & Sessions

```ts
export interface Artifact {
  id: string;
  mimeType: string;
  uri?: string;
  inline?: string;
  sha256?: string;
  meta?: Record<string, unknown>;
}

export interface ArtifactRef extends Pick<Artifact,'id'|'mimeType'|'uri'|'inline'|'sha256'> {}

export interface SessionTrace {
  sessionId: string;
  agentId: string;
  repoHash: string;
  rootTaskId: string;
  startedAt: string;
  endedAt: string;
  frames: Frame[];
  finalArtifacts: Artifact[];
}
```

---

## 23.9 PACT Rules

```ts
export interface PactRules {
  recursion: { maxDepth: number; maxFanOut: number };
  budgets: { global: BudgetCap; perAgent: Record<string, BudgetCap> };
  paths: { allow: string[]; deny: string[] };
  agents: { allow: string[]; deny: string[]; tierCaps?: Record<0|1|2|3, string[]> };
  forbidden: string[];        // regex strings
  claw: {
    allowedTools: string[];
    allowedServices: string[];
    readOnlyByDefault: boolean;
    maxOutputLines: number;
    maxArgChars: number;
    argDenylist: string[];
  };
  inheritance: 'extend' | 'override';
  allowOverride: boolean;
}

export interface BudgetCap { tokensPerHour?: number; costUsdPerDay?: number; }

export interface Pact {
  schemaVersion: 1;
  repoHash: string;
  version: number;
  prev: string | null;
  issuedAt: string;
  issuedBy: string;
  signature: string;
  ttl?: string;
  rules: PactRules;
}
```

---

## 23.10 Error Codes

```ts
export interface ErrorEnvelope {
  code: string;
  message: string;
  recoverable: boolean;
  data?: Record<string, unknown>;
}

export type InkErrorCode =
  | 'INK_VERSION' | 'INK_DUP_CORRELATION' | 'INK_LINEAGE_MISMATCH' | 'INK_LINEAGE_FORGED'
  | 'INK_WRONG_BODY' | 'INK_STALE_PACT' | 'INK_PROMPT_TOO_LARGE' | 'INK_INPUTS_OVERSIZE'
  | 'INK_DEADLINE_INVALID' | 'INK_BUDGET_OVERDRAW' | 'INK_BUDGET_EXHAUSTED'
  | 'INK_RECURSION_LIMIT' | 'INK_CYCLE_DETECTED' | 'INK_FANOUT_LIMIT'
  | 'INK_NO_CANDIDATE' | 'INK_TIMEOUT' | 'INK_DECLINED';

export type PactErrorCode =
  | 'PACT_WRONG_BODY' | 'PACT_FROM_FUTURE' | 'PACT_AGENT_DENIED'
  | 'PACT_DEPTH_EXCEEDED' | 'PACT_FORBIDDEN_OP' | 'PACT_PATH_FORBIDDEN'
  | 'PACT_BUDGET_EXCEEDED' | 'PACT_CLAW_TOOL_DENIED' | 'PACT_SIGNATURE_INVALID'
  | 'PACT_PREV_CHAIN_BROKEN';

export type MuscleErrorCode =
  | 'MUSCLE_UNREACHABLE' | 'MUSCLE_CRASHED' | 'MUSCLE_PROTOCOL_ERROR'
  | 'MUSCLE_TIMEOUT' | 'MUSCLE_UNMOUNTED' | 'MUSCLE_OVERLOADED';

export type SiphonErrorCode =
  | 'SIPHON_PARSE_FAIL' | 'SIPHON_NO_DECISIONS' | 'SIPHON_DUP' | 'SIPHON_OVERSIZE';
```

**JSON Schema mirrors:** `packages/body/contracts/`. CI check (`scripts/check-schema-parity.ts`) diffs inferred TS types against schemas → fails build on drift.

🐙
