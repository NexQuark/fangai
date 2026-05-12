# Ecosystem map — where Fang sits

Purpose: **orient every design decision** — Fang is one node in a graph, not the whole graph.

```
                    ┌─────────────────┐
                    │  Orchestrator   │
                    │ (Pi, custom app, │
                    │  enterprise hub)  │
                    └────────┬────────┘
                             │ A2A (JSON-RPC / SSE / REST)
                             ▼
                    ┌─────────────────┐
                    │  Fang server    │  ← this product
                    │  (@a2a-js/sdk)  │
                    └────────┬────────┘
                             │ stdin/stdout / spawn
                             ▼
                    ┌─────────────────┐
                    │ CLI coding agent │
                    │ (Claude, Pi, …)  │
                    └─────────────────┘
```

---

## Layer 1 — Same problem, different protocol (competitors / analogs)

| Offering | Protocol outward | CLI inward | Relation to Fang |
|----------|-------------------|------------|------------------|
| **agentapi** (Coder) | REST + SSE | Many CLIs | **Closest functional competitor** — unified HTTP, not A2A. Migration path: same adapters, different outer API. |
| **Paperclip** | Proprietary / heartbeat | CLIs | Architectural cousin; **not** interoperable with A2A clients. |
| **gemini-cli-a2a-server** (Google) | A2A | Gemini only | Proves **single-vendor A2A wrapper** pattern; Fang is **multi-vendor**. |
| **MCP servers** | MCP | Varies | Different axis: MCP is often **tool schema to the caller**; Fang targets **agent-as-peer** via A2A. |

**Takeaway:** Position Fang as **standards-based agent peer** (A2A), not “another REST wrapper” — unless you intentionally ship a REST facade later.

---

## Layer 2 — Complementary (not competitive)

| Project | Role | How Fang plugs in |
|---------|------|-------------------|
| **LiteLLM** (A2A support) | Proxy / auth / cost routing in front of A2A servers | Fang servers sit **behind** LiteLLM as upstream agents. |
| **`@a2a-js/sdk` client** | Call remote A2A agents | Orchestrators use SDK client; Fang documents **URLs + Agent Cards**. |
| **agentify-cli** | Static cards / docs from OpenAPI | Generates **files**, not processes — upstream of discovery, not runtime. |

---

## Layer 3 — Upstream movers (watch quarterly)

- **Native “A2A server” modes** inside CLIs (e.g. Gemini ecosystem experiments) — could shrink Fang’s value for that CLI **unless** you stay ahead on **multi-agent + ops + uniform config**.
- **ACP adoption** — if IDE and CLI converge on ACP, Fang’s **ACP→A2A** adapter becomes central (one bridge, many agents).

---

## Layer 4 — Host environments

| Environment | Implication for Fang |
|-------------|------------------------|
| **Linux server / systemd** | First-class; document hardening (already in v2/v3 artifacts). |
| **Docker / K8s** | Healthchecks, multi-container fleets per agent. |
| **macOS dev** | `which` paths, Gatekeeper, local API keys. |
| **Windows / WSL** | Spawn semantics, line endings, path translation — **test explicitly**; many users run Pi under WSL. |

---

## Layer 5 — Your monorepo prototypes (internal)

| Tree | Role |
|------|------|
| `a2a-cli-01` | Proof: SDK + persistent Pi |
| `fang` | Proof: ProcessManager, Detector, rich adapters — **do not** ship Hono A2A |
| `a2a-cli` | Proof: packages, CI, Docker, `@fangai/*` |

**Spec rule:** External ecosystem doc links **public** repos and specs; internal trees are **implementation references** only.
