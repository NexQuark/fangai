# Distribution and publishing

## npm

| Topic | Recommendation |
|-------|----------------|
| **Scope** | `@fangai/*` — avoids collision with abandoned `fang` and generic `a2a-cli` names on npm. |
| **CLI binary** | `fang` via `"bin"` in `@fangai/cli` even if package is scoped. |
| **Unscoped alias** | Optional second package `a2a-cli` **only if** you own the name and want SEO — avoid confusion with unrelated packages. |
| **engines** | Document `node >= 20` (or 22+) consistently; call out `--experimental-strip-types` only for **dev/demo** single-file workflow, not as production requirement unless policy locked. |

## GitHub

| Topic | Recommendation |
|-------|----------------|
| **Repo name** | `fang` or `fang-ai` under your org — brand consistency. |
| **Topics** | `a2a`, `agent2agent`, `cli`, `coding-agent`, `mcp-alternative`, `llm`, `typescript`, `anthropic`, `google`, … |
| **Releases** | Tag `vX.Y.Z`; attach **SBOM** optional for enterprise later. |
| **License** | MIT (aligned with ecosystem) unless org policy differs. |

## Docker

| Topic | Recommendation |
|-------|----------------|
| **Tags** | `:latest`, `:X.Y.Z`, per-adapter images if fleet compose (already sketched in v3). |
| **Secrets** | Never bake API keys; use env + compose secrets. |
| **CLI inside image** | Document **which** upstream binaries must exist in PATH vs host-mounted. |

## Versioning policy

- **Semver** for `@fangai/*` — **major** bump if A2A surface or adapter CLI contract breaks documented behavior.
- **Lock** `@a2a-js/sdk` with caret only after tracking their changelog for one release cycle.

## Publish order (workspace)

`pnpm publish -r` resolves dependency order. If publishing manually, roughly: **`@fangai/core`** → **`@fangai/client`**, **`@fangai/pi`**, **`@fangai/adapter-*`** → **`@fangai/cli`** last (depends on **`@fangai/core`** and **`@fangai/client`**). After publish, `workspace:*` must be replaced with real semver ranges or consumers install from the registry.

## Changelog

Maintain **[`CHANGELOG.md`](../CHANGELOG.md)** in the monorepo root; copy **Spec alignment** bullets into GitHub release notes when tagging.

**Operational steps** (command sequence, package table with README links, `npm pack` notes): **[`docs/PUBLISHING.md`](../docs/PUBLISHING.md)**.

## Checklist before `npm publish`

- [ ] **`pnpm run release:verify`** green (matches CI), or equivalent `build` + `test` + **`@fangai/core` lint**
- [ ] **[`CHANGELOG.md`](../CHANGELOG.md)** updated (`[Unreleased]` → version section on tag)
- [ ] Spec alignment bullets in release notes (`00` Tier-2)
- [ ] README quickstart matches published package names
- [ ] No accidental `publishConfig` to wrong registry
