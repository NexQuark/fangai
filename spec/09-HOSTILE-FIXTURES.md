# 09 — Hostile Fixtures (Seams, Failures, Recovery)

**Status:** Active · **Date:** 2026-05-12

> Executable test cases for hostile shapes. Converted from SPEC-24 through SPEC-28 prose into runnable fixtures.

---

## Fixture Categories

### 1. Orphan Cascade (SPEC-24.1)

**Scenario:** Parent task completes before child finishes.
```json
{
  "name": "orphan-cascade-01",
  "setup": "Submit parent task, then child task with parentId",
  "action": "Complete parent while child is running",
  "expected": "Child marked orphaned, budget refunded, pulse emitted"
}
```

### 2. Partial Refund (SPEC-24.2)

**Scenario:** Task consumes partial budget before failure.
```json
{
  "name": "partial-refund-01",
  "setup": "Submit task with budget: {tokens: 1000}",
  "action": "Task fails after consuming 400 tokens",
  "expected": "600 tokens refunded to parent, spentBudget: {tokens: 400}"
}
```

### 3. Disk Full (SPEC-25.2)

**Scenario:** Ledger disk fills mid-task.
```json
{
  "name": "disk-full-01",
  "setup": "Fill disk to 99%, submit task",
  "action": "Task runs, ledger write fails",
  "expected": "Task completes, ledger marked degraded, pulse: 'ledger.full'"
}
```

### 4. Circuit Breaker (SPEC-25.1)

**Scenario:** Adapter fails 5 times in a row.
```json
{
  "name": "circuit-breaker-01",
  "setup": "Submit 5 tasks that trigger adapter failure",
  "action": "Submit 6th task",
  "expected": "6th task rejected with 'circuit open', pulse: 'muscle.tripped'"
}
```

### 5. Cold Resume (SPEC-26.1)

**Scenario:** Server crashes, restarts, resumes from ledger.
```json
{
  "name": "cold-resume-01",
  "setup": "Submit task, crash server mid-task",
  "action": "Restart server, query task status",
  "expected": "Task marked failed (TASK_INTERRUPTED), ledger intact, replay possible"
}
```

### 6. ANSI Injection (Adapter)

**Scenario:** CLI output contains ANSI escape codes.
```json
{
  "name": "ansi-strip-01",
  "setup": "CLI outputs \\x1b[32mSuccess\\x1b[0m",
  "action": "Adapter parses output",
  "expected": "ANSI stripped, text: 'Success', no parse error"
}
```

### 7. Auth Failure (Adapter)

**Scenario:** CLI auth token expired.
```json
{
  "name": "auth-failure-01",
  "setup": "Remove ANTHROPIC_API_KEY, submit task",
  "action": "CLI returns 'Not logged in'",
  "expected": "Task failed with CLI_RUNTIME_ERROR, structured error message"
}
```

## Running Hostile Fixtures

```bash
# Run all hostile fixtures
pnpm test:hostile

# Run specific category
pnpm test:hostile --category "orphan-cascade"

# Run against specific adapter
pnpm test:hostile --adapter claude
```

## Pulse Verification

Each hostile fixture must emit specific pulses. Verification:
1. Fixture runner captures all pulses during test
2. Compares against expected pulse sequence
3. Fails if any expected pulse is missing or unexpected pulse appears
