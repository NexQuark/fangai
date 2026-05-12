# SPEC 25 — Failure Modes: The Body Limps

> SEAM 2 of 5. The body limps; it does not crash. Five hostile shapes the substrate can take, and the exact pulse + state machine that survives each.

**Status:** Draft (Reconciled — Round 4) · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12
**Depends on:** SPEC-18, SPEC-19, SPEC-23, SPEC-24 (canonical types: §23.16 `BreakerConfig`/`BreakerState`/`DiskFullPolicy`, §23.17 `TrustBundle`/`OperatorKeyEntry`, §23.18 `HealthReport`/`LedgerEncryptionConfig`, §23.19 error codes)

---

## 25.1 Muscle Flaps — Circuit Breaker

### Detection windows

`BreakerConfig` and `BreakerState` are defined canonically in **SPEC-23.16**. The class implementation:

```ts
// packages/body/src/muscles/circuit-breaker.ts
import type { BreakerConfig, BreakerState } from '@fangai/body/types';

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures: number[] = [];           // timestamps within window
  private openedAt = 0;
  private halfOpenInFlight = 0;

  shouldRoute(): boolean {
    this.gc();
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cfg.cooldownMs) {
      this.transition('half-open');
    }
    if (this.state === 'half-open') return this.halfOpenInFlight === 0;
    return false;
  }

  recordSuccess(): void {
    this.failures = [];
    if (this.state === 'half-open') this.transition('closed');
  }

  recordFailure(reason: MuscleErrorCode): void {
    this.failures.push(Date.now());
    this.gc();
    if (this.state === 'half-open') return this.transition('open');
    if (this.state === 'closed' && this.failures.length >= this.cfg.failureThreshold) {
      this.transition('open');
    }
  }

  private transition(to: BreakerState) {
    const from = this.state;
    this.state = to;
    if (to === 'open') this.openedAt = Date.now();
    this.bus.emit(this.pulseFor(to), 'circuit-breaker', { muscleId: this.muscleId, from, to });
  }

  private pulseFor(s: BreakerState): PulseKind {
    return s === 'open' ? 'muscle.degraded'
         : s === 'half-open' ? 'muscle.probing'
         : 'muscle.recovered';
  }
}
```

### State machine

```
closed ── N failures in W ─→ open
open   ── cooldown elapsed ─→ half-open
half-open ── success ─→ closed
half-open ── failure ─→ open  (with full cooldown again)
```

### Pulse sequence — the "Cursor systemd flaps" story

```
t=0      muscle.connect       { muscleId: cursor }
t=8s     muscle.disconnect    { muscleId: cursor, reason: 'oom-kill' }
t=10s    muscle.connect       { muscleId: cursor }
t=14s    muscle.disconnect    { muscleId: cursor, reason: 'oom-kill' }
t=16s    muscle.connect       { muscleId: cursor }
t=22s    muscle.disconnect    { muscleId: cursor, reason: 'oom-kill' }
t=22s    muscle.degraded      { muscleId: cursor, failures: 3, windowMs: 60000 }
                                ^-- circuit OPEN; selector excludes cursor for 120s
t=142s   muscle.probing       { muscleId: cursor }
                                ^-- half-open; selector admits one probe
t=143s   muscle.recovered     { muscleId: cursor }
                                ^-- probe succeeded; circuit closed
```

### Selector exclusion

`resolveSelector` (SPEC-17.2) filter step 2 adds:

```ts
filter:
  - circuitBreaker.forMuscle(m.id).shouldRoute()
```

When all candidates are excluded, the selector falls back exactly as it does for `online: false` cases. If no fallback resolves, frame is rejected with `INK_NO_CANDIDATE.reason='all-breakers-open'`.

### Failure attribution — which errors count?

```ts
// Errors that ARE failures (count toward breaker)
const COUNTED = [
  'MUSCLE_UNREACHABLE',
  'MUSCLE_CRASHED',
  'MUSCLE_PROTOCOL_ERROR',
  'MUSCLE_TIMEOUT',
];

// Errors that are NOT failures (caller's fault, not muscle's)
const UNCOUNTED = [
  'INK_BUDGET_OVERDRAW',
  'PACT_*',
  'INK_DECLINED',          // muscle explicitly declined — that's healthy refusal
];
```

