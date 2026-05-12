# SPEC 28 — Security Model: The Body's Trust Boundaries

> SEAM 5 of 5. Trust is bound at every edge: bootstrap, identity, frame replay, transport, and audit. Five threats, five mechanisms, no philosophy.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12
**Depends on:** SPEC-14, SPEC-17, SPEC-18, SPEC-19, SPEC-23

---

## 28.1 Trust Bootstrap — Genesis With No Prior PACT

### The chicken-and-egg

A fresh machine. `fang init`. No PACT exists. PACT must be signed by a trusted key. Where does the key come from?

### Two-key architecture

```
┌────────────────────────────────────────────────────────────┐
│  Founder key (offline)                                     │
│  - Public half: compiled into binary `founder.pub.ts`      │
│  - Private half: held by Fang maintainers, NEVER on body   │
│  - Used only to sign release-shipped genesis bundles       │
└────────────────────────────────────────────────────────────┘
                       │ signs
                       ▼
┌────────────────────────────────────────────────────────────┐
│  Operator key (per body)                                   │
│  - Public half: in `.fang/keys/<keyId>.pub`                │
│  - Private half: held by VENOM operator (1Password,        │
│    hardware token, secure enclave, etc.)                   │
│  - Used to sign PACT files and trust-bundle rotations      │
└────────────────────────────────────────────────────────────┘
                       │ signs
                       ▼
                  PACT-v1, v2, ...
```

The founder key is shipped with the body; it only signs the **initial trust bundle template** that introduces the operator's public key. After that, the operator's key signs PACTs.

### `fang init` flow

```
$ fang init
1. Detect repo root + repoHash
2. Check for existing .fang/PACT.md → if present, abort
3. Generate operator keypair locally (sodium.crypto_sign_keypair)
4. Print private key + recovery phrase → require user confirmation it's stored
5. Write .fang/keys/<operatorId>.pub
6. Render a default PACT-v1.md template (strict; deny everything not explicit)
7. fang pact sign --key <operator-private> writes signature
8. Write trust-bundle.yaml, founder-signed via embedded oracle:
     - oracle = `fang sign genesis-bundle` (signs with founder key shipped read-only in binary)
9. Verify chain end-to-end before exit
```

The founder key's "signing oracle" is **not** present in the running body. It is a tiny CLI built from a separate npm package (`@fangai/genesis-oracle`) that contains the founder private material **embedded at the time of release**. It is the one moment in a body's life when this key is touched. After `fang init`, the oracle binary is no longer used.

> **Practical note:** This pattern is deliberately heavyweight. Most users will run `fang init --quick`, which uses an "ephemeral genesis" — a generated operator key that signs its own genesis bundle (self-rooted). Such bodies are valid but cannot be cross-verified by other Fang installations. Self-rooted bodies cannot receive cross-machine A2A messages from other Fang bodies; that requires the founder-rooted chain.

### Pre-PACT muscle injection — the bootstrap window

The body's boot sequence (SPEC-19.2) is ordered specifically to prevent this:

```
Phase 1: config
Phase 2: ledger
Phase 3: identity (repoHash)
Phase 4: senses scan (file enumeration only; no execution)
Phase 5: memory
Phase 6: muscles — REQUIRES pact to be loaded
Phase 7: senses connect — REQUIRES pact's mcp allowlist
Phase 8: hearts
Phase 9: pact — but this is the LOAD-AND-VERIFY step; PACT file must already exist
```

If PACT is missing at Phase 9, boot fails with `BOOT_NO_PACT`. The body never enters a state where it can route a frame without a PACT.

Mitigation for `fang init` itself: during init the body runs in a `boot:init-only` mode that mounts **only the local-fs and key-gen tools**. No muscles. No senses. No skin. Init's only side effect is the new PACT + keys.

### Config flag

```yaml
# in BodyConfig
bootstrap:
  allowEmpty: false           # default; require PACT before serving
  initOnlyMode: false         # set automatically by `fang init`
```

A user who sets `allowEmpty: true` and starts without PACT gets a "minimal-trust body": only `claw` tier-0 muscle, no INK dispatch, no remote agents. Designed for debugging boot failures, not production.

