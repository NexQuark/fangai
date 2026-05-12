# SPEC 24 — Edge Cases: When the Happy Path Dies

> SEAM 1 of 5. Four hostile shapes the dispatch graph can twist into. Each has a protocol, a pulse sequence, and a refund contract.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12
**Depends on:** SPEC-17, SPEC-18, SPEC-19, SPEC-23

---

## 24.1 Parent Dies Mid-Flight (Orphan Cascade)

### Scenario

```
VENOM (root)
└── Pi (depth=1, taskId=T-002)            ← OOM, SIGKILL, TTL expiry
    └── Cursor (depth=2, T-003)           ← waiting on OpenCode result
        └── OpenCode (depth=3, T-004)     ← still running
```

Pi disappears. Cursor still has an HTTP/stdio connection to the body, expecting `ink/result` for T-004. OpenCode is mid-stream. Who tells whom?

### Liveness model — the body is the witness

The body holds the entire lineage tree. Adapters report transport-level state to the body. **No agent is responsible for detecting another's death.** Only the body decides "Pi is gone" and cascades.

Death of a muscle is detected by exactly one of:

| Adapter kind | Death signal | Latency |
|--------------|--------------|---------|
| `a2a-stdio` | stdio EOF or child exit code | ≤ 200ms |
| `a2a-http` | TCP RST, missed heartbeat ping (5s interval, 3-strike) | ≤ 15s |
| `host-tool` | Pi RPC channel close or `pi.session.dead` notify | ≤ 1s |
| `claw` | spawned-process exit | ≤ 200ms |

On any signal, the adapter emits `muscle.disconnect { muscleId, reason }` to the Conductor. `TaskPump` is subscribed and reacts.

### Orphan-detection protocol

```ts
// packages/body/src/hearts/task-pump.ts
class TaskPump {
  private byMuscle = new Map<string, Set<string>>();  // muscleId → in-flight taskIds
  private parents  = new Map<string, string>();        // taskId → parentTaskId
  private children = new Map<string, Set<string>>();   // taskId → childTaskIds

  onMuscleDisconnect(muscleId: string, reason: string): void {
    const orphanedTasks = this.byMuscle.get(muscleId) ?? new Set();
    for (const taskId of orphanedTasks) {
      this.handleOrphan(taskId, { cause: 'muscle.disconnect', muscleId, reason });
    }
  }

  private handleOrphan(taskId: string, cause: OrphanCause): void {
    // 1. Mark task as orphaned (irreversible)
    this.markOrphaned(taskId, cause);

    // 2. Walk descendants. For each, decide harvest vs cancel.
    for (const childId of this.descendants(taskId)) {
      const child = this.lookup(childId);
      if (child.policy.onOrphan === 'harvest') {
        // Let it complete; capture to ledger but un-routed.
        this.tagForHarvest(childId, taskId);
      } else {
        // Default: send ink/cancel to muscle.
        this.cancel(childId, { reason: 'ancestor-orphaned', ancestor: taskId });
      }
    }

    // 3. Refund remaining budget UP the live lineage.
    this.refundOrphan(taskId);

    // 4. Emit pulse + ledger entry.
    this.conductor.emit('task.orphaned', 'task-pump', { taskId, cause });
    this.ledger.append({ type: 'task.orphaned', taskId, payload: cause });
  }
}
```

### Pulse sequence

```
t+0     muscle.disconnect    { muscleId: 'pi', reason: 'eof' }
t+0     task.orphaned        { taskId: 'T-002', cause: { … } }
t+1     task.cancelling      { taskId: 'T-003', ancestor: 'T-002' }
t+1     task.harvesting      { taskId: 'T-004' }     // if policy=harvest
t+~     ink.result-captured  { taskId: 'T-004', referenced: false }  // OpenCode finishes
t+~     budget.refunded      { rootTaskId: 'T-001', amount: { tokens: 5240 } }
t+~     task.failed          { taskId: 'T-002', code: 'TASK_ORPHANED' }
```

### Harvest policy

```ts
interface OrphanPolicy {
  onOrphan: 'cancel' | 'harvest';      // default 'cancel'
  harvestMaxDurationMs?: number;        // wait at most N ms; then cancel
}
```

Default is `cancel` to bound resource burn. `harvest` is opt-in per dispatch (set on `meta.labels['orphan.policy']='harvest'`) and capped by PACT (`pact.rules.recursion.harvestMaxDurationMs`, default 60s).

Harvested results are written to ledger as:

```json
{ "type": "ink.harvested", "taskId": "T-004", "referenced": false,
  "rootTaskId": "T-001", "artifacts": [...], "spentBudget": {...} }
```

