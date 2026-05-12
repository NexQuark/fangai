# SPEC 29 — Round 4 Reconciliation Changelog

> A precision pass over SPEC-23 through SPEC-28. Goal: **one source of truth for every cross-organ type (SPEC-23). Every other spec references it. No duplicate definitions. No drift.**

**Status:** Final · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Touches:** SPEC-23 (additive), SPEC-24, SPEC-25, SPEC-26, SPEC-27, SPEC-28 (de-dup); `spec/README.md`

---

## 29.1 Why this pass exists

While writing the five seam specs (24–28), several types were introduced **inline** in the spec where they were first needed instead of in SPEC-23. Some examples that were flagged during review:

- `LineageHop` was defined in SPEC-23.6 *without* a `mac` field. SPEC-28.2 then redefined `LineageHop` *with* a `mac` field. Two declarations, one wins, the other is invisibly stale.
- `TaskEnvelope`, `pactPin`, and `reservationIds` first appear in SPEC-24.3 — never lifted into SPEC-23.
- `MuscleIdentity`, `SignedInk` defined in SPEC-28.2/3 — but `MuscleConfig` lives in SPEC-23.4 with no link.
- `CircuitBreaker` config + state defined in SPEC-25.1 — but the selector (SPEC-17) consumes that state.
- `TaskCheckpoint`, `OrphanRecord`, `ReplayPlan`, `GcReport` defined in SPEC-26 — used by 24 (cancel cascade) and 25 (post-disk-full replay).
- `NormalizedEvent`, `Distiller`, `RecapShape`, `RecapDocument` defined in SPEC-27 — must be importable by `MuscleConfig` in SPEC-23.4 (`recap?: RecapCapability`).
- `AuditReport` and friends defined in SPEC-28.5 — but the audit shape is used as a JSON contract (`packages/body/contracts/audit/`) and must mirror against schemas exactly.

The downstream cost of letting that drift continue: two TS files declaring the same name; one team imports from `28-security.ts`, another from `27-siphon.ts`; CI passes because nothing fails locally; runtime fails when JSON Schemas differ. Tracking that down is days, not hours.

This pass closes the seam.

---

## 29.2 What was added to SPEC-23

Eight new sections, all additive — nothing in §§23.1–23.10 was removed; only §23.6's `LineageHop` was extended (added `mac`).

| New section | Promoted from | Types canonicalised |
|-------------|---------------|---------------------|
| **§23.11 Lineage chain (HMAC)** | SPEC-28.2 | `BindingSecretsTable`, `computeLineageMac`, `verifyLineageMacChain` |
| **§23.12 TaskEnvelope, PactPin, Reservations** | SPEC-24.3 + 24.4 | `PactPin`, `TaskEnvelope`, `ReserveRequest`, `Reservation`, `ReserveResult`, `FanoutReserveRequest`, `FanoutReservation` |
| **§23.13 Muscle Identity & Transport Binding** | SPEC-28.2 + 28.3 | `BindingKind`, `BindingProof`, `MuscleIdentity`, `TransportInbound`, `SignedInk` |
| **§23.14 Checkpoint, Orphan, Harvest** | SPEC-24.1 + SPEC-26.1–26.3 | `TaskCheckpointState`, `ChildCompletion`, `TaskCheckpoint`, `OrphanCause`, `OrphanRecord`, `OrphanPolicy`, `HarvestManifest`, `ReplayPlan`, `GcReport` |
| **§23.15 SIPHON: NormalizedEvent, Distiller, Recap** | SPEC-27 (entirety) | `SessionFormat`, `SessionSource`, `NormalizedEventKind`, `NormalizedEvent`, `SessionParser`, `DistillerInput`, `DistillerOutput`, `Distiller`, `RecapShape`, `RecapCapability`, `RecapRequest`, `RecapDocument`, `MemoryConflict`, `MemoryMergeReport` |
| **§23.16 CircuitBreaker & Disk-Full Policy** | SPEC-25.1 + 25.2 | `BreakerConfig`, `BreakerState`, `BreakerSnapshot`, `LedgerState`, `DiskFullPolicy`, `DiskFullError` |
| **§23.17 Audit & Security** | SPEC-28.1 + 28.5 | `FounderKey`, `OperatorKeyEntry`, `TrustBundle`, `AntiReplayConfig`, `AuditEvent`, `LineageTreeNode`, `BudgetFlow`, `BudgetFlowEdge`, `AuditViolation`, `DecisionTreeNode`, `AuditReport`, `ReplayResult`, `VerifyResult` |
| **§23.18 Health, Encryption, Misc Cross-Organ** | SPEC-25.6 + SPEC-28.4 | `HealthStatus`, `HealthReport`, `LedgerEncryptionConfig`, `RedactionMatch`, `RedactionResult` |
| **§23.19 Consolidated Error & Pulse Catalogue** | All of 24–28 | `MuscleErrorCodeExt`, `InkErrorCodeExt`, `LedgerErrorCode`, `SenseErrorCode`, `MemoryErrorCode`, `PactKeyErrorCode`, `RecoveryErrorCode`, `SecurityErrorCode`, `SiphonErrorCodeExt`, `PulseKindExt` |
| **§23.20 Reconciliation Pointer** | (this doc) | — |

