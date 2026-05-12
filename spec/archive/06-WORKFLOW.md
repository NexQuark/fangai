# Workflow — from idea to release

## Roles (can be one person)

| Role | Responsibility |
|------|----------------|
| **Spec owner** | Keeps `spec/` consistent with merged code |
| **Bridge owner** | Executor, process lifecycle, SDK integration |
| **Adapter owner** | Per-agent parsers + fixtures |
| **Ops owner** | Docker, systemd, CI |

---

## 1. Intake

- New requirement → add to `RISKS-AND-OPEN-QUESTIONS.md` or create `spec/adr/NNN-title.md` if it changes architecture.
- Never expand scope without updating **05-ROADMAP-PHASES.md**.

## 2. Design

- Read **03-ARCHITECTURE-TARGET.md** first.
- If touching protocol: skim **A2A-COMPLIANCE** in repo + SDK release notes.

## 3. Implementation order

1. Core executor / server behavior  
2. Tests + fixtures  
3. CLI UX  
4. Docs (same PR when user-visible)

## 4. Definition of Done

- [ ] Tests pass locally and in CI  
- [ ] **02-SOURCE-OF-TRUTH** updated if public claims change  
- [ ] Adapter matrix row updated in **04** if agent support changes  
- [ ] No new silent fallback paths without logging  

## 5. Release

- Version bump per semver  
- Changelog: **Features / Fixes / Spec alignment**  
- Tag Git; publish `@fangai/*` per package.

## 6. Research spikes

Follow **00-RESEARCH-PROGRAM.md**: every spike produces a row update, ADR, or fixture.

---

## Daily developer loop (suggested)

Canonical workspace: **[repository root](https://github.com/kariemSeiam/fangai)** in **[`kariemSeiam/fangai`](https://github.com/kariemSeiam/fangai)**.

```text
git pull
pnpm install
pnpm test
```

Root `pnpm test` runs **`pnpm -r build` then `pnpm -r test`** so `@fangai/core` `dist/` exists before adapter packages resolve it. For a faster loop when core is already built: `pnpm test:only` (from repo root `fang/package.json`).

```text
# edit
pnpm test:only
```

For cross-package work, run tests from repo root; for single adapter, `pnpm --filter @fangai/adapter-<name> test`.