A later `fang harvest --root T-001` CLI can offer those artifacts to the user.

### Budget refund up a partially-dead chain

The body holds the master budget ledger keyed by `rootTaskId`. Each `ink/dispatch` is a **reservation** against that root (see §24.4). When a task is orphaned:

```
rootBudget          = ledger.rootBudget(rootTaskId)
spentByLineage      = sum(task.end.cost for task in lineage(taskId) where status != orphaned)
reservedByLineage   = sum(reservations for task in lineage(taskId) where state == active)

refundable = reservedByLineage - inFlightSpend   // pessimistic until child closes
ledger.refundReservation(rootTaskId, refundable)
```

If a descendant later harvests, its actual `spentBudget` is **added** to `spentByLineage` and the refund is reduced accordingly. The refund is final once `task.harvest.window` closes.

### Error shapes returned to the caller

For Cursor waiting on T-004 — the body emits to Cursor's adapter:

```json
{ "jsonrpc": "2.0", "id": "i2", "error": {
    "code": -32099, "message": "TASK_ORPHANED",
    "data": { "code": "TASK_ORPHANED", "ancestor": "T-002",
              "ancestorReason": "muscle.disconnect:pi",
              "recoverable": false } } }
```

`TASK_ORPHANED` is a new `MuscleErrorCode`. Cursor's adapter surfaces this as a normal failure path.

---

## 24.2 Budget Refund Under Partial Failure

### Scenario (the canonical 38K problem)

- Pi grants Cursor `40 000` tokens.
- Cursor spends `15 000` itself.
- Cursor dispatches `15 000` to OpenCode.
- OpenCode spends `10 000`, returns `partial` (2 of 3 tests).
- Cursor spends another `13 000` trying the 3rd test. Total `15 + 10 + 13 = 38 000`. Cursor cannot fit a retry → returns to Pi.

What gets refunded? To whom? When?

### Two ledgers: granted vs actual

Every dispatch creates two rows in the budget ledger:

| Row | Set at | Released at |
|-----|--------|-------------|
| `reservation` | `ink.dispatched` (SoulPump.evaluate) | `task.end` |
| `actual` | streaming via `ink.progress` deltas + final `spentBudget` | `task.end` |

Reservation is the cap; actual is the truth. Refund = reservation − actual.

### Refund flows UP the live chain, not just one hop

Cursor reports to Pi:

```json
{ "spentBudget": { "tokens": 38000, "durationMs": 312000 } }
```

The body's `BudgetReservation` ledger sees `granted=40000, actual=38000` at the Cursor row. The 2000-token delta is **immediately** credited back to Pi's reservation against the root, **and** Pi's row's `remaining` count goes up. Pi can now afford a 2K follow-up dispatch.

For depth-N chains, the flow is recursive:

```
finalize(taskId):
  row = ledger.get(taskId)
  delta = row.reserved - row.actual
  ledger.refundTo(row.parentTaskId, delta)
  if row.parentTaskId: emit pulse 'budget.refunded' { from: taskId, to: parent, delta }
```

A grandchild that overspends does **not** silently eat the parent — overspend is rejected pre-flight by SoulPump (see §24.4). A grandchild that underspends refunds to its parent's reservation, which becomes available to siblings of the grandchild.

### Partial-result refund signal

`status: 'partial'` carries the same `spentBudget` as `status: 'ok'`. Refund accounting does not branch on status. The difference is **fitness**: partial sets `fitnessSignal.quality ≤ 0.7` by convention; full set has `quality = 1.0 - latencyPenalty`.

### Death by a thousand cuts — overhead tax

Each hop adds overhead (parsing, validation, ledger writes, prompt boilerplate). Empirically ~3–7%. Over depth 4 at 5%, a root grant of 100K decays to ~81K of useful work.

**Three mitigations, all in PACT:**

```yaml
budgets:
  perHopOverhead:
    estimateTokens: 200          # added to every dispatch reservation
    estimateMs: 50
  starvationFloor:
    minTokensPerHop: 2000        # SoulPump rejects dispatches granting less
    minDurationMs: 2000
  hopBudgetGuard:
    maxHopOverheadFraction: 0.10 # SoulPump warns if granted < requested * (1 - this)
```

Behavior:

1. **Estimate tax** — every reservation reserves `requested + perHopOverhead.estimateTokens` against the parent. If actual overhead < estimate, the unused portion refunds normally.
2. **Starvation floor** — if `granted.tokens < starvationFloor.minTokensPerHop`, SoulPump throws `INK_BUDGET_OVERDRAW` with detail `'below-starvation-floor'`. The parent must restructure.
3. **Hop-overhead guard** — soft pulse `budget.starved` when overhead share exceeds the threshold. Operators see this in `/health.budget` and can act.

