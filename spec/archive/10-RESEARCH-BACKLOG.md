# Research backlog — concrete questions

Each item should eventually become: **answer + source link + date + spec/code update**.

**Priority:** P0 = blocks accurate marketing or correctness; P1 = roadmap; P2 = nice.

---

## P0 — Correctness and trust

| ID | Question | Artifact when done |
|----|----------|-------------------|
| R-P0-01 | Exact **`@a2a-js/sdk`** semver pin and breaking changes in last 12 months | `package.json` policy + CHANGELOG note |
| R-P0-02 | **Agent Card** canonical path(s) supported by our server + SDK version | Row in ADAPTERS/A2A doc + integration test |
| R-P0-03 | **message/send** vs streaming: what must `AgentExecutor` publish for sync responses? (Venom’s taskId / ResultManager lesson) | Doc snippet + test |
| R-P0-04 | **Aider**: minimum version for `--json` / `--json-output`; flag name drift | Adapter README + version check in adapter |

---

## P1 — Adapters and breadth

| ID | Question | Artifact when done |
|----|----------|-------------------|
| R-P1-01 | **Pi RPC**: full command vocabulary we implement (`prompt`, `abort`, …) vs pass-through | Capability card + tests |
| R-P1-02 | **Claude Code**: minimum flags for reliable `stream-json` across OS | Example invocations in docs |
| R-P1-03 | **ACP**: one shared module vs per-agent quirks (Gemini vs Goose vs OpenCode) | **Deferred post-1.0** — see `05` Phase 6; revisit if ACP becomes a hard requirement |
| R-P1-04 | **OpenCode**: when to use `run --format json` / process adapter vs `opencode serve` HTTP + SDK | Answered in **`spec/15-UPSTREAM-PI-AND-OPencode.md`** (`serve` + SDK for real integration; `--format json` for scripted stdout) |

---

## P1 — Competitive and positioning

| ID | Question | Artifact when done |
|----|----------|-------------------|
| R-P1-05 | **agentapi**: license, deployment model, feature parity table vs Fang | Row in `08` or README “Comparison” |
| R-P1-06 | **gemini-cli-a2a-server**: API surface overlap with Fang | Footnote in positioning |

---

## P2 — Ops and scale

| ID | Question | Artifact when done |
|----|----------|-------------------|
| R-P2-01 | Recommended **max concurrent tasks** per process model | Load note in DEPLOYMENT |
| R-P2-02 | **Memory** bounds for long-lived Pi processes | Ops runbook |

---

## P2 — Token / cost claims

| ID | Question | Artifact when done |
|----|----------|-------------------|
| R-P2-03 | Primary sources for **4–32×** figure (Scalekit etc.) | `00` source list with URLs |
| R-P2-04 | When **Smithery**-style caveat applies (MCP wins on unfamiliar APIs) | One paragraph in README “When not to use Fang” |

---

## How to burn down

1. Pick one P0 per week until clear.
2. Close with **PR that updates spec or tests** — not a chat message.
3. Move answered rows to **`spec/research/answered/`** (optional) with date.
