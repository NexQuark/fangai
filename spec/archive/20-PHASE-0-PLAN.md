# SPEC 20 — Phase 0: Reshape Plan (Day-by-Day)

> The migration that doesn't break anything. Same 110 tests, new organ structure.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-19

---

## Day 1 — Folder Structure + Package Manifest

**Create:**
```
packages/body/
├── package.json          # @fangai/body v0.1.0
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts          # re-exports body.ts
│   ├── body.ts           # stub — Body class placeholder
│   ├── boot.ts           # stub — boot() placeholder
│   ├── types.ts          # empty, filled Day 2
│   └── __tests__/
│       └── body.smoke.test.ts  # import { Body } from '@fangai/body' — green
├── hearts/
├── skeleton/
├── muscles/
├── nerves/
├── blood/
├── memory/
├── senses/
└── skin/
```

**Package.json key fields:**
```json
{
  "name": "@fangai/body",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@fangai/core": "workspace:*" }
}
```

**Commit:** `🐺 feat(body): organ skeleton — folders + package manifest`
**Verify:** `pnpm install && pnpm --filter @fangai/body build && pnpm --filter @fangai/body test`

---

## Day 2 — Migrate Types + Keep Compatibility

**Move from `packages/core/src/` (or `src/core.ts`):**

| From | To |
|------|-----|
| `AgentAdapter` interface | `packages/body/src/muscles/_interface.ts` |
| `AgentTask` type | `packages/body/src/types.ts` |
| `AdapterEvent` union | `packages/body/src/types.ts` |
| `AgentRef`, `FangConfig` | `packages/body/src/types.ts` |
| `ProcessManager`, `PersistentProcess` | `packages/body/src/muscles/loader.ts` |

**Compatibility:** Re-export from old location:
```ts
// src/core.ts (append at bottom)
export { AgentAdapter, AgentTask, AdapterEvent, ProcessManager, PersistentProcess } from '@fangai/body';
```

**No tests change.** All existing tests import from `../../src/core.js` — add re-exports, imports resolve.

**Commit:** `🐺 refactor(body): migrate types to @fangai/body, keep re-exports`
**Verify:** `pnpm -r test` — all 110 tests green

---

## Day 3 — Nerves: INK Dispatcher (Minimal)

**Create** `packages/body/src/nerves/dispatcher.ts`:

```ts
import type { InkPayload } from '../types';

export interface DispatcherDeps {
  registry: { get(id: string): unknown };
  ledger: { append(e: unknown): Promise<void> };
}

export class InkDispatcher {
  constructor(private deps: DispatcherDeps) {}

  async dispatch(frame: InkPayload) {
    this.guard(frame);
    if (frame.selector.kind !== 'direct') throw inkErr('INK_NO_CANDIDATE', { selector: frame.selector });
    const target = this.resolveDirect(frame);
    if (!target) throw inkErr('INK_NO_CANDIDATE', { selector: frame.selector });
    await this.deps.ledger.append({ type: 'ink.dispatched', correlationId: frame.correlationId, agentId: target.id, ts: nowIso() });
    return { correlationId: frame.correlationId, routedTo: target.id };
  }

  private guard(f: InkPayload): void {
    if (f.depth >= 4) throw inkErr('INK_RECURSION_LIMIT', { depth: f.depth, max: 4, lineage: f.lineage });
    if (f.lineage.length !== f.depth) throw inkErr('INK_LINEAGE_MISMATCH', { depth: f.depth, len: f.lineage.length });
    const seen = new Set<string>();
    for (const h of f.lineage) {
      if (seen.has(h.agentId) && f.depth >= 2) throw inkErr('INK_CYCLE_DETECTED', { lineage: f.lineage });
      seen.add(h.agentId);
    }
  }

  private resolveDirect(f: InkPayload) { return this.deps.registry.get(f.selector.agentId); }
}

function inkErr(code: string, data: unknown): Error & { code: string; data: unknown } {
  const e = new Error(code) as any; e.code = code; e.data = data; return e;
}
function nowIso() { return new Date().toISOString(); }
```

**Tests** (`packages/body/src/nerves/__tests__/dispatcher.test.ts`):
- valid frame → dispatch returns routedTo
- depth=4 frame → throws `INK_RECURSION_LIMIT`
- cycle frame → throws `INK_CYCLE_DETECTED`
- lineage length ≠ depth → throws `INK_LINEAGE_MISMATCH`
- unknown agentId → `INK_NO_CANDIDATE`

