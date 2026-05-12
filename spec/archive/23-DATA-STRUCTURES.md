# SPEC 23 — Complete Data Structures

> Every type that crosses organ boundaries. Single file: `packages/body/src/types.ts`. JSON Schema mirrors in `packages/body/contracts/`. CI enforces parity.

**Status:** Draft (Reconciled — Round 4) · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-18  
**Reconciles:** SPEC-24, SPEC-25, SPEC-26, SPEC-27, SPEC-28 (see SPEC-29 changelog)

> **Source-of-truth contract.** Sections 23.1–23.10 describe the original Phase-0 core. Sections 23.11–23.18 promote every cross-organ type that was first introduced inline in SPEC-24 through SPEC-28. **No other spec may redefine these types.** Other specs reference them by section number (e.g. *"see SPEC-23.12 for `TaskEnvelope`"*). CI checks for duplicate `export interface`/`export type` declarations across `packages/body/src/**` and fails on drift.

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

export interface LineageHop {
  taskId: string;
  agentId: string;
  ts: string;
  mac: string;                 // hmac chain — see §23.11
}
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

---

## 23.11 Lineage Chain (HMAC binding)

> Promoted from SPEC-28.2. The `mac` field on `LineageHop` (see §23.6) is computed using a per-agent binding secret known only to the body. Verification rejects forged or reordered hops.

```ts
// packages/body/src/identity/lineage-mac.ts
export interface BindingSecretsTable {
  get(agentId: string): Buffer;        // 32-byte secret
}

export function computeLineageMac(
  prevHops: LineageHop[],
  hop: Omit<LineageHop, 'mac'>,
  secret: Buffer,
): string;                             // hmac-sha256, hex

export function verifyLineageMacChain(
  lineage: LineageHop[],
  secrets: BindingSecretsTable,
): boolean;
```

**Invariants**

- Every hop's `mac` covers the canonical serialization of all prior hops plus the current hop's `taskId|agentId|ts` (the `mac` field itself is excluded).
- `BindingSecretsTable` is in-memory only; rooted in `.fang/secrets.enc` (sealed with the operator public key, decrypted at boot).
- `verifyLineageMacChain` runs in constant time per hop (libsodium `constantTimeEqual`).

---

## 23.12 TaskEnvelope, PactPin, Reservations

> Promoted from SPEC-24.3 and SPEC-24.4. The envelope is the body's per-task working set: it pins the PACT version that authorized the frame and tracks every budget reservation owned by the task.

```ts
// packages/body/src/hearts/task-envelope.ts
export interface PactPin {
  version: number;
  sha: string;                         // canonical sha256 of the PACT YAML
}

export interface TaskEnvelope {
  frame: InkPayload;
  pactPin: PactPin;                    // PACT under which this task was admitted
  signedAt: string;                    // ISO8601, set by SoulPump on evaluation
  reservationIds: string[];            // active BudgetReservation rows (see §23.12 below)
  policy?: { onOrphan?: 'cancel' | 'harvest'; harvestMaxDurationMs?: number };
}

export interface ReserveRequest {
  rootTaskId: string;
  taskId: string;
  agentId: string;
  granted: BudgetRequest;
  parentReservationId?: string;
  cap: BudgetCap;
}

export interface Reservation {
  id: string;                          // uuidv7
  rootTaskId: string;
  taskId: string;
  agentId: string;
  granted: BudgetRequest;
  parentReservationId?: string;
  state: 'active' | 'released' | 'refunded';
  createdAt: string;
}

export type ReserveResult =
  | ({ ok: true } & Reservation)
  | { ok: false; code: 'BUDGET_RESERVATION_DENIED';
      detail: { current: number; proposed: number; cap: number } };

export interface FanoutReserveRequest {
  rootTaskId: string;
  parentTaskId: string;
  children: Array<{ selector: AgentSelector; budget: BudgetRequest }>;
}

export interface FanoutReservation {
  id: string;                          // referenced by `ink/dispatch.fanoutReservationId`
  rootTaskId: string;
  parentTaskId: string;
  perChild: Array<{ index: number; reservationId: string }>;
  createdAt: string;
}
```

