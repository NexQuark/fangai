# SPEC 17 — INK: The Dispatch Language

> The verb of the organism. One method namespace (`ink/*`), two transports (host-tool in Phase 1, `/ink` HTTP in Phase 2), identical frame shape.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03 (Architecture Target), SPEC-23 (Data Structures)

---

## 17.1 InkPayload — Full Schema

```ts
interface InkPayload {
  inkVersion: '1';                     // bumped on breaking change
  correlationId: string;               // uuidv7 (sortable, traceable)
  rootTaskId: string;                  // always the originating ask
  parentTaskId: string | null;         // null only when depth = 0
  lineage: LineageHop[];               // ordered, parent → child
  depth: number;                       // 0-based; cap from PACT
  repoHash: string;                    // sha256 of repo root identity blob
  pactRef: { version: number; sha: string };  // parent's view of PACT

  selector: AgentSelector;
  intent: string;                      // verb-object, ≤ 60 chars
  prompt: string;                      // the actual ask, full text
  inputs: ArtifactRef[];
  budget: BudgetRequest;
  deadline: string;                    // ISO8601; hard wall
  replyTopic: ReplyChannel;

  tracing: { traceId: string; spanId: string; baggage?: Record<string,string> };
  meta: { labels?: Record<string,string>; priority?: 0|1|2|3; dryRun?: boolean };
}

interface LineageHop {
  taskId: string;
  agentId: string;
  ts: string;
}

interface ArtifactRef {
  id: string;
  mimeType: string;
  uri?: string;
  inline?: string;                     // ≤ 64 KiB; else use uri
  sha256?: string;
}

type ReplyChannel =
  | { kind: 'host-tool'; channelId: string }     // Phase 1
  | { kind: 'http-sse'; url: string; auth?: string }  // Phase 2
  | { kind: 'ledger-only' };                     // fire-and-forget
```

### Validation Rules

| Field | Rule | Error Code |
|-------|------|------------|
| `inkVersion` | exactly `'1'` | `INK_VERSION` |
| `correlationId` | uuidv7, parses, unique within ledger window | `INK_DUP_CORRELATION` |
| `lineage.length` | === `depth` | `INK_LINEAGE_MISMATCH` |
| `lineage[last].agentId` | === parent's agentId | `INK_LINEAGE_FORGED` |
| `repoHash` | matches body's bound repoHash | `INK_WRONG_BODY` |
| `pactRef.sha` | matches current PACT or ancestor in chain | `INK_STALE_PACT` |
| `prompt` | ≤ 64 KiB | `INK_PROMPT_TOO_LARGE` |
| `inputs.*.inline` | ≤ 64 KiB each, ≤ 16 entries | `INK_INPUTS_OVERSIZE` |
| `deadline` | > now + 1s, ≤ now + 24h | `INK_DEADLINE_INVALID` |
| `budget.tokens` | ≤ parent.remainingBudget.tokens | `INK_BUDGET_OVERDRAW` |

Validation occurs pre-flight in SoulPump. Rejected frames never reach TaskPump.

---

## 17.2 AgentSelector — Resolution Algorithm

```ts
type AgentSelector =
  | { kind: 'direct'; agentId: string }
  | { kind: 'skill'; skill: string; constraints?: SelectorConstraints; fallback?: AgentSelector[] }
  | { kind: 'any';   tier?: 0|1|2|3;  constraints?: SelectorConstraints; fallback?: AgentSelector[] };

interface SelectorConstraints {
  costTier?: 'low'|'mid'|'high';
  model?: string;
  minFitness?: number;                 // 0..1, default 0
  excludeAgents?: string[];
  requireRepoHash?: string;
  maxLoadConcurrency?: number;
}
```

**Resolution algorithm** (`nerves/dispatcher.ts#resolveSelector`):

