# 08 — Conformance Suite

**Status:** Active · **Date:** 2026-05-12

---

## Purpose

Ensure adapters survive upstream CLI changes. Every adapter change must pass all fixtures for its upstream version.

## Fixture Types

| Type | Purpose | Count (min) |
|------|---------|-------------|
| `happy-path` | Normal code-edit task | 5 |
| `error` | CLI auth failure, syntax error | 3 |
| `cancellation` | Mid-task SIGTERM | 2 |
| `timeout` | CLI hangs, adapter kills | 2 |
| `ansi-strip` | CLI output with escape codes | 3 |
| `partial-output` | CLI crashes mid-stream | 2 |
| `interactive` | CLI prompts (auto-answered) | 2 |

Total minimum fixtures per adapter: **19**

## Running Conformance

```bash
# Run all fixtures for one adapter
pnpm --filter @fangai/adapter-claude test:conformance

# Run against a specific upstream version
UPSTREAM_VERSION=1.2.3 pnpm --filter @fangai/adapter-claude test:conformance

# Generate new fixture from live CLI
pnpm --filter @fangai/adapter-claude fixture:capture --name "happy-01" --prompt "Add a function"
```

## CI Integration

```yaml
# .github/workflows/conformance.yml
on:
  push:
    paths: ['packages/adapters/**']
  schedule:
    - cron: '0 6 * * 1'  # Weekly upstream drift check

jobs:
  conformance:
    strategy:
      matrix:
        adapter: [claude, cursor, opencode, pi]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @fangai/adapter-${{ matrix.adapter }} test:conformance
```

## Golden Transcript Format

Each fixture produces a golden transcript:
```json
{
  "adapter": "claude",
  "upstreamVersion": "1.2.3",
  "fixture": "happy-01",
  "input": "Add a rate limit to the auth endpoint",
  "expectedEvents": [...],
  "expectedOutput": {"text": "...", "artifacts": [...]},
  "maxDurationMs": 60000,
  "maxTokens": 5000
}
```

## Drift Detection

Weekly cron job:
1. Check upstream CLI version (npm latest / git HEAD)
2. Run all fixtures against new version
3. If any fail → open GitHub issue with drift report
4. If all pass → update `knownGood` in `versions.json`