**Storage:** Envelopes live in `TaskPump.envelopes` (in-memory map keyed by `correlationId`); the canonical persistence is the `task.checkpoint` ledger entry (see §23.14). Reservations live in `BudgetReservation` (in-memory) and mirror to the ledger via `budget.reserved` / `budget.refunded` pulses.

---

## 23.13 Muscle Identity & Transport Binding

> Promoted from SPEC-28.2. The body owns transport-level identity for every muscle. `agentId` claimed in a frame must match the bound identity of the sender.

```ts
// packages/body/src/muscles/identity.ts
export type BindingKind = 'pid' | 'mtls' | 'bearer' | 'pipe' | 'in-process';

export interface BindingProof {
  pid?: number;
  fingerprint?: string;            // mTLS cert sha256
  tokenId?: string;                // bearer key id (NOT the token)
  pipePath?: string;
  inProcessHandle?: symbol;        // unforgeable in JS
}

export interface MuscleIdentity {
  muscleId: string;
  bindingKind: BindingKind;
  bindingProof: BindingProof;
  boundAt: string;                 // ISO8601
}

export interface TransportInbound {
  muscleId?: string;               // optional hint; identity is the source of truth
  identity: MuscleIdentity;
  receivedAt: string;
}

export interface SignedInk {
  payload: InkPayload;
  signedAt: string;                // body's freshness stamp
  hmac: string;                    // hmac-sha256(canonicalize(payload || signedAt), bindingSecret(sender))
}
```

**Adapter contract:** Every `Muscle` implementation MUST expose `proveIdentity(): Promise<MuscleIdentity>`; the registry rejects mounts that cannot prove identity in a way that matches their `MuscleConfig.id`.

---

## 23.14 Checkpoint, Orphan, Harvest

> Promoted from SPEC-24.1 and SPEC-26.1–26.3. The checkpoint is the resumption coordinate; the orphan record is the post-mortem; the harvest manifest is the salvage receipt.

```ts
// packages/body/src/blood/checkpoint.ts
export type TaskCheckpointState =
  | 'queued' | 'dispatched' | 'running' | 'awaiting-child' | 'completing';

export interface ChildCompletion {
  correlationId: string;
  taskId: string;
  status: 'ok' | 'partial' | 'failed' | 'timeout';
  artifactsSha: string;            // hash for idempotent replay
  sealedAt: string;
}

export interface TaskCheckpoint {
  id: string;                      // uuidv7
  ts: string;
  rootTaskId: string;
  taskId: string;
  agentId: string;
  parentTaskId: string | null;
  lineage: LineageHop[];
  depth: number;
  state: TaskCheckpointState;
  pactPin: PactPin;                // see §23.12
  budgetRemaining: BudgetRequest;
  reservationIds: string[];
  childCompletions: ChildCompletion[];
  resultHash?: string;             // set in 'completing' state
  resumePolicy: 'auto' | 'prompt' | 'orphan';
  deadline: string;
  sealedForShutdown?: boolean;     // set on graceful body.die
}

export interface OrphanCause {
  cause: 'muscle.disconnect' | 'aged-out' | 'ancestor-orphaned' | 'no-checkpoint'
       | 'pact-evicted' | 'budget-no-longer-available' | 'deadline-passed';
  muscleId?: string;
  ancestor?: string;
  reason?: string;
}

export interface OrphanRecord {
  taskId: string;
  rootTaskId: string;
  agentId: string;
  cause: OrphanCause;
  orphanedAt: string;
  artifacts: Artifact[];
  spentBudget: BudgetRequest;
  artifactBytes: number;
}

export interface OrphanPolicy {
  onOrphan: 'cancel' | 'harvest';        // default 'cancel'
  harvestMaxDurationMs?: number;          // PACT-capped
}

export interface HarvestManifest {
  rootTaskId: string;
  taskId: string;
  originalIntent: string;
  agentId: string;
  spentBudget: BudgetRequest;
  sealedAt: string;
  reason: string;
  artifacts: Array<{ id: string; filename: string; mimeType: string }>;
}

export interface ReplayPlan {
  resume:        Array<{ taskId: string; cp: TaskCheckpoint }>;
  harvest:       Array<{ taskId: string; cp: TaskCheckpoint }>;
  orphan:        Array<{ taskId: string; reason: OrphanCause['cause'] }>;
  verifyResult:  Array<{ taskId: string; expectedHash: string }>;
}

export interface GcReport {
  reapedTasks: number;
  freedBytes: number;
  harvested: string[];             // taskIds moved to .fang/orphans/
}
```

