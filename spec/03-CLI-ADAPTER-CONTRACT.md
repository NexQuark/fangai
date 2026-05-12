# 03 — CLI Adapter Contract

**Status:** Active · **Date:** 2026-05-12

---

## Adapter Interface

```typescript
interface CliAdapter {
  /** Human-readable name */
  readonly name: string;
  /** CLI binary name (for detection) */
  readonly binary: string;
  /** Build CLI argv for a task */
  buildArgs(task: Task, config: AdapterConfig): string[];
  /** Parse one line of CLI output into zero or more events */
  parseLine(line: string): AdapterEvent[];
  /** Detect completion signal in parsed events */
  isComplete(events: AdapterEvent[]): boolean;
  /** Extract final output from completed events */
  extractOutput(events: AdapterEvent[]): TaskOutput;
}

interface AdapterEvent {
  type: 'output' | 'error' | 'complete' | 'progress';
  data: string | Record<string, unknown>;
  ts?: number;  // milliseconds since epoch
}

interface AdapterConfig {
  workdir: string;
  timeoutMs: number;
  env?: Record<string, string>;
}
```

## Lifecycle

1. **Spawn:** `child_process.spawn(binary, buildArgs(task, config), { stdio: ['pipe', 'pipe', 'pipe'] })`
2. **Inject:** write task prompt to stdin (if supported)
3. **Read:** readline on stdout, feed each line to `parseLine()`
4. **Emit:** map `AdapterEvent[]` to SDK event bus
5. **Complete:** `isComplete()` returns true → `extractOutput()` → finalize task
6. **Cleanup:** SIGTERM → wait 5s → SIGKILL if needed

## Conformance Requirements

- Adapter MUST pass all fixtures for its upstream version
- Adapter MUST handle ANSI escape codes (strip before parsing)
- Adapter MUST handle interactive prompts (auto-answer or skip)
- Adapter MUST handle CLI auth failures (return structured error, not exit code 1)
- Adapter MUST handle hung processes (timeout + SIGKILL)
- Adapter MUST handle partial output (return what was produced before failure)

## Fixture Format

Each fixture is a JSON file containing:
```json
{
  "upstreamVersion": "1.2.3",
  "upstreamCommit": "abc123",
  "capturedAt": "2026-05-12T...",
  "input": "Edit the auth module to add rate limiting",
  "outputLines": ["line 1", "line 2", "...", "line N"],
  "expectedEvents": [
    {"type": "output", "text": "..."},
    {"type": "complete", "output": "..."}
  ],
  "notes": "Captured on Ubuntu 22.04, Node 24"
}
```

Fixtures live in `packages/adapters/<name>/fixtures/`. CI runs fixtures on every adapter change.

## Upstream Version Probing

On adapter init:
1. Run `<binary> --version`
2. Compare against known-good version range in `packages/adapters/<name>/versions.json`
3. If version is unknown → log warning, proceed (may fail fixtures)
4. If version is known-bad → refuse to start, emit error

## Error Mapping

| CLI Exit Code | Adapter Error Code | Meaning |
|---------------|-------------------|---------|
| 0 | - | Success |
| 1 | `CLI_RUNTIME_ERROR` | CLI crashed or auth failed |
| 124 | `CLI_TIMEOUT` | Adapter timeout exceeded |
| 137 | `CLI_KILLED` | SIGKILL received (hung process) |
| 130 | `CLI_CANCELLED` | SIGINT received (user cancelled) |
| other | `CLI_UNKNOWN_ERROR` | Unclassified failure |