`MUSCLE_OVERLOADED` is special — counted but with reduced weight (0.3 of a hit) because the muscle is choosing to shed.

### Fitness coupling

A degraded muscle's `Fitness.components.successRate` drops; the recovery edge bumps `recency`. Selector ranking automatically deprioritizes recovering muscles for the first few minutes.

---

## 25.2 BloodLedger Disk Full

### Detection

```ts
async append(entry): Promise<void> {
  const line = JSON.stringify(canonicalize(entry)) + '\n';
  try {
    await this.writeLine(line);
  } catch (err: any) {
    if (err.code === 'ENOSPC') return this.onDiskFull(line, entry);
    if (err.code === 'EROFS')  return this.onReadOnlyFs(line, entry);
    throw err;
  }
}
```

`ENOSPC` is the canonical surface. We also handle `EROFS` (filesystem remounted ro), `EIO` (disk error → see SPEC 25.4).

### Three-tier mitigation

```ts
async onDiskFull(line, entry) {
  this.bus.emit('ledger.full', 'blood-ledger', { bytes: this.bytes, path: this.opts.path });

  // Tier 1: rotate current file and gzip stale ones in the background
  await this.rotate();
  await this.compressOldest();
  if (await this.tryWrite(line)) return;

  // Tier 2: delete oldest .jsonl.gz files until threshold cleared
  await this.pruneOldest({ targetFreeBytes: this.opts.minFreeBytes ?? 64 * 1024 * 1024 });
  if (await this.tryWrite(line)) return;

  // Tier 3: degraded mode — in-memory ring buffer, lossy
  this.degrade(entry);
}

private degrade(entry: BloodEntry): void {
  if (this.state !== 'degraded') {
    this.state = 'degraded';
    this.bus.emit('ledger.degraded', 'blood-ledger', { reason: 'no-space-after-prune' });
  }
  this.ringBuffer.push(entry);   // bounded; oldest evicted on overflow
  this.degradedDroppedCount += this.ringBuffer.lostThisCycle;
}
```

### Configurable rotation

```yaml
# in BodyConfig.blood
rotation:
  maxBytes:       64MB        # rotate when current file exceeds
  maxAgeMs:       86_400_000  # rotate daily
  compressAfter:  2           # gzip after N rotations
  pruneAfter:    30           # delete .jsonl.gz older than N days
  minFreeBytes:   64MB        # below this, attempt mitigation
  ringBuffer:     8192        # entries held in memory during degraded mode
```

### What the body keeps doing while degraded

| Subsystem | Behavior in `ledger.degraded` |
|-----------|-------------------------------|
| SoulPump  | continues evaluating; `ctx.ledger` reads from the ring + on-disk |
| TaskPump  | continues dispatching; `task.start`/`task.end` go to ring |
| Audit     | warning banner in `fang audit`: "window [t1, t2] is in-memory only" |
| Fitness   | computed from ring + on-disk; sample size may shrink |
| Memory    | continues writing to MEMORY.md (separate disk path); but `memory.write` ledger entries are ring-only |

The body refuses to die. The price: a window of frames is lost if the process exits before recovery.

### Recovery

A separate background watcher (`LedgerJanitor`) polls `statfs` every 10s while degraded. When free bytes ≥ `minFreeBytes`:

```
ledger.recovering   { ringDepth: N }
   ↓ drain ring → disk
ledger.recovered    { drained: N, lost: M }   // lost = ringBuffer evictions during the gap
```

`lost > 0` triggers a warning pulse and a banner on `/health`.

---

## 25.3 PACT Key Rotation

### Key store layout

```
.fang/keys/
├── trust-bundle.yaml          # signed list of trusted public keys
├── 2026Q2.pub                  # ed25519 public key (PEM)
├── 2026Q1.pub
└── ...
```