---

## 28.2 Agent Impersonation — Identity Binding

### The problem

`lineage[].agentId` is **self-reported**. Without binding, any client can dispatch claiming to be `pi` or `cursor`. PACT's agent allowlist is meaningless if anyone can name themselves whatever they want.

### Binding by transport

Each muscle kind has a transport-level identity that the body owns:

| Muscle kind | Identity proof |
|-------------|----------------|
| `a2a-stdio` | child PID — body spawned this process; lifecycle and identity are inherent |
| `a2a-http` | (1) mutual TLS with a registered client cert, OR (2) bearer token from PACT-registered keyring; the listener binds 127.0.0.1 by default |
| `host-tool` | hosting agent (Pi/Cursor) writes through a private pipe owned by the body's process; only the body's parent process can open it |
| `claw` | in-process; identity is structural — code can only construct ClawMuscle with the body's internal handle |

```ts
// packages/body/src/muscles/identity.ts
export interface MuscleIdentity {
  muscleId: string;
  bindingKind: 'pid' | 'mtls' | 'bearer' | 'pipe' | 'in-process';
  bindingProof: {
    pid?: number;
    fingerprint?: string;            // mTLS cert sha256
    tokenId?: string;                // bearer key id (NOT the token)
    pipePath?: string;
    inProcessHandle?: symbol;        // unforgeable in JS
  };
  boundAt: string;
}
```

### Registry binds at mount time

```ts
class MuscleRegistry {
  async mount(cfg: MuscleConfig): Promise<MuscleHandle> {
    const adapter = this.loader.load(cfg);
    const identity = await adapter.proveIdentity();   // each adapter implements
    if (!this.matchesAuthorization(cfg.id, identity)) {
      throw muscleErr('MUSCLE_IDENTITY_REJECTED', { cfg, identity });
    }
    const handle = new MuscleHandle(cfg, adapter, identity);
    this.byId.set(cfg.id, handle);
    this.byBinding.set(this.bindingKey(identity), handle);
    this.bus.emit('muscle.bound', 'registry', { muscleId: cfg.id, bindingKind: identity.bindingKind });
    return handle;
  }

  resolveSender(transport: TransportInbound): MuscleHandle {
    const key = this.bindingKey(transport.identity);
    const h = this.byBinding.get(key);
    if (!h) throw muscleErr('MUSCLE_IDENTITY_UNKNOWN', { transport });
    return h;
  }
}
```

### Per-frame check

For every inbound frame:

```ts
function authenticateFrame(frame: InkPayload, sender: MuscleHandle): void {
  const claimed = lastLineageAgent(frame);
  if (claimed !== sender.cfg.id) {
    throw inkErr('INK_AGENT_SPOOFED', {
      claimed, actual: sender.cfg.id, binding: sender.identity.bindingKind
    });
  }
  // additional: lineage HMAC chain
  if (!verifyLineageMacChain(frame.lineage, this.bindingSecrets)) {
    throw inkErr('INK_LINEAGE_FORGED', { lineage: frame.lineage });
  }
}
```

### Lineage HMAC chain

Each hop, when adding to lineage, includes an HMAC over the previous hops using the agent's mount-time `bindingSecret` (derived from the body's master secret + agentId):

```ts
// lineage hop with mac
interface LineageHop {
  taskId: string;
  agentId: string;
  ts: string;
  mac: string;            // hmac-sha256(prevLineage || taskId || agentId || ts, bindingSecret(agentId))
}
```

`bindingSecret(agentId)` is held only by the body and embedded by the dispatcher when it hands a frame to a muscle (the muscle sees its secret as a sealed envelope; it cannot forge a hop attributed to a sibling). Verification:

```ts
function verifyLineageMacChain(lineage: LineageHop[], secrets: SecretsTable): boolean {
  let prev: LineageHop[] = [];
  for (const hop of lineage) {
    const expected = hmac(canonicalize([...prev, { ...hop, mac: undefined }]), secrets.get(hop.agentId));
    if (!constantTimeEqual(expected, hop.mac)) return false;
    prev.push(hop);
  }
  return true;
}
```

