# SPEC 27 — SIPHON Generalized: Cold-Recap Across Agents

> SEAM 4 of 5. Cursor's 110/110 cold-recap was agent-specific. SIPHON is the same idea, normalized: one extraction pipeline, many session formats, one memory store.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12
**Depends on:** SPEC-19, SPEC-23, SPEC-25, SPEC-26

---

## 27.1 The Pipeline (One Shape, Three Stages)

```
                ┌─────────────────────────────────────────┐
                │       SessionSource (raw bytes)         │
                │  Pi JSONL │ Claude stream-json │ ...    │
                └────────────────┬────────────────────────┘
                                 │
                         match → │
                                 ▼
                ┌─────────────────────────────────────────┐
                │   SessionParser → NormalizedEvent[]     │
                └────────────────┬────────────────────────┘
                                 │
                                 ▼
                ┌─────────────────────────────────────────┐
                │   Distiller (cheap model) → MemoryRecord[]│
                └────────────────┬────────────────────────┘
                                 │
                                 ▼
                ┌─────────────────────────────────────────┐
                │   MemoryStore.merge() → MEMORY.md       │
                └─────────────────────────────────────────┘
```

Three stages, three contracts. The shared schema is `NormalizedEvent`. The shared output is `MemoryRecord[]` (already defined in SPEC-23.3). The shared invariant: **lossless front, lossy back** — parsing is faithful, distillation is opinionated, merging is conflict-aware.

---

## 27.2 Unified Extraction Interface

### Source description

```ts
// packages/body/src/memory/siphon/source.ts
export interface SessionSource {
  sessionId: string;
  agentId: string;
  repoHash: string;
  format: 'pi-jsonl' | 'cursor-transcript' | 'claude-stream-json'
        | 'opencode-events' | 'a2a-frames' | 'unknown';
  rootTaskId?: string;
  startedAt: string;
  endedAt?: string;
  stream(): AsyncIterable<Buffer>;     // raw bytes
}
```

A source describes only metadata + a stream. Sources come from three places:
- The body's session recorder (`packages/body/src/skin/session-recorder.ts`) writes raw transcripts under `.fang/sessions/<agentId>/<sessionId>.jsonl`.
- Adapters call `siphon.record(stream, meta)` while serving requests.
- Operators can replay external sessions: `fang siphon ingest --format pi-jsonl path/to/session.jsonl`.

### Normalized event schema (the lossless contract)

```ts
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
  text?: string;                   // human-readable summary
  payload?: unknown;               // kind-specific blob, untyped
  refs?: {
    files?: string[];              // relative to repo root
    commits?: string[];            // sha
    correlationId?: string;        // INK linkage
    taskId?: string;
  };
}
```

Every parser produces this stream. The downstream cares only about kind + refs + text.

### Parser interface

```ts
// packages/body/src/memory/siphon/parser.ts
export interface SessionParser {
  readonly format: SessionSource['format'];
  match(src: SessionSource, peek?: Buffer): boolean;
  parse(src: SessionSource): AsyncIterable<NormalizedEvent>;
}
```

### Built-in parsers

| Parser | File | Maps |
|--------|------|------|
| `PiJsonlParser` | `parsers/pi.ts` | Pi RPC `event.kind ∈ {message, tool_use, tool_result, file_change}` |
| `CursorTranscriptParser` | `parsers/cursor.ts` | Cursor's `{role, parts, tool_calls, edits}` |
| `ClaudeStreamJsonParser` | `parsers/claude.ts` | Anthropic `stream-json`: `content_block_*`, `tool_use`, `tool_result` |
| `OpenCodeEventParser` | `parsers/opencode.ts` | OpenCode `{type: 'reply'\|'tool_call'\|'patch'}` |
| `A2AFrameParser` | `parsers/a2a.ts` | Generic A2A `message/send` + `status-update` |

Registration:

```ts
// packages/body/src/memory/siphon/index.ts
export class Siphon {
  static parsers: SessionParser[] = [
    new PiJsonlParser(), new CursorTranscriptParser(), new ClaudeStreamJsonParser(),
    new OpenCodeEventParser(), new A2AFrameParser(),
  ];

  static dispatch(src: SessionSource): SessionParser {
    for (const p of this.parsers) if (p.format === src.format && p.match(src)) return p;
    for (const p of this.parsers) if (p.match(src)) return p;     // sniff
    throw siphonErr('SIPHON_PARSE_FAIL', { sessionId: src.sessionId, format: src.format });
  }
}
```

### How sniffing works

For unknown-format sources, each parser's `match(src, peek)` may inspect the first 1 KiB. Disambiguation lookup:

```
contains   "tool_use_id":           → Claude stream-json
contains   "jsonrpc":"2.0" + "pi.*" → Pi JSONL
contains   "event":"patch"          → OpenCode
contains   "method":"message/send"  → A2A
fallback                            → Cursor (most permissive)
```

Body's parser order is a precedence tier; conflicts (rare) are settled by source-supplied `format` field if present.

---

## 27.3 The Distiller — Cheap Model Across Formats

### Why a cheap model

Local Ollama (Qwen 2.5 0.5B / Phi-3.5-mini / `llama3.2:1b`) is sufficient. The distiller is heavily prompt-engineered to extract structured output from a window of normalized events. It never sees raw transcripts after normalization, so the prompt is the same across formats.

### Distiller contract

```ts
// packages/body/src/memory/siphon/distiller.ts
export interface DistillerInput {
  events: NormalizedEvent[];
  agentId: string;
  repoHash: string;
  sessionId: string;
  windowStartTs: string;
  windowEndTs: string;
  priorMemoryDigest?: string;       // truncated existing memory; helps avoid dups
}

export interface DistillerOutput {
  records: MemoryRecord[];
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface Distiller {
  call(input: DistillerInput): Promise<DistillerOutput>;
}
```

### Prompt skeleton

```
SYSTEM:
You distill software-engineering session events into structured memory records.
Output ONLY JSON matching the schema. ≤ 12 records. Each ≤ 400 tokens.

Kinds:
- decision     : an explicit choice that affects future work
- observation  : a fact discovered (test failed, file structure, etc.)
- preference   : user/agent stated preference (naming, style, etc.)
- failure      : something tried and rejected, with reason
- fact         : project metadata (versions, paths, ids)

Skip:
- routine chat, thinking aloud, partial work, debug fluff

Refs: prefer file paths and commit shas when known.

INPUT:
{ "agentId": "...", "events": [ NormalizedEvent ... ], "priorMemoryDigest": "..." }

OUTPUT (strict JSON):
{ "records": [ { "kind","subject","body","refs","tags","supersedes" } ] }
```

### Windowing strategy

Long sessions are chunked:

```ts
const W = 50;           // events per window
const Z = 8;            // overlap
for (let i = 0; i < events.length; i += (W - Z)) {
  const slice = events.slice(i, i + W);
  await distill(slice, ...);
}
```

The overlap exists because decisions are often distributed across the boundary between two events. Distiller MUST set `supersedes` when a later window refines an earlier record's subject; the memory store enforces idempotent merge.

### Budget for SIPHON itself

SIPHON is a normal INK task running on a `claw`-tier or local muscle. It carries its own budget reservation (default 5000 tokens/session). PACT can cap: `budgets.perAgent.siphon.tokensPerHour`.

---

## 27.4 Memory Merge Under Multi-Agent Writes

### The conflict shape

- Pi (session t=03:15): writes a decision "abandoned passport.js"
- Cursor (session t=03:42): writes a decision "renamed FangAdapter to FangMuscle"
- Pi (session t=04:01): writes a decision "use FangAdapter, not FangMuscle"  ← contradicts Cursor

Both records pass schema. Both are valid distillations. They contradict.

### Subject-based conflict detection

`MemoryRecord.subject` is normalized: lowercase, trimmed, stop-words stripped. Records whose normalized subjects share ≥ 80% trigram overlap are **candidates for conflict** when their `kind ∈ {decision, preference}`.

```ts
// packages/body/src/memory/siphon/conflicts.ts
export function detectConflicts(incoming: MemoryRecord, existing: MemoryRecord[]): Conflict[] {
  return existing
    .filter(r => sameSubject(r.subject, incoming.subject))
    .filter(r => (r.kind === incoming.kind) && contradicts(r.body, incoming.body))
    .map(r => ({ kind: 'subject-conflict', existing: r, incoming }));
}
```

`contradicts(a, b)` uses a small NLI prompt with the cheap model (or, in offline mode, a heuristic regex match of negation patterns). Cheap-model is preferred.

### Resolution policy

```yaml
# in BodyConfig.memory
merge:
  policy: 'authority-x-recency'    # default
  authorityFloor: 0.05              # ignore < this weight
  recencyHalfLifeHours: 168         # 7d
  presentBothAfter: 'conflict-store'
```

Score for record `r`:

```
score(r) = authority(r.agentId) * exp(-Δt / recencyHalfLife)

authority:
  venom = 1.0
  agent that owns the file (per CODEOWNERS-equiv) = 0.9
  agent that last touched the file = 0.7
  other agents in body = 0.5
  agents external (ingested transcripts) = 0.3

  multiplied by Fitness.score (0..1)
```