`trust-bundle.yaml`:

```yaml
schemaVersion: 1
activeKeyId: 2026Q2
trusted:
  - id: 2026Q2
    pub: ed25519:base64...
    notBefore: 2026-04-01T00:00:00Z
    notAfter:  2026-07-01T00:00:00Z
  - id: 2026Q1
    pub: ed25519:base64...
    notBefore: 2026-01-01T00:00:00Z
    notAfter:  2026-04-15T00:00:00Z   # 14d grace overlap with 2026Q2
signature: ed25519:base64...           # self-signed by the OUTGOING active key
```

The bundle itself is signed by the **outgoing** active key. This means: to rotate, you sign with the old key authorizing the new key. **The old key always endorses the new.** The body trusts the bundle if any currently-trusted key's signature verifies it.

### Genesis key

The genesis bundle is signed by an offline "founder" ed25519 key whose public half is baked into the body binary's identity (`packages/body/src/identity/founder.pub.ts`). Only one rotation away from genesis; subsequent rotations daisy-chain.

### Verification at frame time

```ts
function verifyPactSignature(pact: Pact, bundle: TrustBundle, now: Date): { ok: true } | { ok: false; code: PactErrorCode } {
  for (const k of bundle.trusted) {
    if (k.notBefore > now.toISOString() || k.notAfter < now.toISOString()) continue;
    if (ed25519.verify(pact.signature, canonical(pact), k.pub)) return { ok: true };
  }
  return { ok: false, code: 'PACT_SIGNATURE_INVALID' };
}
```

A PACT signed by 2026Q1 remains valid until 2026Q1's `notAfter`. After that, in-flight task envelopes pinned to that PACT will keep going (their evaluation already happened), but **new** dispatches with `pactRef` pointing at the old PACT fail with `PACT_SIGNATURE_INVALID` unless the old key is still within its validity window.

### Transition window — the 14-day grace overlap

```
2026-04-01    2026Q2 activated  ── bundle signed by 2026Q1
2026-04-15    2026Q1 expires    ── after this, only 2026Q2 verifies
[2026-04-01, 2026-04-15]: both keys valid, frames signed by either pass
```

For PACT files themselves: a new PACT (v+1) is always signed by the **active key at issue time**. The chain (`prev` links) is preserved. Verifying old PACTs in the chain uses each one's contemporaneous key (which must still be in `trusted[]` with `notBefore` early enough). Stale removal: trust bundle prunes keys whose `notAfter` is more than `pactStore.maxPinDays` in the past (default 90).

### Pulse sequence — rotation

```
t=0     pact.key.rotating     { newKeyId: 2026Q3, prevKeyId: 2026Q2, graceMs: 1_209_600_000 }
t=0     pact.bundle.updated   { sha: ..., activeKeyId: 2026Q3, trustedCount: 2 }
t=14d   pact.key.expired      { keyId: 2026Q2 }
```

### Where the private key lives

**Never on the body.** Private keys are held by:
- The VENOM operator (1Password, hardware token, offline disk).
- A signing oracle: `fang pact sign` is a CLI invoked by the operator on their workstation, taking PACT YAML + outputting signed file. The body never sees, generates, or stores private material.

Founder key is the lone exception — its public half is **compiled into the binary**. Lose the founder key → the only recovery is to publish a new binary release.

---

## 25.4 Memory Store Corruption

### Source-of-truth invariant

`MEMORY.md` is **derived**. The source of truth for every memory record is the corresponding `memory.write` entry in the BloodLedger. Corruption of MEMORY.md is therefore a recoverable indexing failure, not data loss.

### Detection — checksums per section

`MEMORY.md` layout:

```markdown
<!-- fang:memory v1 -->
<!-- repo:sha256:9af... -->

<!-- section:decisions sha256:abc... count:42 -->
## Decisions
- [pi · 2026-05-12T03:15] Abandoned passport.js ...
- [cursor · 2026-05-12T03:42] Renamed FangAdapter to FangMuscle
<!-- /section:decisions -->

<!-- section:observations sha256:def... count:11 -->
## Observations
...
<!-- /section:observations -->

<!-- footer sha256:0123... -->
```