A tampered or fabricated hop fails because the attacker doesn't know the bindingSecret. The body's master secret is generated at `fang init` and stored encrypted at `.fang/secrets.enc` (sealed with the operator's public key; only decrypted in memory at boot). For minimal-trust bodies, the secret is derived from machine identity + repoHash (less secure; documented).

---

## 28.3 INK Frame Replay Defense

### Layered defenses

1. **CorrelationId uniqueness** — uuidv7 sortable + collision-resistant
2. **In-memory `seenSet`** — last N correlationIds with TTL
3. **Ledger window check** — before SoulPump evaluation, query ledger for prior `ink.dispatched` matching correlationId
4. **`signedAt` freshness** — every frame carries a timestamp signed by SoulPump; replay beyond `replay.windowMs` rejected
5. **HMAC over frame body** — prevents transport-level tampering before any ledger touch

### `seenSet` ahead of the ledger

```ts
// packages/body/src/nerves/anti-replay.ts
export class AntiReplay {
  private set = new LruCache<string, number>({ maxItems: 100_000, ttlMs: 600_000 });

  guard(frame: InkPayload, signedAt: string): void {
    const ageMs = Date.now() - Date.parse(signedAt);
    if (ageMs > this.cfg.windowMs) {
      throw inkErr('INK_REPLAY_STALE', { signedAt, windowMs: this.cfg.windowMs });
    }
    if (this.set.has(frame.correlationId)) {
      throw inkErr('INK_DUP_CORRELATION', { correlationId: frame.correlationId });
    }
    this.set.set(frame.correlationId, Date.now());
  }
}
```

The `seenSet` is checked **before** the ledger to short-circuit cheap replays. The ledger check is the safety net for memory eviction (e.g., a replay arriving after `seenSet` evicted the entry).

### Ledger window check

```ts
async function ledgerReplayCheck(ledger: BloodLedger, frame: InkPayload, windowMs: number): Promise<void> {
  const since = new Date(Date.now() - windowMs).toISOString();
  for await (const e of ledger.scanSince(since)) {
    if (e.type === 'ink.dispatched' && e.correlationId === frame.correlationId) {
      throw inkErr('INK_DUP_CORRELATION', { correlationId: frame.correlationId, prior: e.ts });
    }
  }
}
```

Run **after** the in-memory guard. Together they form a window that exceeds typical attack timings (10 min default).

### Signed body HMAC

```ts
interface SignedInk {
  payload: InkPayload;
  signedAt: string;          // body's stamp
  hmac: string;              // hmac-sha256(canonicalize(payload || signedAt), bindingSecret(sender))
}
```

All host-tool and http transports carry `SignedInk`, not raw `InkPayload`. The dispatcher verifies HMAC + checks `signedAt` window + checks correlationId — **before** SoulPump.

### Config

```yaml
security:
  replay:
    windowMs: 600_000          # 10 min
    seenSet:
      maxItems: 100_000
      ttlMs: 600_000
    ledgerCheck: true
  hmac:
    enabled: true
    algorithm: 'hmac-sha256'
```

### Audit pulse

```
ink.replay-blocked   { correlationId, reason: 'duplicate' | 'stale' | 'hmac-mismatch', source }
```

Counted on a per-source basis. Sustained replay attempts trigger `muscle.degraded` for the offending sender (force a circuit-break style cooldown).

---

## 28.4 Side-Channel Surface — Transport, Storage, Memory

### Surface inventory

| Component | At rest | In transit | Threat | Mitigation |
|-----------|---------|------------|--------|------------|
| `host-tool` dispatch frames | n/a | Pi stdin/stdout pipe | Any process that can read Pi's fds | Body owns the pipe; Pi is a child of body; pipe inherited only by child; not on disk |
| `http-sse` ink endpoints | n/a | TCP localhost (default) or LAN/WAN | LAN sniffing, CSRF | TLS required outside localhost; bearer key from PACT keyring; SameSite=Strict; CORS strict-origin |
| BloodLedger | JSONL on disk | n/a | Disk theft, multi-user host | File mode 0600; optional AES-GCM-at-rest (key derived from operator key + machine id) |
| MEMORY.md | Markdown on disk | n/a | Same as ledger; plus user-readable plaintext | 0600; SIPHON redacts secrets pre-write; optional encryption symmetric with ledger |
| `.fang/secrets.enc` | sealed | n/a | Disk theft | Sealed with operator public key (libsodium sealed box); decrypted only in-process |
| Reservation table | in-memory | n/a | Process-memory dump | Wiped on shutdown; secrets zeroed on unmap |

### Host-tool transport (Phase 1)

```
body process (parent)
  └── spawn Pi (stdio inherited from pipes the body created)
        └── Pi RPC carries host_tool_call frames
              → body reads from Pi's stdout
              ← body writes to Pi's stdin
```

Only the body and Pi see these bytes. Any other process on the system would need to either be the body's parent (which can read child fds) or attach to Pi's process (which requires either root or `CAP_SYS_PTRACE` / `ptrace_scope` permissions). The body documents requirements in `docs/SECURITY-OPERATIONS.md`.

### HTTP transport (Phase 2)

```yaml
# in BodyConfig.skin.http
http:
  host: 127.0.0.1            # default localhost-only
  port: 4117
  tls:
    enabled: false           # required when host != 127.0.0.1
    cert: path
    key:  path
    requireClientCert: true  # mTLS by default for remote
  auth:
    bearerKeys: []           # references to keys in PACT keyring
    perRouteAcl:
      '/health':     'public'
      '/ink/*':      'authenticated'
      '/audit/*':    'operator'
  cors:
    allowOrigins: []         # empty = none
    sameSite: 'strict'
```

Listening on `0.0.0.0` is **rejected at boot** unless TLS + mTLS + auth keys are all configured. `BOOT_INSECURE_HTTP` is a hard failure.

### Ledger at rest

```ts
interface LedgerEncryptionConfig {
  enabled: boolean;
  algorithm: 'aes-256-gcm';
  keyDerivation: 'argon2id' | 'kdf-from-operator-pubkey';
  segmentBytes: number;          // 64KB segments → seekable
}
```

When enabled, each JSONL line is preceded by an AES-GCM tag and the file is read/written via a streaming layer (`packages/body/src/blood/encrypted-jsonl.ts`). Performance cost: ~5–10% on a typical workload. Off by default; on by recommendation for shared machines.

### Memory contents

`MEMORY.md` will sometimes contain "subject: aws_access_key_id rotation cadence". The body must not write the value. SIPHON applies a **redaction pass** before persisting any record body:

```ts
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'aws-akid',     re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret',   re: /\b[A-Za-z0-9/+]{40}\b/g },                  // heuristic
  { kind: 'gh-token',     re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt',          re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: 'generic-key',  re: /\b(?:api[_-]?key|password|token|secret)["':=\s]+[^"\s,}]{8,}/gi },
];

function redact(body: string): { body: string; redactions: Array<{kind: string; count: number}> } { /* ... */ }
```

PACT may extend `secrets.redactionPatterns`. Redactions are replaced with placeholders like `<redacted:gh-token:1>`. Original is **not** stored; recovery is impossible by design.

### Threat model

Out of scope (documented in SPEC-14):
- Root-on-host attacker.
- A compromised muscle process that the operator chose to mount.
- Side-channel timing on local CPU.
- The model itself exfiltrating secrets via prompt content (mitigated only by PACT-level prompt redaction).

In scope:
- Untrusted *processes on the same machine* (not root).
- Network attackers when http transport is enabled.
- Recovery of secrets from on-disk ledger/memory.
- Forgery of identities and lineages over the network.

---

## 28.5 Audit Replay — From Ledger to Human-Readable Truth

### Audit invariants

The ledger is a complete record. To audit a `rootTaskId`, every relevant decision must be retrievable:

| Decision | Ledger entry |
|----------|--------------|
| Frame received | `ink.received` |
| PACT evaluation | `pact.passed` / `pact.rejected` (always, even on pass) |
| Budget reservation | `budget.reserved` |
| Dispatch | `ink.dispatched` |
| Muscle response | `ink.received` (with `dispatchedBy`) |
| Progress | `ink.progress` (sampled to ledger; full stream in session recorder) |
| Result | `ink.completed` + `task.end` |
| Refund | `budget.refunded` |
| Memory write | `memory.write` |
| Pulse | `pulse` (with kind, source) |

CI enforces: a test fires a known three-agent task; the audit replay should produce **exactly the expected sequence** (snapshot).

### Tool: `fang audit replay <rootTaskId>`

```ts
// packages/body/src/audit/replay.ts
export interface AuditReport {
  rootTaskId: string;
  generatedAt: string;
  timeline: AuditEvent[];
  tree: LineageTreeNode;
  budgetFlow: BudgetFlow;
  violations: AuditViolation[];
  decisionTree: DecisionTreeNode;     // why each routing happened
  meta: {
    totalDurationMs: number;
    totalCost: { tokens: number; usd: number };
    agentsInvolved: string[];
    pactVersions: number[];
  };
}

export class AuditTool {
  constructor(private ledger: BloodLedger, private pactStore: PactStore) {}
  async replay(rootTaskId: string): Promise<AuditReport>;
  async export(rootTaskId: string, format: 'json' | 'html' | 'mermaid'): Promise<string>;
}
```

### CLI

```
$ fang audit replay T-001 --format html > audit.html
$ fang audit replay T-001 --format json
$ fang audit replay T-001 --format mermaid > tree.mmd
$ fang audit timeline --since 2026-05-12T03:00:00Z --until 2026-05-12T05:00:00Z
$ fang audit violations --kind pact.rejected --limit 50
```

### HTML report shape

```
<header>
  T-001  ·  generated 2026-05-12T05:00Z  ·  4 agents  ·  2m 14s  ·  $0.42  ·  92 800 tokens
</header>

<tabs>
  Timeline | Lineage Tree | Budget Flow | Decision Tree | Violations
</tabs>

<timeline>
  04:20:00.000   VENOM → Pi               message/send "Audit auth-middleware"
  04:20:00.012   pact.passed              Pi  (v3, all rules)
  04:20:00.014   ink.received             Pi
  04:20:03.117   ink.dispatched           Pi → Cursor  budget=40K
  04:20:03.123   pact.passed              Cursor (v3)
  04:20:03.125   budget.reserved          Cursor 40 000 tokens (rR-cur-001)
  ...
  04:22:14.001   ink.completed            T-001 status=ok
  04:22:14.020   budget.refunded          rR-cur-001 → root, 1 400 tokens
</timeline>

<tree>  (mermaid)
  graph TD
    VENOM-->|message/send| Pi
    Pi-->|ink/dispatch 40K| Cursor
    Cursor-->|ink/dispatch 15K| OpenCode
    OpenCode-->|result 10K spent| Cursor
    Cursor-->|result 38K spent| Pi
    Pi-->|status-update completed| VENOM
</tree>

<budgetflow>  (sankey-style)
  root grant 60K
    └─ Pi reserved 60K, spent 1.4K (overhead) + child 40K
        └─ Cursor reserved 40K, spent 15K + child 13K
            └─ OpenCode reserved 15K, spent 10K, refunded 5K
        └─ refund 2K to Pi → 7K to root
</budgetflow>

<decisiontree>
  Pi selected by: VENOM direct dispatch
  Cursor selected by:
    selector: skill='code.refactor' costTier='mid' minFitness=0.6
    candidates: [cursor (0.91), claude (0.84)]
    chosen: cursor (rank 0)  reason: top-1 by score
  OpenCode selected by:
    selector: direct='opencode'
    candidates: [opencode]
    chosen: opencode  reason: direct
</decisiontree>

<violations>
  (empty)
</violations>
```

### JSON export contract

```ts
// JSON schema mirror in contracts/audit/report.schema.json
{
  "rootTaskId": "T-001",
  "timeline": [ { "ts","kind","actor","data" } ],
  "tree": { "taskId","agentId","children":[...] },
  "budgetFlow": {
    "rootGrant": { "tokens": 60000 },
    "edges": [
      { "from": "T-001", "to": "T-002", "reserved":{"tokens":60000}, "spent":{"tokens":40000}, "refunded":{"tokens":7000} }
    ]
  },
  "violations": [
    { "type":"pact.rejected", "code":"PACT_FORBIDDEN_OP", "rule":"...", "frame":"...", "at":"..." }
  ],
  "decisionTree": { /* … */ }
}
```

### Programmatic audit (CI)

```ts
import { boot } from '@fangai/body';
import { AuditTool } from '@fangai/body/audit';

const body = await boot(cfg);
// ... run task tree T-001 ...
const audit = new AuditTool(body.ledger, body.pactStore);
const report = await audit.replay('T-001');
expect(report.violations).toHaveLength(0);
expect(report.budgetFlow.edges).toMatchObject([
  { from: 'T-001', to: 'T-002', reserved: { tokens: 60000 }, spent: { tokens: 40000 } }
]);
```

### Audit's own integrity

Audit reads from ledger; ledger is append-only. Audit cannot mutate ledger. Audit reports embed a `coverageHash` over the lines they read; a downstream verifier can re-hash and confirm no tampering between report generation and consumption.

```ts
interface AuditReport {
  ...
  coverageHash: string;       // sha256 of canonicalized read window
  ledgerFiles: Array<{ path: string; sha256: string; rangeStart: number; rangeEnd: number }>;
}
```

A second tool, `fang audit verify`, takes a report + the present ledger and validates that everything still hashes the same.

---

## 28.6 Security Error Codes & Pulses (Additions)

```ts
export type SecurityErrorCode =
  | 'BOOT_NO_PACT' | 'BOOT_INSECURE_HTTP'
  | 'MUSCLE_IDENTITY_REJECTED' | 'MUSCLE_IDENTITY_UNKNOWN'
  | 'INK_AGENT_SPOOFED' | 'INK_LINEAGE_FORGED'
  | 'INK_REPLAY_STALE' | 'INK_HMAC_INVALID'
  | 'AUDIT_COVERAGE_MISMATCH';

// PulseKind additions
| 'muscle.bound' | 'muscle.identity-rejected'
| 'ink.replay-blocked' | 'ink.hmac-mismatch'
| 'pact.key.rotating' | 'pact.bundle.updated' | 'pact.bundle.invalid'
| 'audit.replay-built' | 'audit.coverage-mismatch';
```

---

## 28.7 Test Suite (Adversarial)

`packages/body/src/__tests__/security/`:

| File | Adversary | Expected |
|------|-----------|----------|
| `bootstrap-empty.test.ts` | boot with no PACT, `allowEmpty: false` | `BOOT_NO_PACT` |
| `bootstrap-init.test.ts` | `fang init` end-to-end (with mock founder oracle) | valid chain end-to-end |
| `impersonation-spoof.test.ts` | inject frame with forged lineage[last].agentId | `INK_AGENT_SPOOFED` |
| `lineage-forge.test.ts` | tamper with middle hop's mac | `INK_LINEAGE_FORGED` |
| `replay-dup.test.ts` | resend a valid frame within window | `INK_DUP_CORRELATION` |
| `replay-stale.test.ts` | replay 11 minutes later (window=10m) | `INK_REPLAY_STALE` |
| `hmac-tamper.test.ts` | flip one byte of payload between sign and dispatch | `INK_HMAC_INVALID` |
| `http-bind-public.test.ts` | configure `host: 0.0.0.0` without TLS | `BOOT_INSECURE_HTTP` |
| `redaction.test.ts` | session contains `AKIA…`; SIPHON writes memory | redaction placeholder; no original |
| `audit-tamper.test.ts` | mutate ledger after report; `fang audit verify` | `AUDIT_COVERAGE_MISMATCH` |

Run as part of the `e2e.yml` security tier. Failure of any test blocks release.

🐙