**Storage:** Checkpoints serialize as `BloodEntry { type: 'task.checkpoint', payload: TaskCheckpoint }` so they share rotation, audit, and encryption with the rest of the ledger. Harvest manifests live at `.fang/orphans/<rootTaskId>/<taskId>/manifest.json`.

---

## 23.15 SIPHON: NormalizedEvent, Distiller, Recap

> Promoted from SPEC-27. One pipeline (parse → distill → merge) shared across Pi, Cursor, Claude, OpenCode, A2A.

```ts
// packages/body/src/memory/siphon/source.ts
export type SessionFormat =
  | 'pi-jsonl' | 'cursor-transcript' | 'claude-stream-json'
  | 'opencode-events' | 'a2a-frames' | 'unknown';

export interface SessionSource {
  sessionId: string;
  agentId: string;
  repoHash: string;
  format: SessionFormat;
  rootTaskId?: string;
  startedAt: string;
  endedAt?: string;
  stream(): AsyncIterable<Buffer>;
}

// packages/body/src/memory/siphon/normalized.ts
export type NormalizedEventKind =
  | 'user-prompt' | 'agent-thought' | 'agent-reply'
  | 'tool-call' | 'tool-result'
  | 'file-edit' | 'file-create' | 'file-delete'
  | 'command-run' | 'commit'
  | 'dispatch-out' | 'dispatch-in' | 'dispatch-result'
  | 'error';

export interface NormalizedEvent {
  ts: string;
  agentId: string;
  sessionId: string;
  kind: NormalizedEventKind;
  text?: string;
  payload?: unknown;
  refs?: {
    files?: string[];
    commits?: string[];
    correlationId?: string;
    taskId?: string;
  };
}

export interface SessionParser {
  readonly format: SessionFormat;
  match(src: SessionSource, peek?: Buffer): boolean;
  parse(src: SessionSource): AsyncIterable<NormalizedEvent>;
}

// packages/body/src/memory/siphon/distiller.ts
export interface DistillerInput {
  events: NormalizedEvent[];
  agentId: string;
  repoHash: string;
  sessionId: string;
  windowStartTs: string;
  windowEndTs: string;
  priorMemoryDigest?: string;
}

export interface DistillerOutput {
  records: MemoryRecord[];          // see §23.3
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface Distiller {
  call(input: DistillerInput): Promise<DistillerOutput>;
}

// packages/body/src/memory/recap/render.ts
export type RecapShape =
  | 'native' | 'system-message' | 'tool-system'
  | 'metadata' | 'inline-prefix' | 'none';

export interface RecapCapability {
  shape: RecapShape;
  maxTokens?: number;
  tokenizer?: 'gpt' | 'claude' | 'pi' | 'simple';
  injectionPoint: 'first-message' | 'every-message' | 'session-start';
}

export interface RecapRequest {
  agentId: string;
  intent: string;
  repoHash: string;
  contextWindowTokens: number;
  tokenizer: RecapCapability['tokenizer'];
}

export interface RecapDocument {
  format: 'markdown' | 'json';
  body: string;
  tokensEstimated: number;
  recordIds: string[];              // for audit
  sha: string;                      // canonical hash; embedded in metadata-shape injections
}

export interface MemoryConflict {
  kind: 'subject-conflict';
  existing: MemoryRecord;
  incoming: MemoryRecord;
}

export interface MemoryMergeReport {
  written: number;
  conflicts: MemoryConflict[];
  resolvedTo: 'incoming' | 'existing' | 'both';
  scoreBreakdown: Array<{ recordId: string; agentId: string; authority: number; recency: number; score: number }>;
}
```