`section:<name> sha256:<hex>` is computed over the canonical bytes between the markers. Footer sha is computed over the concatenation of all section shas.

```ts
class MemoryStore {
  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8');
    const sections = parseSections(text);
    for (const s of sections) {
      if (sha256(s.body) !== s.expectedSha) {
        this.bus.emit('memory.corrupt', 'memory-store', { section: s.name, expected: s.expectedSha });
        await this.rebuildSection(s.name);
      }
    }
    if (this.footerMismatch(sections)) await this.rebuildAll();
  }

  async rebuildSection(name: SectionName): Promise<void> {
    const records = await this.ledger.queryMemoryWrites({ section: name });
    await this.writeSection(name, records);
    this.bus.emit('memory.rebuilt', 'memory-store', { section: name, count: records.length });
  }
}
```

### Mid-write power loss — atomic publish

```ts
async function safeWrite(path: string, body: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { flag: 'w' });
  await fsync(tmp);                  // durably written
  await rename(tmp, path);           // atomic on same fs
}
```

Combined with section-level checksums: if the rename happened but the body never reached disk (extremely rare with fsync), the next boot detects the corrupt section and rebuilds it.

### Body boots without memory

If `MEMORY.md` is unreadable or fully unrecoverable:

```
memory.unavailable   { path, reason }
```

The body proceeds. `ContextPump.recap()` returns an empty document. SIPHON keeps writing new records to ledger. On next boot, the store is rebuilt from scratch via ledger replay.

### Degraded behaviors

| State | Read | Write | Recap injection |
|-------|------|-------|-----------------|
| `healthy` | from MEMORY.md (fast path) | dual: ledger + MEMORY.md | full |
| `rebuilding` | from ledger only (slow) | ledger only | full, slower |
| `unavailable` | empty | ledger only | empty + warning |

---

## 25.5 Sense (MCP) Process Death

### Heartbeat & detection

```ts
// packages/body/src/senses/health.ts
class SenseHealth {
  constructor(private sense: SenseHandle, private cfg = { intervalMs: 5000, missesAllowed: 3 }) {}

  start(): void {
    this.timer = setInterval(() => this.ping(), this.cfg.intervalMs);
  }

  private async ping(): Promise<void> {
    try {
      const t0 = Date.now();
      // stdio: tools/list (cheap); http: GET /health
      await this.sense.probe();
      this.consecutiveFails = 0;
      this.lastLatencyMs = Date.now() - t0;
    } catch (e) {
      this.consecutiveFails++;
      if (this.consecutiveFails >= this.cfg.missesAllowed) this.declareDead(e);
    }
  }
}
```

For stdio senses, an additional signal: child process `exit` event. For HTTP senses, TCP RST or 5xx with `MCP_*` body.

### Impact on in-flight calls

```ts
class SensePool {
  async invoke(senseId, tool, args): Promise<unknown> {
    const sense = this.active.get(senseId);
    if (!sense) throw senseErr('SENSE_DEAD', { senseId, tool });
    try {
      return await sense.call(tool, args);
    } catch (e) {
      if (this.health.justDied(senseId)) throw senseErr('SENSE_DIED_MID_CALL', { senseId, tool });
      throw e;
    }
  }
}
```

Error shape returned to the agent:

```json
{ "code": "SENSE_DIED_MID_CALL", "recoverable": true,
  "data": { "senseId": "github", "tool": "search_issues",
            "fallbacks": ["github-mirror", "gitea-local"],
            "restartingAttempt": 1, "nextProbeMs": 2000 } }
```

`recoverable: true` instructs adapters to surface a retryable error to their agents (which may call again; the dispatcher will route to a fallback if one exists).

### Auto-restart policy

```yaml
# in MuscleConfig.mcp[*].restart
restart:
  maxAttempts: 5
  backoffMs:   [1000, 2000, 5000, 15000, 60000]   # capped exponential
  resetWindowMs: 600_000   # if uptime > this, reset attempt counter
```

