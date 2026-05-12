# Vision and scope

## One sentence

**Fang turns CLI coding agents into standards-based A2A servers** so orchestrators can delegate work without turning each full agent into a giant MCP tool schema in the caller’s context.

## What Fang is

- A **bridge**: subprocess in, A2A out (and the reverse for control messages where applicable).
- A **family of adapters**: one module per agent (or agent family) that translates native stdout/stdin protocols into A2A task lifecycle + artifacts.
- A **host process** using **`@a2a-js/sdk`** for protocol compliance (Agent Card, JSON-RPC, REST/SSE as provided by the SDK).
- A **deployment story**: Docker, systemd, health checks — so “works on my laptop” becomes “works in a fleet.”

## What Fang is not (v0.x)

- A replacement for the CLI agent’s **internal** tools (grep, edit, test) — those stay inside the agent.
- A full **orchestrator** — that is a separate product concern (routing, cost tiers, fan-out). Fang supplies **citizens**; orchestrators supply **traffic control**.
- A guarantee that **every** agent is pleasant to wrap (TUI-only, no machine-readable mode) — Tier-3 agents remain best-effort or explicitly unsupported.

## Personas

| Persona | Need |
|---------|------|
| **Host operator** | Run `fang wrap` / `fang start`, stable ports, auth, logs |
| **Agent author** | Clear adapter contract, tests, fixtures |
| **Orchestrator builder** | Discoverable Agent Card, predictable JSON-RPC, **optional typed client** |
| **Pi / IDE integrator** | Persistent RPC where the agent supports it — **no pointless respawn** |

## Strategic line

Position Fang as **protocol bridge**, not “yet another wrapper.” The efficiency story (CLI vs MCP schema bloat) is **marketing physics** — true in direction, but must be cited carefully (see `00-RESEARCH-PROGRAM.md`).

## Out of scope until explicitly scheduled

- First-class **multi-tenant** SaaS
- **GUI** for configuration
- **Automatic** installation of upstream CLIs (document prerequisites instead)