**Adapter extension:** `Muscle.acceptRecap?(doc: RecapDocument): Promise<{ accepted: boolean; reason?: string }>` is added to the `Muscle` interface defined in SPEC-19; the body invokes it according to the muscle's `RecapCapability`.

---

## 23.16 CircuitBreaker & Disk-Full Policy

> Promoted from SPEC-25.1 and SPEC-25.2. Per-muscle health policy and ledger-rotation tier are both cross-organ because the selector (SPEC-17) and audit (SPEC-28.5) both consume their state.

```ts
// packages/body/src/muscles/circuit-breaker.ts
export interface BreakerConfig {
  failureThreshold: number;       // default 3
  failureWindowMs: number;        // default 60_000
  cooldownMs: number;             // default 120_000
  halfOpenProbeBudget: number;    // default 1
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  muscleId: string;
  state: BreakerState;
  failures: number;
  openedAt?: string;
  halfOpenInFlight: number;
}

// packages/body/src/blood/disk-full.ts
export type LedgerState = 'ok' | 'rotating' | 'degraded' | 'recovering';

export interface DiskFullPolicy {
  rotation: {
    maxBytes: number;            // bytes; default 64 MiB
    maxAgeMs: number;            // default 86_400_000
    compressAfter: number;       // rotations before gzip
    pruneAfter: number;          // days before .jsonl.gz delete
  };
  minFreeBytes: number;          // below this, attempt mitigation
  ringBuffer: number;            // entries held in degraded mode
}

export interface DiskFullError {
  code: 'LEDGER_DISK_FULL' | 'LEDGER_RO_FS' | 'LEDGER_IO';
  path: string;
  bytesAvailable: number;
  attemptedTier: 'rotate' | 'prune' | 'ring';
  recoverable: boolean;
}
```

---

## 23.17 Audit & Security

> Promoted from SPEC-28.1, 28.5. Founder + operator key model, audit replay shape, replay-defense state.

```ts
// packages/body/src/identity/keys.ts
export interface FounderKey {
  pub: string;                       // ed25519, PEM
  embeddedAt: string;                // build-time stamp
  binarySha: string;                 // sha256 of the body binary that embedded it
}

export interface OperatorKeyEntry {
  id: string;                        // e.g. '2026Q2'
  pub: string;                       // ed25519, PEM
  notBefore: string;
  notAfter: string;
}

export interface TrustBundle {
  schemaVersion: 1;
  activeKeyId: string;
  trusted: OperatorKeyEntry[];
  signature: string;                 // ed25519, signed by outgoing active key OR founder
}

// packages/body/src/nerves/anti-replay.ts
export interface AntiReplayConfig {
  windowMs: number;                  // default 600_000
  seenSet: { maxItems: number; ttlMs: number };
  ledgerCheck: boolean;
  hmac: { enabled: boolean; algorithm: 'hmac-sha256' };
}

// packages/body/src/audit/replay.ts
export interface AuditEvent {
  ts: string;
  kind: string;                      // ledger entry type or PulseKind
  actor: string;                     // agentId or 'body'
  data: unknown;
}

export interface LineageTreeNode {
  taskId: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  status?: 'ok' | 'partial' | 'failed' | 'timeout' | 'orphaned';
  children: LineageTreeNode[];
}

export interface BudgetFlowEdge {
  from: string;                      // taskId
  to: string;                        // taskId
  reserved: BudgetRequest;
  spent: BudgetRequest;
  refunded: BudgetRequest;
}

export interface BudgetFlow {
  rootGrant: BudgetRequest;
  edges: BudgetFlowEdge[];
}

export interface AuditViolation {
  type: 'pact.rejected' | 'ink.replay-blocked' | 'muscle.identity-rejected'
      | 'audit.coverage-mismatch' | 'budget.denied';
  code: string;                      // PactErrorCode | InkErrorCode | SecurityErrorCode
  rule?: string;
  frame?: string;                    // correlationId
  at: string;
}

export interface DecisionTreeNode {
  taskId: string;
  selector: AgentSelector;
  candidates: Array<{ agentId: string; score: number; rank: number }>;
  chosen: { agentId: string; reason: string };
  children: DecisionTreeNode[];
}

export interface AuditReport {
  rootTaskId: string;
  generatedAt: string;
  timeline: AuditEvent[];
  tree: LineageTreeNode;
  budgetFlow: BudgetFlow;
  violations: AuditViolation[];
  decisionTree: DecisionTreeNode;
  meta: {
    totalDurationMs: number;
    totalCost: { tokens: number; usd: number };
    agentsInvolved: string[];
    pactVersions: number[];
  };
  coverageHash: string;              // sha256 of canonicalized read window
  ledgerFiles: Array<{ path: string; sha256: string; rangeStart: number; rangeEnd: number }>;
}

export interface ReplayResult {
  ok: boolean;
  report: AuditReport;
  warnings: string[];                // e.g. 'window contained degraded ledger entries'
}

export interface VerifyResult {
  ok: boolean;
  coverageMatches: boolean;
  ledgerFilesMatch: boolean;
  details?: string;
}
```

