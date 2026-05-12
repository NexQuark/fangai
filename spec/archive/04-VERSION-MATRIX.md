# Version matrix — relay table

Use this when deciding **where to port code from** and **what the blueprint must say**.

| Dimension | v1 `a2a-cli-01` | v2 `fang` | v3 `a2a-cli` | **Target (production)** |
|-----------|------------------|-----------|--------------|---------------------------|
| **Role** | Single-file POC | Blueprint monorepo | Shippable monorepo | **v3 + selected v1/v2 parts** |
| **Server** | Express + SDK | Hono, hand-rolled A2A | Express + SDK | **Express + SDK** |
| **A2A compliance** | Via SDK | Custom (drift risk) | Via SDK | **SDK** |
| **Persistent CLI** | Yes (Pi RPC) | No | No | **Yes (from v1)** |
| **Process I/O** | Manual split + RPC path | **ProcessManager** + readline | Manual split | **ProcessManager-style (from v2)** |
| **Detection** | Regex on CLI string | **Detector** (`which` + version) | **AdapterRegistry** (lazy import) | **Detector + registry** with explicit failures |
| **Adapter API** | Inline classes | **AgentAdapter**, `AdapterEvent[]` | **BaseAdapter**, `TaskUpdate` | **Evolve toward multi-event** |
| **Adapters present** | Pi, Claude, Aider, Generic | Pi, Claude, Codex, Gemini, Aider | Pi, Claude, Codex, Aider, OpenCode, Generic | **v3 + Codex**; **Gemini/ACP deferred** (post-1.0) per `05` Phase 6 |
| **REST** | SDK | Partial / custom | SDK | **SDK** |
| **Tests** | None | Some | Several | **Expand** |
| **Docs** | README | Epic README | ARCHITECTURE, ADAPTERS, A2A… | **Keep v3 docs**, lift v2 narrative where accurate |
| **Dead code** | Minimal | Unknown | TaskManager, SSEEmitter, … per COMPARISON | **Delete or quarantine** |
| **Client story** | curl | curl | curl | **SDK client or @fangai/client** |

---

## Blueprint vs matrix (explicit deltas)

| Blueprint claim | Adjustment |
|-------------------|------------|
| Hono + `streamSSE` | Replace with **Express + SDK** for the server |
| Aider text-only | **False** for Fang — use **`--json`** where supported |
| No client anywhere | **False** — SDK has client; product may lack **wrapper** |
| v0.1 = Claude → Gemini → Aider text | Engineering order: **persistent + process layer** → then adapter depth |

---

## Capability snapshot (agents) — *fill from research*

| Agent | In v3 adapter? | Persistent in Fang? | Notes |
|-------|----------------|-------------------|-------|
| Pi | Yes (`packages/pi`) | **Yes in Fang** (`persistent`) | Upstream: [pi-mono](https://github.com/badlogic/pi-mono) RPC — stdin `prompt` / stdout JSONL; see **15-UPSTREAM** |
| Claude Code | Yes | Oneshot typical | stream-json |
| Aider | Yes (`--json`) | Oneshot | Update tier docs |
| OpenCode | Yes | Oneshot / TBD | Upstream: [opencode](https://github.com/anomalyco/opencode) — `run --format json` vs `serve`; see **15-UPSTREAM** |
| Codex | Yes (`packages/adapters/codex`, `--json`) | Oneshot | Ported from v2 shapes; stdin prompt — verify your `codex` build |
| Gemini | v2 only | **Deferred** | ACP bridge — **not** on the path to 1.0 unless reprioritized |

---

## One-line verdicts

- **v1:** Ship the **persistent** executor brain into v3.
- **v2:** Ship **ProcessManager** + **Detector** + adapter richness; **not** the HTTP server.
- **v3:** Default **root** for production; clean legacy; add persistent path.