---

## 24.3 PACT Reload Race

### Scenario

- t=0   VENOM writes PACT-v4.md.
- t=1ms F1 (already evaluated against v3) is mid-flight in TaskPump.
- t=2ms SoulPump fs-watcher fires `pact.reload`.
- t=3ms F2 arrives, evaluated against v4.

If v4 tightens `budgets.perAgent.cursor.tokensPerHour`, and F1 was Cursor's child dispatch sized against v3's looser cap, what happens?

### Version-pinning protocol

Every frame, on evaluation, is stamped with the PACT it was evaluated against. The stamp lives **in the task envelope**, not in the wire frame.

```ts
// In TaskPump.acceptFrame
const decision = soul.evaluate(frame, soul.activePact, ctx);
if (!decision.ok) throw new PactViolation(decision.violation);
const env: TaskEnvelope = {
  frame,
  pactPin: { version: soul.activePact.version, sha: soul.activePact.sha },
  signedAt: decision.signedAt,
  reservationIds: [],
};
this.envelopes.set(frame.correlationId, env);
```

When that task spawns a child:

```ts
// child inherits pactPin
child.frame.pactRef = env.pactPin;
soul.evaluate(child.frame, soul.pactFor(env.pactPin), ctx);   // <-- evaluated under parent's pin
```

`soul.pactFor(pin)` looks up the historical PACT by sha. The current PACT chain is loaded fully into memory at boot (or lazily for older versions). Reload appends a new node but **never garbage-collects** old PACTs while any envelope still pins them. `pactStore.refCount` is incremented on pin, decremented on `task.end`.

### Atomic swap

`SoulPump.setPact` is the only mutator of `activePact`. It is serialized through a single mutex. Steps:

```
soul.setPact(newPact):
  acquire lock
  validate signature chain (prev links to current.sha)
  pactStore.add(newPact)
  prev = activePact
  activePact = newPact
  emit pulse 'pact.swapped' { fromVersion: prev.version, toVersion: newPact.version }
  release lock
```

In-flight frames stamped with `prev` continue using `prev` via their pin. New frames arriving after the swap read `activePact` = newPact.

### What about tightened caps that F1's child would violate?

Two modes, PACT-configurable:

```yaml
versioning:
  strictOnReload: false   # default
  graceMs: 60_000          # how long old PACT remains pinnable for new children
```

- `strictOnReload: false` (default) — children of pinned tasks evaluate under the pin. Looser caps apply. The org accepts that in-flight subtrees may briefly exceed new-PACT caps. Safe because the **whole subtree** finishes within the deadline of the original frame.
- `strictOnReload: true` — children re-evaluate against `activePact`. A pin-tightening reload can fail in-flight children with `PACT_STALE` and surface to the parent. Parent must decide: replan or abort.

### Pulse sequence (race-free path)

```
t=0    pact.detected        { path: 'PACT-v4.md', sha: '...' }
t=0    pact.verifying       { fromVersion: 3, toVersion: 4 }
t=1ms  pact.swapped         { from: 3, to: 4 }
t=2ms  pact.in-flight       { pinnedCount: 2, pinnedVersions: [3] }   // for /health
t=5s   pact.pin-released    { taskId: 'T-003', version: 3 }
```

### Memory budget for pinned PACTs

PACTs are small (typically < 4 KiB). The store caps at `pactStore.maxRetained = 16` versions. Beyond that, GC waits for refcount to drop before evicting. If a task pins an evicted PACT (cold start replay), the body re-reads it from `.fang/PACT-v<N>.md`.

---

## 24.4 Simultaneous Dispatch — Budget Reservation Protocol

### Scenario

Pi fans out two children to Cursor at t=0 and t=1ms. Each independently passes PACT (Cursor has 200K/hour cap, Cursor has spent 100K, each child requests 60K). Combined, they reserve 120K → 220K total → over cap.

### Why isolation fails

A pure `evaluate(frame, pact, ctx)` reads `ctx.ledger.windowSpend(agent)` which **does not yet include in-flight reservations**. Two concurrent evaluations see the same baseline and both pass.

### Solution — reservation table is the truth

`BudgetReservation` is a sibling of the ledger. SoulPump consults it on every evaluation, and the act of evaluation is atomic-reserve-or-reject.