```
1. registry.candidates(selector)
     direct → [{id}]
     skill  → all muscles whose AgentCard.skills includes skill
     any    → all muscles matching tier filter
2. filter:
     - online && repoHashAuthorized(muscle, frame.repoHash)
     - fitness(muscle) >= constraints.minFitness
     - not in constraints.excludeAgents
     - currentLoad(muscle) < constraints.maxLoadConcurrency
     - PACT.agents.allow includes muscle.id
3. sort DESC: (fitness * 0.6) + (1 - load) * 0.3 + (recencyBonus) * 0.1
4. tie-break: lower currentLoad, then lexicographic agentId
5. pick top-1. if empty → recurse into selector.fallback[0], etc.
6. exhausted → throw INK_NO_CANDIDATE
```

Fitness ties rounded to 0.01 before sort for deterministic tie-breaking.

---

## 17.3 Budget Propagation

```ts
interface BudgetRequest {
  tokens?: number;
  durationMs?: number;
  costUsd?: number;
  recursiveSlots?: number;               // grandchildren allowed
}

interface BudgetAllocation {
  granted: BudgetRequest;
  splitPolicy: 'fair' | 'priority' | 'manual';
  parentRemaining: BudgetRequest;
  refundOnCompletion: boolean;           // default true
}
```

**Algorithm** (`nerves/budget.ts#allocate`):

```
remaining = parentTask.budget - parentTask.spent
requested = child.budget

switch (splitPolicy) {
  case 'manual':   granted = min(requested, remaining)
  case 'fair':     siblings_n = parentTask.activeChildren + 1
                   granted = min(requested, remaining / siblings_n)
  case 'priority': weight = child.meta.priority || 1
                   granted = min(requested, remaining * weight / sum_of_sibling_weights)
}

if granted.tokens < requested.tokens * 0.5:
    emit pulse 'budget.starved' { child, requested, granted }

reserve = remaining - granted (held against parentTask)
on child completion: refund (granted - actuallySpent) to parent
```

**Mid-flight extension:** `ink/extend` from child to dispatcher. Dispatcher checks parent remaining. Success returns new `BudgetAllocation` delta, failure returns `INK_BUDGET_EXHAUSTED`.

---

## 17.4 Recursion Guard

```ts
function guard(frame: InkPayload, pact: Pact): void {
  // depth cap
  if (frame.depth >= pact.rules.recursion.maxDepth) {
    throw { code: 'INK_RECURSION_LIMIT', data: { depth: frame.depth, max: pact.rules.recursion.maxDepth, lineage: frame.lineage }};
  }
  // cycle detection
  const seen = new Set<string>();
  for (const hop of frame.lineage) {
    if (seen.has(hop.agentId) && frame.depth >= 2) {
      throw { code: 'INK_CYCLE_DETECTED', data: { lineage: frame.lineage }};
    }
    seen.add(hop.agentId);
  }
  // fan-out at this layer
  const siblings = registry.activeChildrenOf(frame.parentTaskId);
  if (siblings.length >= pact.rules.recursion.maxFanOut) {
    throw { code: 'INK_FANOUT_LIMIT', data: { siblings: siblings.length }};
  }
}
```

- `maxDepth` default: `4`
- `maxFanOut` default: `6`

---

## 17.5 Reply Formats

```ts
type InkResult =
  | { status: 'ok';      artifacts: Artifact[]; spentBudget: BudgetRequest; fitnessSignal: FitnessSignal }
  | { status: 'partial'; artifacts: Artifact[]; warnings: string[]; spentBudget: BudgetRequest; fitnessSignal: FitnessSignal }
  | { status: 'failed';  error: ErrorEnvelope;  spentBudget: BudgetRequest; fitnessSignal: FitnessSignal }
  | { status: 'timeout'; partialArtifacts: Artifact[]; spentBudget: BudgetRequest; fitnessSignal: FitnessSignal };

interface FitnessSignal {
  quality: number;        // -1..1 self-reported; ledger may override
  latencyMs: number;
  selfReportedTokens?: number;
  declinedSubdispatches?: number;
}
```

Reply method: `ink/result`. Always references `correlationId`. Always carries `spentBudget` (refund accounting). 

`partial` is the **finished but caveat** lane — parent may accept as-is or retry the failed subset.

---

## 17.6 Progress Events