The higher score **wins** in MEMORY.md (rendered as the live record). The loser is **preserved** under the conflict log:

```
<!-- conflict:fdb8 from=cursor:r123 vs to=pi:r456 resolved-to=pi:r456 score-cursor=0.61 score-pi=0.78 ts=2026-05-12T04:02:00Z -->
```

A subsequent query may surface both (`memory.query({ includeConflicts: true })`).

### Cross-agent visibility

```ts
// MemoryStore query API
memory.query({
  repoHash,
  agentId?: string,              // omit = all agents
  agentVisibility?: 'self' | 'all' | 'allowed',
  kind?: MemoryKind | MemoryKind[],
  since?: string,
  limit?: number,
  relevance?: { text?: string; embedding?: number[] }
}): Promise<MemoryRecord[]>
```

`agentVisibility`:
- `self` — only records this agent wrote (rare; debugging)
- `all` — every record under `repoHash`
- `allowed` (default) — records by agents in `pact.rules.memory.crossVisibility.allow[]`

PACT controls cross-agent visibility:

```yaml
memory:
  crossVisibility:
    allow:
      pi:        ['cursor', 'opencode', 'venom']
      cursor:    ['pi', 'opencode', 'venom']
      opencode:  ['cursor', 'venom']             # opencode does NOT see pi's memory by default
    crossAgentDecisionWeight: 0.7                # how much an out-of-agent decision biases
```

When Cursor's next session starts: ContextPump asks `memory.query({ repoHash, agentVisibility: 'allowed' })`, which (per PACT) returns Pi's and OpenCode's records too. The recap renderer tags them: `[pi · decision] …`.

### Pulse sequence — distillation + merge

```
t=0     siphon.session-closed    { sessionId, agentId, events: 412 }
t=200ms siphon.window-distilled  { sessionId, window: 0, records: 4 }
t=350ms siphon.window-distilled  { sessionId, window: 1, records: 3 }
...
t=2s    memory.write             { agentId: pi, records: 11, conflicts: 1 }
t=2s    memory.conflict          { fromAgent: cursor, toAgent: pi, subject: 'fang-adapter naming', resolved: pi }
```

---

## 27.5 Recap Injection for Non-Cursor Agents

### Adapter `recapShape`

```ts
// extension of MuscleConfig
export type RecapShape = 'native' | 'system-message' | 'tool-system' | 'metadata' | 'inline-prefix' | 'none';

export interface RecapCapability {
  shape: RecapShape;
  maxTokens?: number;            // adapter-specific upper bound
  tokenizer?: 'gpt' | 'claude' | 'pi' | 'simple';
  injectionPoint: 'first-message' | 'every-message' | 'session-start';
}
```

| Agent | `shape` | injection point |
|-------|---------|-----------------|
| Cursor | `native` | adapter calls Cursor's existing cold-recap mechanism |
| Pi | `system-message` | first Pi RPC `message/send` part with `role: system` |
| Claude | `system-message` | first request's `system` field |
| OpenCode | `inline-prefix` | prepend to first user prompt with `<!-- recap -->` block |
| Anonymous A2A | `metadata` | task `metadata.recap` field |
| Generic | `inline-prefix` | universal fallback |

### Token budget for recap

```yaml
# BodyConfig.memory.recap
recap:
  budgetFraction: 0.10           # 10% of the agent's context window
  hardCapTokens: 8192            # never exceed this
  reserve:
    decisions: 0.5               # half the budget to decisions
    observations: 0.2
    preferences: 0.1
    failures: 0.15
    facts: 0.05
  pinSubjects: []                # always include these subjects, even if over budget
```

Body computes `target = min(window * budgetFraction, hardCapTokens)`. Within that, records are ranked by:

```
relevance(r) = score(r)                              // authority × recency
             + 0.4 * subjectMatchToCurrentTask(r)    // text overlap with intent
             + 0.2 * kindWeight(r.kind)              // kind-specific bonus
```

Top-N until total tokens ≥ target. Per-kind reserves enforce a floor (e.g., at least 5% of budget to facts).

### The renderer

```ts
// packages/body/src/memory/recap/render.ts
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
  recordIds: string[];           // for audit
}

export class RecapRenderer {
  async render(req: RecapRequest): Promise<RecapDocument>;
}
```

Markdown body shape (the one rendered to system messages):