### Modified existing types

- **§23.6 `LineageHop`** — added `mac: string` field. Verification chain helpers live in §23.11. Drove the canonical change resolving the SPEC-23 vs SPEC-28 divergence.

### What did NOT change

- §23.1–23.5, §23.7–23.10 are untouched. The reconciliation is purely additive at the existing-section level.
- No JSON Schema mirrors were rewritten yet (separate task: `packages/body/contracts/` will be regenerated to match §23.11–§23.18 in a follow-up PR).
- No code under `packages/` was modified — this is a spec-only pass.

---

## 29.3 What changed in SPEC-24 through SPEC-28

For each spec, the inline types were replaced with prose pointers like *"`X` is defined canonically in SPEC-23.Y"*. The **prose, examples, pulse sequences, test matrices, and YAML configs were preserved verbatim**. Only the `export interface`/`export type` blocks that duplicated SPEC-23 were removed.

### SPEC-24 — Edge Cases

| Inline declaration removed | Replaced with reference to |
|---|---|
| `interface OrphanPolicy` (§24.1) | §23.14 |
| `TaskEnvelope` shape implied by example (§24.3) | §23.12 |
| `interface Reservation` + `BudgetReservation` class shape (§24.4) | §23.12 — class implementation kept, types imported |
| `Error code additions` block (§24.6) | §23.19; codes listed inline as bullets for readability |
| Header `Depends on:` line | Now lists exact §23 sections it consumes |

### SPEC-25 — Failure Modes

| Inline declaration removed | Replaced with reference to |
|---|---|
| `interface BreakerConfig` + `type BreakerState` (§25.1) | §23.16 |
| `interface HealthReport` (§25.6) | §23.18 |
| `Failure-Mode Error Codes` block (§25.7) | §23.19; codes listed inline as bullets |

### SPEC-26 — Recovery Patterns

| Inline declaration removed | Replaced with reference to |
|---|---|
| `interface TaskCheckpoint` (§26.1) | §23.14 |
| `ReplayPlan` typed in `planReplay` signature (§26.1) | §23.14 |
| `GcReport` typed in `OrphanGc.scanAndCollect` (§26.3) | §23.14 |
| `Recovery Error Codes` block (§26.5) | §23.19; codes listed inline as bullets |

### SPEC-27 — SIPHON Generalized

| Inline declaration removed | Replaced with reference to |
|---|---|
| `interface SessionSource` (§27.2) | §23.15 |
| `type NormalizedEventKind` + `interface NormalizedEvent` (§27.2) | §23.15 |
| `interface SessionParser` (§27.2) | §23.15 |
| `interface DistillerInput`/`DistillerOutput`/`Distiller` (§27.3) | §23.15 |
| `type RecapShape` + `interface RecapCapability` (§27.5) | §23.15 |
| `interface RecapRequest`/`RecapDocument` (§27.5) | §23.15 |
| `SIPHON Error Codes` block (§27.7) | §23.19; codes listed inline as bullets |

### SPEC-28 — Security Model