`ink/progress` notifications (no response expected):

```ts
interface InkProgress {
  correlationId: string;
  ts: string;
  percent?: number;                     // 0..100, optional
  message: string;                      // ≤ 240 chars
  artifactDelta?: Artifact;             // streaming partial output
  budgetSpentDelta?: BudgetRequest;
}
```

**Transport mapping:**

| Transport | Mechanism |
|-----------|-----------|
| `host-tool` | Carried as host_tool_call → response chunks on the same channelId |
| `http-sse` | `event: ink.progress\ndata: <json>\n\n` on `replyTopic.url` |
| `ledger-only` | Written to BloodLedger; parent polls if interested |

**Throttle:** Dispatcher coalesces progress events to ≥ 250ms intervals. `artifactDelta` events bypass the throttle. Parent's executor re-emits on its own SDK `ExecutionEventBus`.

---

## 17.7 `ink/decline` — Agent Rejects, Optionally Counter-Offers

```ts
interface InkDecline {
  correlationId: string;
  reason: 'capability-mismatch' | 'budget-too-low' | 'pact-conflict'
        | 'overloaded' | 'repo-not-authorized' | 'self-confidence-low';
  detail?: string;
  counterOffer?: {
    selector: AgentSelector;            // who you should ask
    intent: string;                     // what they CAN do
    budgetEstimate: BudgetRequest;
    notes?: string;
  };
}
```

**Dispatcher behavior on `ink/decline`:**

```
1. log to ledger as 'ink.declined'
2. apply fitness penalty: -0.01 if reason ∈ {overloaded,self-confidence-low}, 0 otherwise
3. if counterOffer present:
     emit pulse 'ink.counter-offered' { from, original, counterOffer }
     surface to parent via SDK status-update with state='input-required'
     parent may: (a) accept → fresh ink/dispatch using counterOffer
                 (b) escalate → ink/dispatch to VENOM with original lineage
4. if no counterOffer:
     run selector.fallback[] chain
```

---

## 17.8 Metadata, Tracing, Lineage Tree

- `correlationId` is per **dispatch attempt** (retry gets a new one)
- `rootTaskId` is the single anchor for the whole lineage tree
- `lineage[]` is **append-only** — each hop adds itself before dispatching the child
- `tracing.traceId` is W3C trace-context compatible
- BloodLedger indexes by `(rootTaskId, correlationId)` for fast lineage replay: `ledger.lineage(rootTaskId)` returns the tree

---

## 17.9 Concrete Example — Pi → Cursor → OpenCode

**Frame 1.** VENOM → Pi (A2A `message/send`):

```json
{"jsonrpc":"2.0","id":"v1","method":"message/send",
 "params":{"message":{"role":"user","parts":[{"text":"Audit auth-middleware. If smell, fix and add tests."}],
 "metadata":{"rootTaskId":"T-001","traceId":"00-abc..."}}}}
```

**Frame 2.** Pi calls `fang.ink` host-tool (depth=1):

```json
{"jsonrpc":"2.0","id":"i1","method":"ink/dispatch","params":{
  "inkVersion":"1",
  "correlationId":"01HKQR0PI2-CURSOR",
  "rootTaskId":"T-001","parentTaskId":"T-002",
  "lineage":[{"taskId":"T-001","agentId":"venom","ts":"2026-05-12T04:20:00Z"},
             {"taskId":"T-002","agentId":"pi","ts":"2026-05-12T04:20:03Z"}],
  "depth":1,
  "repoHash":"sha256:9af...","pactRef":{"version":3,"sha":"sha256:c4e..."},
  "selector":{"kind":"skill","skill":"code.refactor",
              "constraints":{"costTier":"mid","minFitness":0.6},
              "fallback":[{"kind":"skill","skill":"code.review"}]},
  "intent":"refactor:auth-middleware",
  "prompt":"Inspect packages/core/src/auth/*.ts. If JWT verification has issues, refactor and produce tests.",
  "inputs":[{"id":"a1","mimeType":"text/plain","uri":"file://packages/core/src/auth/"}],
  "budget":{"tokens":40000,"durationMs":600000,"recursiveSlots":2},
  "deadline":"2026-05-12T04:30:00Z",
  "replyTopic":{"kind":"host-tool","channelId":"pi-ch-7"},
  "tracing":{"traceId":"00-abc...","spanId":"01-pi"},
  "meta":{"priority":2}
}}
```