```ts
// packages/body/src/blood/budget-reservation.ts
export interface Reservation {
  id: string;
  rootTaskId: string;
  taskId: string;
  agentId: string;
  granted: BudgetRequest;
  parentReservationId?: string;
  state: 'active' | 'released' | 'refunded';
  createdAt: string;
}

export class BudgetReservation {
  private byAgent = new Map<string, Set<string>>();   // agentId → reservationIds
  private byRoot  = new Map<string, Set<string>>();   // rootTaskId → reservationIds
  private locks   = new Map<string, Mutex>();          // agentId → mutex

  async tryReserve(req: ReserveRequest): Promise<Reservation | ReserveDenied> {
    const mu = this.lockFor(req.agentId);
    return mu.runExclusive(() => {
      const current = this.activeFor(req.agentId);
      const proposed = current.sum.tokens + req.granted.tokens;
      const cap = req.cap.tokensPerHour - this.windowSpend(req.agentId).tokens;

      if (proposed > cap) {
        return { ok: false, code: 'BUDGET_RESERVATION_DENIED',
                 detail: { current: current.sum.tokens, proposed, cap } };
      }
      const r = this.create(req);
      return { ok: true, ...r };
    });
  }

  release(id: string, actual: BudgetRequest): void { /* refund delta to parent */ }
  cancel(id: string): void { /* full refund */ }
}
```

### Where the lock lives

One `Mutex` instance per `agentId` (lazy-created). Reservation for `cursor` serializes; reservation for `opencode` does not. This keeps fan-out parallel **across** agents while serial **within** an agent.

### Pulse sequence for the race

Both F1 and F2 arrive at T+0..1ms. The dispatcher serializes them on the Cursor mutex:

```
t=0    ink.dispatched     { correlationId: F1, agent: cursor }
t=0+   pact.passed        { correlationId: F1 }
t=0+   budget.reserved    { id: R1, agent: cursor, granted: 60000, remainingCap: 40000 }
t=0+1  ink.dispatched     { correlationId: F2, agent: cursor }
t=0+1  pact.passed        { correlationId: F2 }  // pact-level only
t=0+1  budget.denied      { id: R2-attempt, agent: cursor, requested: 60000,
                            current: 60000, cap: 100000 }   // post-F1 reservation
t=0+1  ink.declined       { correlationId: F2, reason: 'budget-too-low', detail: 'reservation-denied' }
```

F2 is declined by SoulPump itself (not the muscle). The parent sees an `INK_BUDGET_OVERDRAW` with `data.kind: 'reservation-collision'` and can replan (smaller request, fallback agent, serialize).

### Two-phase reserve for true fan-out

When the parent **knows** it will fan out, it can pre-reserve in one call:

```jsonc
{ "method": "ink/fanout-reserve", "params": {
    "rootTaskId": "T-001", "parentTaskId": "T-002",
    "children": [
      { "selector": { "kind":"direct", "agentId":"cursor" }, "budget": { "tokens": 50000 } },
      { "selector": { "kind":"direct", "agentId":"opencode" }, "budget": { "tokens": 20000 } }
    ]
}}
```

SoulPump evaluates the bundle **atomically**: either all reservations succeed and `fanoutReservationId` is returned, or none. Dispatch then quotes the reservation:

```jsonc
{ "method": "ink/dispatch", "params": {
    "fanoutReservationId": "F-001-r1",
    ...
}}
```

This converts the race into a single-decision-point. Used when callers (especially Pi's planning prompts) deliberately split work.

---

## 24.5 Tests That Lock These Behaviors

Each scenario above gets a deterministic test in `packages/body/src/__tests__/edge/`:

| File | Test |
|------|------|
| `orphan-cascade.test.ts` | Pi disconnect mid-flight → cascade cancel + refund; with `harvest` policy → result captured + un-referenced |
| `refund-flow.test.ts` | 40K dispatch returning 38K → 2K refund to parent ledger row; deep chain refund propagation |
| `pact-pin.test.ts` | F1 mid-flight, PACT swap, F1's child evaluates under pin; strictOnReload=true fails F1's child |
| `reservation-race.test.ts` | Two concurrent direct dispatches to same agent past cap → exactly one wins, one is `INK_BUDGET_OVERDRAW.reservation-collision` |
| `fanout-reserve.test.ts` | Atomic bundle: all-or-nothing reservation |

Fixtures: `packages/body/fixtures/edge/*.jsonl` capture the exact ledger sequences expected.

---

## 24.6 Error Code Additions

```ts
// extends MuscleErrorCode
| 'TASK_ORPHANED'

// extends InkErrorCode
| 'INK_RESERVATION_DENIED'
| 'INK_FANOUT_RESERVATION_FAILED'

// extends PulseKind
| 'task.orphaned' | 'task.cancelling' | 'task.harvesting'
| 'ink.harvested'
| 'pact.detected' | 'pact.verifying' | 'pact.swapped' | 'pact.pin-released'
| 'budget.reserved' | 'budget.denied' | 'budget.refunded'
```

🐙