---

## 23.18 Health, Encryption, Misc Cross-Organ

> Catch-all for types referenced by ≥ 2 specs that don't fit the buckets above.

```ts
// packages/body/src/skin/health.ts
export type HealthStatus = 'ok' | 'degraded' | 'critical';

export interface HealthReport {
  status: HealthStatus;
  ready: boolean;
  repoHash: string;
  pact: { version: number; sha: string; expiresAt?: string };
  muscles: Array<{
    id: string;
    state: 'up' | 'degraded' | 'open' | 'half-open' | 'down';
    breaker?: BreakerState;
    lastError?: string;
    fitness?: number;
  }>;
  senses: Array<{
    id: string;
    state: 'up' | 'restarting' | 'dead' | 'migrated';
    restartAttempts?: number;
  }>;
  blood: {
    state: LedgerState;
    ringDepth?: number;
    lostEntries?: number;
  };
  memory: {
    state: 'healthy' | 'rebuilding' | 'unavailable';
    rebuildingSections?: string[];
  };
  budget: {
    rootInFlight: number;
    perAgent: Record<string, { reserved: number; spent: number; cap: number }>;
  };
}

// packages/body/src/blood/encrypted-jsonl.ts
export interface LedgerEncryptionConfig {
  enabled: boolean;
  algorithm: 'aes-256-gcm';
  keyDerivation: 'argon2id' | 'kdf-from-operator-pubkey';
  segmentBytes: number;            // 64 KiB segments → seekable
}

// packages/body/src/memory/redaction.ts
export interface RedactionMatch { kind: string; count: number; }
export interface RedactionResult { body: string; redactions: RedactionMatch[]; }
```

---

## 23.19 Consolidated Error & Pulse Catalogue

> All error code unions and PulseKind extensions from SPEC-24 through SPEC-28 are gathered here so a single import covers them all.