SoulPump validates: PACT version OK, repoHash OK, depth=1 < 4, agent `cursor` in allowlist, budget within parent's. **Pass.**

**Frame 3.** Body → Cursor muscle (A2A `message/send`):

```json
{"jsonrpc":"2.0","id":"c1","method":"message/send","params":{
  "message":{"role":"user","parts":[{"text":"Inspect packages/core/src/auth/*.ts..."}],
  "metadata":{"ink":"01HKQR0PI2-CURSOR","rootTaskId":"T-001","parentTaskId":"T-002","depth":1,
              "budget":{"tokens":40000,"durationMs":600000,"recursiveSlots":2}}}}
}
```

**Frame 4.** Cursor → OpenCode (depth=2):

```json
{"jsonrpc":"2.0","id":"i2","method":"ink/dispatch","params":{
  "correlationId":"01HKQR0PI2-OPENCODE",
  "rootTaskId":"T-001","parentTaskId":"T-003",
  "lineage":[{"taskId":"T-001","agentId":"venom"},{"taskId":"T-002","agentId":"pi"},
             {"taskId":"T-003","agentId":"cursor"}],
  "depth":2,
  "selector":{"kind":"direct","agentId":"opencode"},
  "intent":"tests:auth-middleware",
  "prompt":"Given this diff, write vitest cases covering negative paths. Diff inline.",
  "budget":{"tokens":15000,"durationMs":180000,"recursiveSlots":0}
}}
```

**Frame 5.** OpenCode `ink/result`:

```json
{"jsonrpc":"2.0","id":"i2","result":{
  "correlationId":"01HKQR0PI2-OPENCODE",
  "status":"ok",
  "artifacts":[{"id":"t1","mimeType":"text/x-typescript","uri":"file://...jwt.test.ts"}],
  "spentBudget":{"tokens":11240,"durationMs":94000},
  "fitnessSignal":{"quality":0.9,"latencyMs":94000}
}}
```

**Frame 6.** Cursor `ink/result` to Pi (composing OpenCode's artifact + own diff):

```json
{"jsonrpc":"2.0","id":"i1","result":{
  "correlationId":"01HKQR0PI2-CURSOR",
  "status":"ok",
  "artifacts":[{"id":"d1","mimeType":"text/x-diff","inline":"diff --git..."},
               {"id":"t1","mimeType":"text/x-typescript","uri":"file://...jwt.test.ts"}],
  "spentBudget":{"tokens":28600,"durationMs":312000},
  "fitnessSignal":{"quality":0.95,"latencyMs":312000}
}}
```

**Frame 7.** Pi's A2A response (final to VENOM): SDK `status-update completed` + artifacts.

---

## 17.10 INK Method Summary

| Method | Direction | Purpose |
|--------|-----------|---------|
| `ink/dispatch` | parent → body | Submit a task to the mesh |
| `ink/progress` | child → parent | Streaming progress updates |
| `ink/result` | child → parent | Final result (ok/partial/failed/timeout) |
| `ink/decline` | child → parent | Reject with optional counter-offer |
| `ink/extend` | child → body | Request budget extension |

---

## 17.11 Transport Evolution

| Phase | Transport | Status |
|-------|-----------|--------|
| 1 | Pi host_tool_call (existing `setHostTools` plumbing) | Ships week 2-3 |
| 2 | HTTP POST `/ink` on every muscle port (dedicated protocol) | When cross-body mesh needed |
| 3 | Go binary `bin/fang-core` speaking same JSONL stdio to TS muscles | When CPU-bound parallel work appears |

**INK frame shape never changes across phases.** Only the transport wrapper changes. This is the contract that survives porting from TS → Go.

🐙
