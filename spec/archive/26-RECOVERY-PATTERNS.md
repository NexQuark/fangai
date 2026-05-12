# SPEC 26 — Recovery Patterns: The Body Heals

> SEAM 3 of 5. Death is a state, not an end. Three recovery primitives that turn the ledger from an audit log into a resurrection protocol.

**Status:** Draft (Reconciled — Round 4) · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12
**Depends on:** SPEC-19, SPEC-23, SPEC-24, SPEC-25 (canonical types: §23.14 `TaskCheckpoint`/`OrphanRecord`/`OrphanCause`/`HarvestManifest`/`ReplayPlan`/`GcReport`, §23.19 error codes)

---

## 26.1 Checkpoint Replay

### Why checkpoints exist

The BloodLedger is the canonical record of *what happened*. Checkpoints are the canonical record of *what was about to happen*. The ledger is past-tense; checkpoints are pending-tense.

A task tree can die anywhere. On reboot, the ledger contains every completed step; checkpoints contain the resumption coordinates for every step in flight.

### Minimal checkpoint shape

`TaskCheckpoint`, `TaskCheckpointState`, and `ChildCompletion` are defined canonically in **SPEC-23.14**. Stored as `BloodEntryType: 'task.checkpoint'` so checkpoints share storage, rotation, and audit with everything else. The latest checkpoint per `taskId` wins on replay (`max(ts)`).

### When TaskPump writes checkpoints

```ts
// inside TaskPump
async function execute(env: TaskEnvelope) {
  checkpoint(env, 'queued');
  await soul.evaluate(env.frame, soul.pactFor(env.pactPin), ctx);
  reservation = budget.tryReserve(...);
  checkpoint(env, 'dispatched');

  const muscle = registry.get(env.frame.selector);
  const result = await muscle.execute(env.frame, {
    onChildSpawned: (childEnv) => checkpoint(env, 'awaiting-child', { addPending: childEnv.taskId }),
    onChildSealed:  (compl) => checkpoint(env, 'awaiting-child', { addCompletion: compl }),
    onProgress:     throttled(() => checkpoint(env, 'running'), 5000),
  });

  // 2-phase: write 'completing' WITH result hash before publishing final
  checkpoint(env, 'completing', { resultHash: sha256(result) });
  await ledger.append({ type: 'task.end', taskId: env.frame.parentTaskId, payload: result, ... });
  budget.release(reservation.id, result.spentBudget);
}
```

Triggers (lossy summary):

| Trigger | State written | Notes |
|---------|---------------|-------|
| Frame accepted by SoulPump | `queued` | the act of "I'm taking responsibility" |
| Sent to muscle | `dispatched` | covers crash *after* dispatch / *before* completion |
| Progress event from muscle | `running` (throttled 5s) | best-effort liveness |
| Child dispatched | `awaiting-child` | adds correlationId |
| Child completed | `awaiting-child` (delta) | adds to childCompletions |
| About to write final result | `completing` (incl. resultHash) | crucial for "died after compute, before write" |

The "running" throttle is bounded — under 5s of activity goes unflushed; acceptable because the muscle adapter will report `ink.progress` separately to the ledger.

### Replay algorithm — boot-time reconstruction

`ReplayPlan` is defined canonically in **SPEC-23.14**.

```ts
// packages/body/src/blood/replay.ts
import type { ReplayPlan } from '@fangai/body/types';

export async function planReplay(ledger: BloodLedger, now = new Date()): Promise<ReplayPlan> {
  // 1. Stream ledger; build per-rootTaskId state.
  const trees = new Map<string, RootTreeState>();
  for await (const e of ledger.scanSince(boundAfterBoot(ledger))) accumulate(trees, e);

  const plan: ReplayPlan = { resume: [], harvest: [], orphan: [], verifyResult: [] };

  for (const [rootId, tree] of trees) {
    for (const [taskId, node] of tree.tasks) {
      const cp = node.latestCheckpoint;
      const endEntry = node.lastEnd;
      if (endEntry) continue;                            // finished cleanly
      if (!cp) { plan.orphan.push({ taskId, reason: 'no-checkpoint' }); continue; }

      // dead-after-write vs dead-before-write disambiguation
      if (cp.state === 'completing') {
        plan.verifyResult.push({ taskId, expectedHash: cp.resultHash! });
        continue;
      }

      const age = now.getTime() - Date.parse(cp.ts);
      const deadline = Date.parse(cp.deadline);
      if (now.getTime() > deadline)         plan.orphan.push({ taskId, reason: 'deadline-passed' });
      else if (cp.resumePolicy === 'auto')  plan.resume.push({ taskId, cp });
      else                                  plan.harvest.push({ taskId, cp });
    }
  }
  return plan;
}
```

