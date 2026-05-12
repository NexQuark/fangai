# Release checklist (pre-1.0)

Use before tagging **`@fangai/*`** or publishing the **`fang`** CLI. Adjust for your CI/CD.

**Scope:** Does **not** require ACP adapters (Gemini/Goose), extra REST beyond `@a2a-js/sdk`, or parity with every v2 adapter — see **`05-ROADMAP-PHASES.md`** Phase 6 deferrals.

---

## 1. Repo health

- [ ] `pnpm install` (clean tree or CI cache)
- [ ] **`pnpm run release:verify`** (root) — same bar as **GitHub Actions** (`build` + `test` + `@fangai/core` lint), or run those steps individually
- [ ] `pnpm -r build` — all packages compile
- [ ] `pnpm -r test` — unit tests green
- [ ] `pnpm --filter @fangai/core lint` — ESLint flat config in `packages/core/eslint.config.js`

---

## 2. Optional local integration

- [ ] **OpenCode serve + SDK** (requires `opencode` on `PATH`):  
  `RUN_OPENCODE_INTEGRATION=1` — see [12-TESTING-AND-CONTRACTS.md](./12-TESTING-AND-CONTRACTS.md#optional-real-opencode-serve--sdk-local)

---

## 3. Smoke (manual)

- [ ] `fang wrap "pi --mode rpc" --port 3001` (or another adapter) — server starts, logs URL
- [ ] `GET http://localhost:3001/health` — `bridge: "fang"`
- [ ] `GET /.well-known/agent-card.json` — 200, valid JSON
- [ ] `fang send --port 3001 "ping"` — or with `--api-key` if `FANG_API_KEY` set
- [ ] `fang discover` — lists the agent; note **auth** line if API key enabled
- [ ] `fang stop` — stops Fang on that port (after health check)
- [ ] (Optional) `fang wrap "…" --port 3001 --host 127.0.0.1` — confirm `GET http://127.0.0.1:3001/health` only from local machine

---

## 4. Publish hygiene

- [ ] Version bump aligned across workspace packages (see [11-DISTRIBUTION-AND-PUBLISHING.md](./11-DISTRIBUTION-AND-PUBLISHING.md))
- [ ] Update [`../CHANGELOG.md`](../CHANGELOG.md) — fold **`[Unreleased]`** into a new **`## [x.y.z] — YYYY-MM-DD`** section (or add bullets under the version you are shipping); keep **`[Unreleased]`** as empty placeholders for the next cycle
- [ ] GitHub release notes — **Spec alignment** bullets for `@a2a-js/sdk` (can mirror changelog)
- [ ] npm provenance / trusted publishing when wired (optional)

---

## 5. Security snapshot

- [ ] No secrets in logs for the smoke run
- [ ] If exposing beyond localhost: **API key** (`FANG_API_KEY` / `--api-key`) documented for operators ([14-SECURITY-AND-TRUST-BOUNDARIES.md](./14-SECURITY-AND-TRUST-BOUNDARIES.md))