**Commit:** `🐺 feat(nerves): INK dispatcher with schema + recursion guard`
**Verify:** `pnpm --filter @fangai/body test`; coverage on `dispatcher.ts` ≥ 90%

---

## Day 4 — Blood: Append-Only JSONL Ledger

**Create** `packages/body/src/blood/ledger.ts`:

```ts
import { createWriteStream, WriteStream, statSync, renameSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

export interface BloodEntry {
  id: string; ts: string; type: string;
  taskId?: string; agentId?: string; correlationId?: string;
  payload?: unknown; cost?: { tokens?: number; usd?: number; durationMs?: number };
}

export class BloodLedger {
  private out!: WriteStream;
  private bytes = 0;
  private openedAt = 0;
  constructor(private opts: { path: string; rotation?: { maxBytes?: number; maxAgeMs?: number } }) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.opts.path), { recursive: true });
    this.openedAt = Date.now();
    if (existsSync(this.opts.path)) this.bytes = statSync(this.opts.path).size;
    this.out = createWriteStream(this.opts.path, { flags: 'a' });
  }

  async append(entry: Omit<BloodEntry, 'id'|'ts'> & Partial<Pick<BloodEntry,'id'|'ts'>>): Promise<void> {
    const full: BloodEntry = { id: entry.id ?? crypto.randomUUID(), ts: entry.ts ?? new Date().toISOString(), ...entry };
    const line = JSON.stringify(full) + '\n';
    if (this.shouldRotate(Buffer.byteLength(line))) await this.rotate();
    await new Promise<void>((res, rej) => this.out.write(line, (err) => err ? rej(err) : res()));
    this.bytes += Buffer.byteLength(line);
  }

  async *tail(n: number): AsyncGenerator<BloodEntry> { /* ... */ }
  async *since(tsIso: string): AsyncGenerator<BloodEntry> { /* ... */ }
  async close(): Promise<void> { await new Promise<void>(res => this.out.end(() => res())); }

  private shouldRotate(incoming: number): boolean { /* size or age trigger */ }
  private async rotate(): Promise<void> { /* rename current, open new */ }
}
```

**Tests:** 10K append throughput, rotation triggers, corrupt-line tolerance, restart-and-tail correctness.

**Commit:** `🐺 feat(blood): append-only JSONL ledger with rotation`
**Verify:** `pnpm --filter @fangai/body bench:ledger` (10K writes < 500ms)

---

## Day 5 — Hearts: Conductor + Pulse Spine Wiring

**Create** `packages/body/src/hearts/pulse.ts` and `conductor.ts`:

```ts
// pulse.ts
export type PulseKind =
  | 'body.booting' | 'body.ready' | 'body.dying'
  | 'task.started' | 'task.finished' | 'task.failed'
  | 'ink.dispatched' | 'ink.received' | 'ink.completed'
  | 'pact.passed' | 'pact.rejected'
  | 'muscle.mounted' | 'muscle.unmounted'
  | 'memory.written' | 'budget.starved' | 'budget.exhausted';

export interface Pulse<K extends PulseKind = PulseKind> {
  id: string; ts: string; kind: K; source: string; data: unknown;
}

// conductor.ts
export class Conductor {
  private bus = new EventEmitter();
  constructor(private ledger?: BloodLedger) { this.bus.setMaxListeners(50); }

  on<K extends PulseKind>(kind: K, fn: (p: Pulse<K>) => void): () => void { /* ... */ }
  emit<K extends PulseKind>(kind: K, source: string, data: unknown): void { /* ... */ }
  async drain(): Promise<void> { /* ... */ }
}
```

**Wire:** Legacy `FangAgentExecutor` → `LegacyMuscleAdapter` that emits `task.started` / `task.finished` via Conductor.

**Commit:** `🐺 feat(hearts): conductor + pulse spine wiring`
**Verify:** Integration test: `wrap "echo hi"` → ledger contains `body.ready`, `task.started`, `task.finished` in order. `pnpm -r test` green.

---

## Phase 0 Complete

**Tag:** `phase-0/done`
**PR Title:** *Phase 0 — Organ skeleton, INK schema, blood ledger, pulse spine*
**Tests:** All 110 + ~15 new = 125 green
**Coverage:** `packages/body` ≥ 85% lines

🐙