### Resume sequence

For each `plan.resume[i]`:

1. **Verify PACT pin** — load `pactPin` from `pactStore`; if missing/invalid, demote to orphan with reason `pact-evicted`.
2. **Re-reserve budgets** — re-create reservations from `reservationIds` against the same `agentId`. If now over cap, demote to orphan with reason `budget-no-longer-available`.
3. **Re-establish muscle** — if muscle is `up` and admits the agent's `requireRepoHash`, reattach. Else queue and wait up to `resume.muscleWaitMs` (default 30s).
4. **Re-issue inflight child dispatches** — for any child correlationId not in `childCompletions`, reissue with the **same correlationId**. The dispatcher's `seenSet` (SPEC-24.5/28.3) dedupes if the muscle survived; otherwise, this is a fresh dispatch under the original id.
5. **Emit `task.resumed`** pulse, ledger entry.

### Dead mid-flight vs completed-but-unwritten

The two-phase commit makes this unambiguous:

| ledger state | meaning |
|-------------|---------|
| `task.checkpoint(state=running)` only | died mid-flight; resume |
| `task.checkpoint(state=completing, resultHash=H)` only | computed but final write failed |
| `task.checkpoint(state=completing) + task.end` | completed; no action |

For `completing` without `task.end`: the body issues a **result probe** to the muscle. `ink/probe-result { correlationId, expectedHash }`. If the muscle has the result cached and hashes match → re-write `task.end` from the muscle's cache. If not, the task is marked `task.uncertain` and surfaced for operator decision (replay vs accept loss).

### Pulse sequence — resume

```
t=0    body.booting           { phase: 'replay' }
t=0    replay.plan-built      { resume: 3, harvest: 1, orphan: 0, verifyResult: 1 }
t=0    pact.pin-rehydrated    { taskId: T-002, pactVersion: 3 }
t=0    budget.re-reserved     { taskId: T-002, tokens: 25000 }
t=0    muscle.reattach        { muscleId: cursor, taskId: T-002 }
t=1s   task.resumed           { taskId: T-002, resumedFrom: 'dispatched' }
t=1s   task.uncertain         { taskId: T-007, reason: 'completing-without-end' }
t=2s   body.ready             { repoHash, pactVersion, replayedTasks: 3 }
```

### Idempotency contract for muscles

Muscles MUST treat repeated `ink/dispatch` with the same `correlationId` within their local cache TTL (default 30 minutes) as a **probe**, not a re-execution. Required adapter behavior:

```ts
interface Muscle {
  execute(frame: Frame, ctx: ExecCtx): Promise<InkResult>;
  probeResult?(correlationId: string): Promise<InkResult | null>;
}
```

If a muscle does not implement `probeResult`, the replay falls back to **re-execution**, which is correct for read-only intents but unsafe for writes. Per-skill annotation (`skill.idempotent: true|false`) determines whether re-execution is allowed without prompt. PACT may forbid resume for non-idempotent skills (`pact.rules.recovery.resumeNonIdempotent: false`).

### Configuration

```yaml
# BodyConfig.recovery
resume:
  policy: auto                 # auto | prompt | orphan
  maxAgeMs: 86_400_000         # 24h; older tasks are auto-orphaned
  muscleWaitMs: 30_000         # how long to wait for muscle to reattach
  muscleWaitPulseMs: 5_000     # emit `muscle.awaiting` every N ms
checkpoint:
  runningThrottleMs: 5_000
  retainCount: 4               # how many historical checkpoints per task kept inline
```

---

## 26.2 Resume After body.die

### Graceful shutdown is the easy case

`body.stop()` (SPEC-19.4) writes `task.checkpoint(state=…, sealedForShutdown=true)` for every in-flight task before quitting. Each checkpoint marks the resumption coordinates *and* the fact that the body exited deliberately.

On next `body.boot()`:

```ts
// after ledger open (Phase 2)
const plan = await planReplay(ledger);
if (cfg.recovery.resume.policy === 'auto') {
  for (const item of plan.resume) await taskPump.enqueueResumption(item);
} else if (cfg.recovery.resume.policy === 'prompt') {
  if (process.stdout.isTTY) await promptOperator(plan);
  else                     await emitResumePlanPulse(plan);    // CLI / web UI consumes it
} else {
  for (const item of plan.resume) await markOrphan(item.taskId, 'resume-disabled');
}
```

### Ungraceful exit — same machinery, different fingerprint

If the last entry is **not** a `body.dead` pulse, the body knows it crashed. It still runs `planReplay`. The differences: a previously-`running` checkpoint without progress for > `staleMs` (default `2 * runningThrottleMs`) is marked **stale-suspect**, leading to a probe before resume (rather than blind re-issue).

### Re-establishing muscle connections

The body's `MuscleRegistry` mounts according to its config; the question is *when* the registry signals `up`.

```ts
// packages/body/src/muscles/registry.ts
class MuscleRegistry {
  async mountAll(): Promise<void> {
    for (const cfg of this.cfgs) {
      this.mount(cfg).catch(e => this.markFailed(cfg.id, e));
    }
  }

  async waitFor(muscleId: string, ms: number): Promise<MuscleHandle> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const h = this.byId.get(muscleId);
      if (h && h.state === 'up') return h;
      await delay(this.cfg.muscleWaitPulseMs);
      this.bus.emit('muscle.awaiting', 'registry', { muscleId, elapsed: Date.now() - t0 });
    }
    throw muscleErr('MUSCLE_TIMEOUT', { muscleId });
  }
}
```

`taskPump.enqueueResumption` calls `registry.waitFor(env.muscleId, cfg.recovery.resume.muscleWaitMs)` before re-issuing. This lets the body boot the skin/HTTP *first*, so the missing muscle has a chance to attach (or, in stdio cases, the loader has time to spawn it).

### Orphan timeout

```yaml
resume:
  maxAgeMs: 86_400_000         # default 24h
```

Any task whose latest checkpoint is older than `maxAgeMs` at replay time is **auto-orphaned** with reason `aged-out`. This prevents zombie resurrection from week-old crashes and bounds the replay scan.

### Pulse sequence — graceful then resume

```
# Body 1, shutdown
t=0     body.dying            { reason: 'sigterm', inFlight: 2 }
t=0     task.checkpoint       { state: 'awaiting-child', taskId: T-002, sealedForShutdown: true }
t=1s    body.dead             { drained: 2 }

# Body 2, boot
t=0     body.booting          { phase: 'replay' }
t=0     replay.plan-built     { resume: 2, harvest: 0, orphan: 0 }
t=0     task.resumed          { taskId: T-002, resumedFrom: 'awaiting-child' }
t=0     task.resumed          { taskId: T-003, resumedFrom: 'dispatched' }
```

---

## 26.3 Orphan-Task Garbage Collection

### What an orphan is

A task with **any** of:
- No live ancestor (root was aged-out or aborted)
- `task.orphaned` ledger entry
- `aged-out` from `maxAgeMs`
- `harvest`-policy harvest captured but not consumed

Orphans accumulate cost (artifacts on disk, ledger rows). GC reaps them.

### GC policy

```yaml
# BodyConfig.recovery.orphans
gc:
  enabled: true
  ageBeforeGcMs: 604_800_000   # 7 days; orphans older than this are eligible
  scanIntervalMs: 21_600_000   # 6h
  preserveArtifactsKB: 16_384  # keep total artifact size below this; oldest evicted first
  artifactsDir: .fang/orphans/
```

### Scanner

`GcReport` is defined canonically in **SPEC-23.14**.

```ts
// packages/body/src/recovery/orphan-gc.ts
import type { GcReport } from '@fangai/body/types';

export class OrphanGc {
  async scanAndCollect(): Promise<GcReport> {
    const cutoff = new Date(Date.now() - this.cfg.ageBeforeGcMs).toISOString();
    const candidates = await this.ledger.queryOrphans({ before: cutoff });

    const report: GcReport = { reapedTasks: 0, freedBytes: 0, harvested: [] };
    for (const t of candidates) {
      if (t.artifacts.length && this.shouldPreserve(t)) {
        await this.moveToHarvest(t);
        report.harvested.push(t.taskId);
      }
      await this.ledger.markGc(t.taskId, { reason: 'orphan-gc', at: nowIso() });
      report.reapedTasks++;
      report.freedBytes += t.artifactBytes;
    }
    this.bus.emit('orphan.gc.completed', 'orphan-gc', report);
    return report;
  }
}
```

