# Testing and contracts

## Principles

1. **Adapters are parsers** — most bugs are **wrong parsing**, not HTTP. Invest in **fixtures**.
2. **SDK boundary** — integration tests that hit **real** `DefaultRequestHandler` + in-memory store catch taskId / lifecycle mistakes (see Venom’s ResultManager debugging).
3. **No network in unit tests** — mock `child_process`; use recorded stdout files.

---

## Vitest import paths (monorepo)

Tests under `packages/*/src/__tests__/` must import siblings from **`../index.js`**, not `../src/index.js` (the latter resolves to a non-existent `src/src/`).

## Fixture strategy

| Level | What | Where |
|-------|------|--------|
| **Golden lines** | One JSONL line per agent event type | `packages/*/tests/fixtures/*.txt` |
| **Session snippets** | 10–50 line excerpts from real runs (redact secrets) | Same |
| **Sync RPC** | Minimal `message/send` body + expected Message shape | Core integration tests |

**Rule:** Every new adapter **must** ship at least **3** fixture lines before “done.”

---

## Contract tests (HTTP)

- `GET /.well-known/agent-card.json` — 200, JSON parse, required fields per SDK version.
- `POST /a2a` — JSON-RPC 2.0 body (e.g. `message/send`); Fang mounts the SDK handler here, not a separate `/a2a/jsonrpc` path.
- **Health** — stable JSON for load balancers.

**Automated (no mocks):** `packages/core/src/__tests__/fangHttp.contract.test.ts` starts **`FangServer`** on **`127.0.0.1:0`**, then uses **`fetch`** for **`/health`**, agent card, JSON-RPC **`fang/unknownMethod`** (error), and **`tasks/get`** (missing task → error). Keeps coverage stable without relying on **`message/send`** + fast CLI timing quirks in **`@a2a-js/sdk`**’s `ResultManager`. A second suite sets **`FangConfig.apiKey`** and asserts **`/health`** + public agent card, **`401`** on **`/a2a`** without credentials, and authenticated JSON-RPC via **`X-Api-Key`** or **`Authorization: Bearer`**.

**CLI smoke:** `packages/cli/src/__tests__/cli.smoke.test.ts` runs **`node dist/index.js --help`** and **`--version`** (requires **`pnpm build`** in **`@fangai/cli`** first; root **`pnpm test`** builds the workspace before tests). **`packages/cli/vitest.config.ts`** uses a single fork pool so **`pnpm --filter @fangai/cli test`** exits cleanly when run alone.

**CI (monorepo root):** `pnpm install --frozen-lockfile` then **`pnpm run release:verify`** (build, test, `@fangai/core` lint); Node **20** and **22** matrix — see `.github/workflows/ci.yml`.

---

## Optional: real OpenCode `serve` + SDK (local)

`packages/core/src/__tests__/opencode.serve.integration.test.ts` starts **`opencode serve`** briefly, then checks **`GET /session`** matches **`@opencode-ai/sdk` `session.list()`**. Off by default; enable when the OpenCode CLI is on `PATH`:

```bash
# Windows (PowerShell)
$env:RUN_OPENCODE_INTEGRATION=1; pnpm --filter @fangai/core exec vitest run src/__tests__/opencode.serve.integration.test.ts

# Unix
RUN_OPENCODE_INTEGRATION=1 pnpm --filter @fangai/core exec vitest run src/__tests__/opencode.serve.integration.test.ts
```

Uses `OPENCODE_SERVER_PASSWORD` for Basic auth (set in-test). Does **not** call a model.

---

## What not to test in CI (initially)

- Live calls to **paid APIs** or **networked CLIs** — run manually or nightly **optional** job with secrets.

---

## Regression watchlist (from three prototypes)

| Risk | Test idea |
|------|-----------|
| **Manual `\n` split** breaks JSON | Parser tests with embedded newlines in strings |
| **Persistent** task mix-up | Two sequential tasks, assert isolation |
| **Silent generic adapter** | Config test: missing adapter → warning/error |