| Inline declaration removed | Replaced with reference to |
|---|---|
| `interface MuscleIdentity` (§28.2) | §23.13 |
| Inline `LineageHop` redefinition with `mac` field (§28.2) | §23.6 (canonical) + §23.11 (chain helpers) |
| `verifyLineageMacChain` body (§28.2) | §23.11 (signature canonical, body stays as illustrative example removed) |
| `interface SignedInk` (§28.3) | §23.13 |
| `interface LedgerEncryptionConfig` (§28.4) | §23.18 |
| `interface AuditReport` (§28.5) | §23.17 |
| Late-spec `interface AuditReport` re-extension with `coverageHash` (§28.5) | merged into single §23.17 declaration |
| `Security Error Codes` block (§28.6) | §23.19; codes listed inline as bullets |

---

## 29.4 Conflicts resolved

| # | Conflict | Resolution |
|---|----------|-----------|
| 1 | `LineageHop` declared without `mac` in SPEC-23.6 vs with `mac` in SPEC-28.2 | **Adopted SPEC-28's shape.** §23.6 now carries `mac: string`; §23.11 holds the verification helpers. Forward-compatible: callers that don't sign yet emit `mac: ''` and verification is no-op when `BindingSecretsTable.get()` returns null (documented in §23.11 implementation note). |
| 2 | `TaskEnvelope` referenced in SPEC-24.3 (envelope with `pactPin`, `signedAt`, `reservationIds`) vs SPEC-26.1 (checkpoint also carries `pactPin`, `reservationIds`) | **Both kept; semantics distinguished.** `TaskEnvelope` (§23.12) is the live in-memory state; `TaskCheckpoint` (§23.14) is the persisted snapshot. Both carry `pactPin` and `reservationIds` because they describe the same task at different lifecycles (live vs serialized). |
| 3 | `Reservation` shape in SPEC-24.4 vs the implicit `reservationIds: string[]` in SPEC-26.1 checkpoint | **Reservation IDs are opaque strings to the checkpoint; the row lives in §23.12.** Replay uses §23.12 to rehydrate (see SPEC-26.1 step 2 of the resume sequence). |
| 4 | `RecapShape` defined as a member of `MuscleConfig` in SPEC-27.5 narrative, but `MuscleConfig` is in SPEC-23.4 | **Agreed: `MuscleConfig.recap?: RecapCapability`** is the canonical location. §23.4 will be extended in a follow-up patch (it's a one-line additive change). Noted under "Open follow-ups" below — no functional impact today because no muscle ships with a non-default recap yet. |
| 5 | `BreakerState` referenced in SPEC-25.1's `HealthReport` (`breaker?: BreakerState`) but the breaker types lived in 25.1 itself | **Both promoted to §23.16/§23.18 in same pass; no circular reference.** |
| 6 | `AuditReport` declared once in SPEC-28.5, then implicitly extended later in the same section with `coverageHash`/`ledgerFiles` | **Merged into a single §23.17 declaration.** The split-then-extend pattern was a writing artifact, not intentional design. |
| 7 | Error code unions duplicated across 24/25/26/27/28 (e.g. `LedgerErrorCode` re-declared anywhere it was thrown) | **Single source in §23.19** with `*Ext` naming for the extended unions. Each downstream spec lists its codes as bullets pointing to §23.19. |
| 8 | `OrphanPolicy.harvestMaxDurationMs` capped via PACT (§24.1) but no PACT field declared anywhere | **Documented in §23.14 prose**; the actual PACT field (`pact.rules.recovery.harvestMaxDurationMs`) is added to SPEC-18 in a follow-up (no inline change here — open follow-up #2). |

---

## 29.5 What is NOT changed

To keep this pass surgical:

- **No code edits.** This is a documentation-only reconciliation. Any TS file under `packages/body/src/types.ts` is still in its previous state; the next implementation PR will regenerate it from §23.11–§23.19.
- **JSON Schema mirrors not regenerated.** `packages/body/contracts/` still mirrors §23.1–§23.10 only. CI parity check is unchanged. Open follow-up #3 covers the regeneration.
- **No prose was rewritten in 24–28** beyond the inline-block excisions and a single one-liner in each spec's header noting the new `Depends on:` mapping. Pulse sequences, test matrices, YAML configs, and narrative are byte-for-byte unchanged.
- **README.md** got: (a) cleaner row descriptions for 23–28 with section pointers; (b) a new row for SPEC-29; (c) a new "Type drift control" subsection under Document control. Existing rows above row 23 untouched.

---

## 29.6 Verification you can run today

```bash
# 1. No exported type appears twice across the spec corpus
rg --no-line-number -e '^export (interface|type) ([A-Z][A-Za-z0-9_]*)' spec/2[3-8]-*.md \
  | awk '{print $3}' | sort | uniq -d
# expected: empty output

# 2. Every "see SPEC-23.X" reference points to a section that exists
rg -o 'SPEC-23\.[0-9]+' spec/2[4-8]-*.md spec/29-*.md | sort -u
# cross-check against §-headings in spec/23-DATA-STRUCTURES.md

# 3. Every code/pulse listed in 24-28 appears in §23.19's union
rg -o "'[A-Z_]{3,}'" spec/2[4-8]-*.md | sort -u > /tmp/downstream.txt
rg -o "'[A-Z_]{3,}'" spec/23-DATA-STRUCTURES.md | sort -u > /tmp/canonical.txt
diff /tmp/downstream.txt /tmp/canonical.txt
# expected: only narrative-only codes (e.g. fixture names) appear in downstream
```

These three commands will become a CI gate in a follow-up (open follow-up #4).

---

## 29.7 Open follow-ups (carry into Round 5)

These were touched but deliberately deferred to keep this pass scoped to "spec-level reconciliation only":

1. **Update `packages/body/src/types.ts`** to materialize §§23.11–23.19 as exported TS types. Until then, anything importing `TaskEnvelope`/`TaskCheckpoint`/`AuditReport`/etc. by name will fail to compile — current code does not yet reference them, so this is a forward-only requirement.
2. **Add `MuscleConfig.recap?: RecapCapability`** to §23.4 once an actual adapter consumes it. The type is already canonical in §23.15; the spec note in §23.4 is the one-line addition deferred.
3. **Add `pact.rules.recovery.{ harvestMaxDurationMs, resumeNonIdempotent }`** to SPEC-18's PACT YAML schema. Both fields are referenced from SPEC-24.1 and SPEC-26.1 respectively; neither has a canonical home in SPEC-18 yet.
4. **Regenerate `packages/body/contracts/*.schema.json`** to mirror §§23.11–23.18. Update `scripts/check-schema-parity.ts` to scan the extended set. Add the duplicate-export scan from §29.6 to CI.
5. **Decide whether `LedgerEncryptionConfig` belongs under §23.18 (general) or a future §23.21 (security primitives)**. Filed under §23.18 today because it's read by both SPEC-25.2 (disk-full handler) and SPEC-28.4 (at-rest threats). Reclassification has zero functional impact.
6. **Lineage `mac` rollout strategy.** Backwards-compatibility note in §23.11 says `mac: ''` + null `BindingSecretsTable.get(agentId)` is treated as "not yet enabled". The phase plan in SPEC-20 should explicitly mention when MAC enforcement turns on (Phase 1? Phase 2?). Currently silent.
7. **Audit JSON Schema** — `packages/body/contracts/audit/report.schema.json` referenced in SPEC-28.5 doesn't exist yet. Generate it from §23.17 in the contracts regeneration PR.

---

## 29.8 Summary

- **8 new SPEC-23 sections** (§§23.11–23.18) + a consolidated error/pulse catalogue (§23.19) + a pointer (§23.20).
- **1 existing type extended** (`LineageHop` gained `mac`).
- **~22 inline type declarations removed** across SPEC-24/25/26/27/28; replaced with one-line references.
- **0 prose rewrites** in 24–28; pulse sequences, YAML configs, test matrices, and CLI examples are byte-identical to pre-reconciliation.
- **0 code edits.** Spec-only.
- **7 open follow-ups** carried into Round 5 (mostly "now make the code match").

Net effect: SPEC-23 is now the only file in the spec corpus that says `export interface` or `export type` for a cross-organ name. Any future "where is type X defined?" question has exactly one answer.

🐙