After `maxAttempts` consecutive failures within `resetWindowMs`, the sense is marked `dead-do-not-restart` and the body emits `sense.dead` (terminal). Manual `fang sense restart <id>` resets the counter.

### Migration — alternative providers

`McpDeclaration` supports advertising peer-equivalent tool sets:

```yaml
mcp:
  - serverId: github
    transport: stdio
    command: npx @modelcontextprotocol/server-github
    tools: ['*']
    equivalents:                          # 🆕
      - serverId: github-mirror
        toolMap: { search_issues: search_issues, get_repo: get_repo }
      - serverId: gitea-local
        toolMap: { search_issues: search_issues }
```

`SensePool.bestProvider(toolName)` consults `equivalents[]` when the primary is `dead-do-not-restart`. The fallback is selected by a fitness signal of its own (latency, recent success rate).

### Pulse sequence

```
t=0     sense.connect          { senseId: github }
t=120s  sense.unhealthy        { senseId: github, missedPings: 3 }
t=120s  sense.restarting       { senseId: github, attempt: 1, backoffMs: 1000 }
t=121s  sense.connect          { senseId: github }     // success after first restart
...
t=500s  sense.unhealthy        { senseId: github, missedPings: 3 }
t=620s  sense.dead             { senseId: github, attempts: 5, reason: 'restart-exhausted' }
t=620s  sense.migrated         { from: github, to: github-mirror, toolsCovered: [...] }
```

`sense.migrated` exists for audit visibility: a tool call that "just worked" actually routed to a backup, and that fact must be replayable.

---

## 25.6 Cross-Cutting: Health Aggregation

`/health` becomes the body's vital-sign report. The `HealthReport` shape is defined canonically in **SPEC-23.18**.

`status === 'degraded'` if **any** subsystem is non-`ok` but the body still accepts new tasks. `'critical'` if PACT is invalid or repoHash mismatch (post-boot drift detected).

---

## 25.7 Failure-Mode Error Codes (Additions)

> Canonicalised in **SPEC-23.19**. Listed here for spec-local readability.

- **`LedgerErrorCode`:** `LEDGER_DISK_FULL`, `LEDGER_RO_FS`, `LEDGER_IO`, `LEDGER_DEGRADED`
- **`SenseErrorCode`:** `SENSE_DEAD`, `SENSE_DIED_MID_CALL`, `SENSE_RESTART_EXHAUSTED`, `SENSE_MIGRATED`
- **`MemoryErrorCode`:** `MEMORY_CORRUPT`, `MEMORY_UNAVAILABLE`, `MEMORY_REBUILDING`
- **`PactKeyErrorCode`:** `PACT_KEY_EXPIRED`, `PACT_BUNDLE_INVALID`, `PACT_NO_TRUSTED_KEY`
- **`PulseKind` adds:** `muscle.probing`, `muscle.recovered`, `ledger.full`, `ledger.degraded`, `ledger.recovering`, `ledger.recovered`, `pact.key.rotating`, `pact.key.expired`, `pact.bundle.updated`, `memory.corrupt`, `memory.rebuilding`, `memory.rebuilt`, `memory.unavailable`, `sense.unhealthy`, `sense.restarting`, `sense.dead`, `sense.migrated`

---

## 25.8 Test Matrix

`packages/body/src/__tests__/failure/`:

| File | Scenario | Assertion |
|------|----------|-----------|
| `breaker.test.ts` | 3 fails → open; cooldown → half-open; success → closed | exact pulse order |
| `disk-full.test.ts` | tmpfs full → rotate + degrade; refill → recover | no thrown errors; ring drained |
| `key-rotation.test.ts` | rotate within grace; rotate after grace | old PACT pass / fail |
| `memory-corrupt.test.ts` | tamper section sha → boot rebuilds | rebuilt count matches ledger |
| `sense-flap.test.ts` | kill mcp server N times → migration | invocation routes to mirror |

🐙