```markdown
<!-- fang:recap v1 sha:abc... -->
# Repo state (cold recap)
**Repo:** kariemSeiam/fangai · **As of:** 2026-05-12T04:55Z · **From:** 11 records across 3 agents

## Decisions
- [pi · 2026-05-12T03:15] Abandoned passport.js — JWT vulnerable; using new authn module.
- [cursor · 2026-05-12T03:42] Renamed FangAdapter → FangMuscle across packages/.
- [pi · 2026-05-12T04:01] Use FangAdapter naming (decision after team review). ← supersedes cursor's renaming for new code

## Observations
- [opencode · 2026-05-12T03:50] tests in packages/core/src/auth/*.test.ts all pass on main.

## Failures
- [cursor · 2026-05-11T22:00] Tried regex /bearer ([^\s]+)/i — fails on multi-line headers; use parser.

## Facts
- Node 22 required; pnpm 9.x; vitest 1.5.
<!-- /fang:recap -->
```

### Adapter contract

```ts
// extension of Muscle interface
interface Muscle {
  // ... existing
  acceptRecap?(doc: RecapDocument): Promise<{ accepted: boolean; reason?: string }>;
}
```

Adapter responsibilities:
1. Tokenize per its model's tokenizer.
2. If `tokensEstimated > maxTokens`, request `recap.shrink(target)` — render returns a smaller doc.
3. Inject according to `RecapCapability.shape`.
4. Ledger entry `memory.recap-applied { agentId, sessionId, recordIds, tokens }`.

### Adapter-specific examples

**Pi (system-message):**
```jsonc
{ "method": "message/send", "params": {
    "message": { "role": "user",
      "parts": [
        { "type": "text", "role": "system", "text": "<!-- fang:recap … -->" },
        { "type": "text", "role": "user", "text": "<actual prompt>" }
      ] } } }
```

**Claude (stream-json):**
```jsonc
{ "system": "<!-- fang:recap v1 … -->", "messages": [ ... ] }
```

**OpenCode (inline-prefix):**
```text
<!-- fang:recap v1 -->
# Repo state ...
<!-- /fang:recap -->

<actual user prompt>
```

**A2A metadata:**
```jsonc
{ "method": "message/send", "params": {
    "message": { ..., "metadata": { "fang.recap": { "sha": "...", "tokens": 1248 } }
}}}
```

The agent's adapter must read `metadata['fang.recap']` and re-fetch the document via `ledger.get(recapSha)` if needed.

### Per-session vs per-message

`injectionPoint: 'every-message'` is supported but discouraged (token amplification). Most adapters use `'first-message'` per session, with `'session-start'` for long-lived agents (Cursor) that have a setup phase.

### Pulse sequence — recap injection

```
t=0     recap.requested    { agentId: pi, sessionId, intent }
t=10ms  recap.rendered     { tokens: 1248, recordIds: [...] }
t=12ms  recap.applied      { agentId: pi, sessionId, sha, tokens: 1248 }
t=15ms  task.started       { agentId: pi, sessionId, ... }
```

---

## 27.6 Tests — Cross-Format Parity

`packages/body/src/__tests__/siphon/`:

| File | Source format | Asserts |
|------|---------------|---------|
| `parser-pi.test.ts` | Pi JSONL fixture | 20 NormalizedEvents, refs.files populated |
| `parser-cursor.test.ts` | Cursor transcript fixture | edits → `file-edit`, tool calls → `tool-call` |
| `parser-claude.test.ts` | Claude stream-json | `tool_use` blocks → `tool-call`; `content_block_delta` → `agent-reply` |
| `parser-opencode.test.ts` | OpenCode events | patches → `file-edit`; commits → `commit` |
| `parser-a2a.test.ts` | A2A frames | `message/send` → `user-prompt`/`agent-reply` based on role |
| `distiller-snapshot.test.ts` | All 5 parsers' outputs fed to local distiller | golden `*.memory.snap` per format |
| `merge-conflict.test.ts` | inject two contradictory decisions | resolution per authority×recency; conflict logged |
| `recap-budget.test.ts` | 200 records, 4096-token cap | budget respected, per-kind floors enforced |

Cross-format equivalence: the same logical session expressed in two formats (Pi-style and Cursor-style) should yield distilled memory records with ≥ 0.85 cosine similarity in their subject embeddings. Test name: `cross-format-equivalence.test.ts`.

---

## 27.7 SIPHON Error Codes & Pulses (Additions)

```ts
// extends SiphonErrorCode
| 'SIPHON_FORMAT_UNKNOWN'
| 'SIPHON_DISTILLER_TIMEOUT'
| 'SIPHON_MERGE_DEADLOCK'
| 'SIPHON_RECAP_OVER_BUDGET';

// PulseKind additions
| 'siphon.session-opened' | 'siphon.session-closed'
| 'siphon.window-distilled' | 'siphon.distill-failed'
| 'memory.conflict' | 'memory.merged'
| 'recap.requested' | 'recap.rendered' | 'recap.applied' | 'recap.skipped';
```

🐙