### Harvesting

Orphan results may be salvageable (the tests OpenCode wrote, the diff Cursor generated). The harvest path moves them into `.fang/orphans/<rootTaskId>/<taskId>/` with a `manifest.json` describing lineage, intent, and artifacts.

```
.fang/orphans/T-001/T-004/
├── manifest.json
├── artifact-t1.test.ts
└── artifact-d1.diff
```

`manifest.json`:

```json
{
  "rootTaskId": "T-001",
  "taskId": "T-004",
  "originalIntent": "tests:auth-middleware",
  "agentId": "opencode",
  "spentBudget": { "tokens": 10240 },
  "sealedAt": "2026-05-12T04:23:00Z",
  "reason": "ancestor-orphaned",
  "artifacts": [ { "id": "t1", "filename": "artifact-t1.test.ts", "mimeType": "text/x-typescript" } ]
}
```

### `fang harvest` CLI

```
$ fang harvest list                       # show orphan harvests, with age and bytes
$ fang harvest show T-001                 # details for one tree
$ fang harvest accept T-001/T-004 --to ./src/__tests__/    # move artifacts into project
$ fang harvest discard T-001/T-004        # delete (ledger keeps record)
```

`accept` writes a `memory.write` entry (`kind: 'observation'`) capturing the salvage, so future sessions know that artifact came from a harvested orphan.

### Reference counting alternative

For environments where age is wrong (e.g., long-running experiments), `gc.policy: 'refcount'` triggers reaping only when:
- `task.orphaned` is set, AND
- No `task.resumed` entry exists for the same `taskId` in the last `refcount.scanWindowMs`

This avoids time-bound deletion but requires the operator to invoke `fang gc orphans` manually.

### Storage cost over time

| Component | Growth | Cap |
|-----------|--------|-----|
| Ledger | linear in entries | rotation + gzip + prune (SPEC-25.2) |
| Checkpoints | linear in tasks, throttled | retainCount=4 per task |
| Orphans/artifacts | linear in orphans | `preserveArtifactsKB`; oldest-first eviction |
| Reservations | constant once released | none — released entries kept for audit |

A typical 1k-task/day body settles at ~50 MB/week of ledger + < 5 MB of orphans. The GC scan runs in < 50 ms over a 30-day window.

### Pulse sequence — GC pass

```
t=0     orphan.gc.scanning    { cutoff: '2026-05-05T00:00:00Z' }
t=50ms  orphan.gc.harvesting  { count: 4, totalBytes: 312_405 }
t=80ms  orphan.gc.completed   { reapedTasks: 27, freedBytes: 1_204_812, harvested: 4 }
```

---

## 26.4 Crash Drills — Locking the Behavior

`packages/body/src/__tests__/recovery/`:

| File | What it kills | Asserts |
|------|---------------|---------|
| `checkpoint.test.ts` | TaskPump after `dispatched` checkpoint | replay re-issues dispatch with same correlationId; muscle probe returns cached if available |
| `completing.test.ts` | TaskPump between `completing` and `task.end` | result probe returns cached; ledger re-writes `task.end` |
| `body-die-resume.test.ts` | full `body.stop()` mid-execution | next boot resumes both in-flight tasks; ledger lineage continuous |
| `body-crash-resume.test.ts` | `process.exit(137)` (simulated OOM) | next boot probes muscles, classifies stale-suspects, resumes safely |
| `orphan-gc.test.ts` | tmp ledger seeded with orphans from age=-8d | GC reaps + moves to `.fang/orphans/` |

Each test runs a real `Body` against `FakeMuscle` instances with optional `probeResult` implementations, using `vi.useFakeTimers()` for deterministic age control.

---

## 26.5 Recovery-Related Error Codes & Pulses (Additions)

> Canonicalised in **SPEC-23.19**. Listed here for spec-local readability.

- **`RecoveryErrorCode`:** `TASK_UNCERTAIN`, `TASK_AGED_OUT`, `PACT_EVICTED`, `RESERVATION_NO_LONGER_AVAILABLE`
- **`PulseKind` adds:** `replay.plan-built`, `task.resumed`, `task.uncertain`, `task.gc`, `muscle.awaiting`, `muscle.reattach`, `orphan.gc.scanning`, `orphan.gc.harvesting`, `orphan.gc.completed`, `pact.pin-rehydrated`, `budget.re-reserved`

🐙