```ts
// packages/body/src/errors/codes.ts (additions reconciled from 24–28)

// extends MuscleErrorCode (§23.10)
export type MuscleErrorCodeExt =
  | MuscleErrorCode
  | 'TASK_ORPHANED'                 // SPEC-24.1
  | 'MUSCLE_IDENTITY_REJECTED'      // SPEC-28.2
  | 'MUSCLE_IDENTITY_UNKNOWN';      // SPEC-28.2

// extends InkErrorCode (§23.10)
export type InkErrorCodeExt =
  | InkErrorCode
  | 'INK_RESERVATION_DENIED'        // SPEC-24.4
  | 'INK_FANOUT_RESERVATION_FAILED' // SPEC-24.4
  | 'INK_AGENT_SPOOFED'             // SPEC-28.2
  | 'INK_REPLAY_STALE'              // SPEC-28.3
  | 'INK_HMAC_INVALID';             // SPEC-28.3

export type LedgerErrorCode  = 'LEDGER_DISK_FULL' | 'LEDGER_RO_FS' | 'LEDGER_IO' | 'LEDGER_DEGRADED';
export type SenseErrorCode   = 'SENSE_DEAD' | 'SENSE_DIED_MID_CALL' | 'SENSE_RESTART_EXHAUSTED' | 'SENSE_MIGRATED';
export type MemoryErrorCode  = 'MEMORY_CORRUPT' | 'MEMORY_UNAVAILABLE' | 'MEMORY_REBUILDING';
export type PactKeyErrorCode = 'PACT_KEY_EXPIRED' | 'PACT_BUNDLE_INVALID' | 'PACT_NO_TRUSTED_KEY';
export type RecoveryErrorCode =
  | 'TASK_UNCERTAIN' | 'TASK_AGED_OUT'
  | 'PACT_EVICTED' | 'RESERVATION_NO_LONGER_AVAILABLE';
export type SecurityErrorCode =
  | 'BOOT_NO_PACT' | 'BOOT_INSECURE_HTTP'
  | 'AUDIT_COVERAGE_MISMATCH';
export type SiphonErrorCodeExt =
  | SiphonErrorCode
  | 'SIPHON_FORMAT_UNKNOWN'
  | 'SIPHON_DISTILLER_TIMEOUT'
  | 'SIPHON_MERGE_DEADLOCK'
  | 'SIPHON_RECAP_OVER_BUDGET';

// extends PulseKind (§23.7)
export type PulseKindExt =
  | PulseKind
  // SPEC-24
  | 'task.orphaned' | 'task.cancelling' | 'task.harvesting' | 'ink.harvested'
  | 'pact.detected' | 'pact.verifying' | 'pact.swapped' | 'pact.pin-released'
  | 'budget.reserved' | 'budget.denied' | 'budget.refunded'
  // SPEC-25
  | 'muscle.probing' | 'muscle.recovered'
  | 'ledger.full' | 'ledger.degraded' | 'ledger.recovering' | 'ledger.recovered'
  | 'pact.key.rotating' | 'pact.key.expired' | 'pact.bundle.updated' | 'pact.bundle.invalid'
  | 'memory.corrupt' | 'memory.rebuilding' | 'memory.rebuilt' | 'memory.unavailable'
  | 'sense.unhealthy' | 'sense.restarting' | 'sense.dead' | 'sense.migrated'
  // SPEC-26
  | 'replay.plan-built'
  | 'task.resumed' | 'task.uncertain' | 'task.gc'
  | 'muscle.awaiting' | 'muscle.reattach'
  | 'orphan.gc.scanning' | 'orphan.gc.harvesting' | 'orphan.gc.completed'
  | 'pact.pin-rehydrated' | 'budget.re-reserved'
  // SPEC-27
  | 'siphon.session-opened' | 'siphon.session-closed'
  | 'siphon.window-distilled' | 'siphon.distill-failed'
  | 'memory.conflict' | 'memory.merged'
  | 'recap.requested' | 'recap.rendered' | 'recap.applied' | 'recap.skipped'
  // SPEC-28
  | 'muscle.bound' | 'muscle.identity-rejected'
  | 'ink.replay-blocked' | 'ink.hmac-mismatch'
  | 'audit.replay-built' | 'audit.coverage-mismatch';
```

The union types above are the canonical superset. Implementations should import the `*Ext` variants (e.g. `import { PulseKindExt as PulseKind } from '@fangai/body/types'`).

---

## 23.20 Reconciliation Pointer

For the full list of types added in Round 4, what changed in each downstream spec, and what conflicts were resolved (e.g. `LineageHop.mac`, `TaskEnvelope.pactPin`), see [`29-RECONCILIATION.md`](./29-RECONCILIATION.md).

🐙
