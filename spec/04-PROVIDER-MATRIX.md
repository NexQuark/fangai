# 04 — Provider Matrix

**Status:** Active · **Date:** 2026-05-12

---

## Claude Code

- **Binary:** `claude`
- **Protocol:** stream-json (JSONL on stdout)
- **Auth:** `ANTHROPIC_API_KEY` env var or OAuth (`claude auth login`)
- **Headless:** `ANTHROPIC_API_KEY` required (OAuth needs browser)
- **Known drifts:**
  - Event format changes on minor releases
  - ANSI escape codes in output (spinners, colors)
  - Interactive `/login` prompt (inquirer TUI — not pipeable)
- **Fixture count:** 15+ (covering auth, code-edit, error, cancellation)

## Cursor Agent

- **Binary:** `cursor-agent`
- **Protocol:** native JSONL (`system`/`assistant`/`tool_call`/`result` events)
- **Auth:** `CURSOR_API_KEY` env var or OAuth (`agent login`)
- **Headless:** `--api-key $CURSOR_API_KEY --print --trust` required
- **Models:** `composer-2`, `composer-2-fast` (CLI); `gpt-5.3-codex` (REST only)
- **Known drifts:**
  - JSONL event shape varies by model
  - `--continue` flag for multi-turn
  - Session TTL + cold recap (commit `51675e9`)
- **Fixture count:** 15+

## OpenCode

- **Binary:** `opencode`
- **Protocol:** `--format json` (nested: `obj.part.text`)
- **Auth:** `~/.local/share/opencode/auth.json` or env var
- **Model:** `zai/glm-5-turbo` (via Z.AI provider)
- **Known drifts:**
  - `-f` means `--file` NOT `--format` (adapter bug, fixed)
  - Completion signal: `step_finish` (not `done`/`complete`)
  - Oneshot mode may hang via Fang stdin pipe
- **Fixture count:** 10+

## Pi

- **Binary:** `pi`
- **Protocol:** `--mode rpc` (JSONL, ~30 event types)
- **Auth:** Z.AI API key (via `opencode.json` or env)
- **Mode:** Persistent (long-lived process, multiplex tasks)
- **Known drifts:**
  - Event types evolve frequently (upstream: `github.com/badlogic/pi-mono`)
  - Extension loading on startup (30s warm-up)
  - `rpc-types.ts` defines protocol — track upstream
- **Fixture count:** 30+ (one per event type)

## Version Pinning

Each provider has a `versions.json`:
```json
{
  "provider": "claude-code",
  "knownGood": ["1.0.0", "1.1.0", "1.2.0"],
  "knownBad": ["0.9.0"],
  "lastVerified": "2026-05-12",
  "upstreamRepo": "github.com/anthropics/claude-code"
}
```

CI checks fixture compatibility on every upstream version change.
