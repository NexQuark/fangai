# Fang — production specification

This folder is the **single place** for vision, corrected assumptions, architecture targets, research obligations, and delivery workflow. It is meant to stay ahead of marketing copy and playground prototypes.

**Start here**

| Document | Purpose |
|----------|---------|
| [00-RESEARCH-PROGRAM.md](./00-RESEARCH-PROGRAM.md) | What to verify externally, how often, and exit criteria |
| [01-VISION-AND-SCOPE.md](./01-VISION-AND-SCOPE.md) | What Fang is, is not, and who it serves |
| [02-SOURCE-OF-TRUTH.md](./02-SOURCE-OF-TRUTH.md) | Corrections to the public blueprint vs repos and SDK facts |
| [03-ARCHITECTURE-TARGET.md](./03-ARCHITECTURE-TARGET.md) | Merge strategy across v1/v2/v3 and non-negotiables |
| [04-VERSION-MATRIX.md](./04-VERSION-MATRIX.md) | Relay table: three codebases + blueprint alignment |
| [05-ROADMAP-PHASES.md](./05-ROADMAP-PHASES.md) | Phased roadmap to a shippable “production one” |
| [06-WORKFLOW.md](./06-WORKFLOW.md) | How to run design → spec → implementation → release |
| [07-PRIORITY-RECONCILIATION.md](./07-PRIORITY-RECONCILIATION.md) | Spec vs field research priorities — dual-track strategy |
| [08-ECOSYSTEM-MAP.md](./08-ECOSYSTEM-MAP.md) | Competitors, complements, gateways, hosts (incl. WSL) |
| [09-GLOSSARY-AND-PROTOCOLS.md](./09-GLOSSARY-AND-PROTOCOLS.md) | A2A / MCP / ACP mental model + adapter families |
| [10-RESEARCH-BACKLOG.md](./10-RESEARCH-BACKLOG.md) | P0/P1/P2 questions with “done” artifacts |
| [11-DISTRIBUTION-AND-PUBLISHING.md](./11-DISTRIBUTION-AND-PUBLISHING.md) | npm, GitHub, Docker, semver, publish checklist |
| [12-TESTING-AND-CONTRACTS.md](./12-TESTING-AND-CONTRACTS.md) | Fixtures, SDK integration tests, CI matrix |
| [13-NAMING-AND-DISCOVERY.md](./13-NAMING-AND-DISCOVERY.md) | Fang brand vs SEO keywords, confusion guards |
| [14-SECURITY-AND-TRUST-BOUNDARIES.md](./14-SECURITY-AND-TRUST-BOUNDARIES.md) | Threat model, what Fang does not promise |
| [15-UPSTREAM-PI-AND-OPencode.md](./15-UPSTREAM-PI-AND-OPencode.md) | Source-of-truth links: [pi-mono](https://github.com/badlogic/pi-mono), [OpenCode](https://github.com/anomalyco/opencode), paths + Fang alignment |
| [16-RELEASE-CHECKLIST.md](./16-RELEASE-CHECKLIST.md) | Pre-publish build, tests, smoke, and security snapshot |
| [17-INK-WIRE.md](./17-INK-WIRE.md) | 🆕 INK dispatch language — full wire protocol, selectors, budget, recursion |
| [18-PACT.md](./18-PACT.md) | 🆕 Body constitution — YAML schema, signature chain, enforcement rules |
| [19-BODY-BOOT.md](./19-BODY-BOOT.md) | 🆕 Body.boot() — 11-phase boot sequence, config, health, hot reload |
| [20-PHASE-0-PLAN.md](./20-PHASE-0-PLAN.md) | 🆕 Phase 0 migration — day-by-day plan, 5 days, 5 commits |
| [21-TESTING.md](./21-TESTING.md) | 🆕 Testing strategy — unit, integration, contract, E2E, CI pipeline |
| [22-CLAW.md](./22-CLAW.md) | 🆕 Claw adapter — system ops muscle, whitelist, 3-layer defense |
| [23-DATA-STRUCTURES.md](./23-DATA-STRUCTURES.md) | 🆕 Complete cross-organ types — Frame, Blood, Memory, INK, Pulse, Errors |
| [24-EDGE-CASES.md](./24-EDGE-CASES.md) | 🆕 Seam 1 — orphan cascade, partial-refund flow, PACT reload race, dispatch reservation race |
| [25-FAILURE-MODES.md](./25-FAILURE-MODES.md) | 🆕 Seam 2 — circuit breaker, disk-full degradation, key rotation, memory corruption, sense death |
| [26-RECOVERY-PATTERNS.md](./26-RECOVERY-PATTERNS.md) | 🆕 Seam 3 — checkpoint replay, resume after `body.die`, orphan GC + harvest |
| [27-SIPHON-GENERALIZED.md](./27-SIPHON-GENERALIZED.md) | 🆕 Seam 4 — unified extraction across Pi/Cursor/Claude/OpenCode/A2A, merge conflict policy, non-Cursor recap injection |
| [28-SECURITY-MODEL.md](./28-SECURITY-MODEL.md) | 🆕 Seam 5 — trust bootstrap, identity binding, frame replay defense, side-channel surface, audit replay |
| [adr/README.md](./adr/README.md) | Optional ADR template for irreversible choices |
| [RISKS-AND-OPEN-QUESTIONS.md](./RISKS-AND-OPEN-QUESTIONS.md) | Decisions pending and failure modes |

**Research bibliography (fill over time)**

- [research/SOURCES-TEMPLATE.md](./research/SOURCES-TEMPLATE.md) — primary URLs for benchmarks, spec, competitors

**Canonical implementation root (Fang monorepo)**

- [`../README.md`](../README.md) — **active** `pnpm` workspace; develop **here**; `playgorund/` remains reference snapshots
- [`../docs/FANG-SPEC.md`](../docs/FANG-SPEC.md) — **implementation draft** (routes, `FangAgentExecutor`, adapters); keep in sync with code in the same PRs that change behavior
- [`../docs/PUBLISHING.md`](../docs/PUBLISHING.md) — **`@fangai/*`** npm checklist, package table, `pnpm publish -r` (pairs with [11](./11-DISTRIBUTION-AND-PUBLISHING.md))
- [`../packages/client`](../packages/client) — **`@fangai/client`** orchestrator-facing API (`FangClient`, `discoverRunningAgents`)

**Related repo artifacts**

- `playgorund/COMPARISON.md` — detailed three-way code comparison (keep in sync when architecture target changes); links back to this spec
- `playgorund/a2a-cli` — historical snapshot; **shipping source** is the monorepo at [`../README.md`](../README.md)
- `playgorund/a2a-cli-01` — reference for **persistent** Pi RPC bridging
- `playgorund/fang` — reference for **ProcessManager**, **Detector**, rich adapter interfaces (Hono server is **not** the target)
- `playgorund/pi-mono`, `playgorund/opencode` — optional **shallow clones** for reading upstream RPC / CLI (see [15-UPSTREAM-PI-AND-OPencode.md](./15-UPSTREAM-PI-AND-OPencode.md))

---

## Naming

- **Brand:** Fang  
- **Packages:** `@fangai/*` (scoped npm), CLI binary may remain `fang` via `package.json` `bin`

---

## Document control

When you change behavior in code, update **02** or **03** first or in the same PR. Spec drift is a bug.
