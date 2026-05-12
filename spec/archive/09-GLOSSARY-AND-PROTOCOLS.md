# Glossary and protocols

## Core terms

| Term | Meaning |
|------|---------|
| **A2A** | Agent2Agent protocol — agent card discovery, JSON-RPC methods, task lifecycle, SSE streaming (see A2A spec / `@a2a-js/sdk`). |
| **Agent Card** | JSON document describing an agent’s capabilities, skills, transports — **small** vs MCP tool-schema dumps. |
| **Adapter** | Fang module translating a **specific CLI’s** stdin/stdout into A2A task updates / artifacts. |
| **Bridge / wrapper** | Fang’s host process: runs CLI(s), exposes A2A. |
| **Oneshot execution** | Spawn process per task (or per message), exit when done. |
| **Persistent execution** | Long-lived child process (e.g. Pi `--mode rpc`), multiplexed tasks over one JSONL stream. |
| **Orchestrator** | System that **calls** multiple A2A agents — not Fang itself unless explicitly built. |

---

## Protocol comparison (mental model)

| | **MCP** | **A2A** | **ACP** |
|---|---------|---------|---------|
| **Primary use** | Tools/resources/prompts to **one** LLM host | **Peer agents** — tasks, artifacts, streaming | IDE ↔ agent control, **stdio JSON-RPC** |
| **Discovery** | Tool lists (often **large** in context) | Agent Card (**small metadata**) | `initialize`, capability negotiation |
| **Fang’s job** | Usually **not** “re-implement MCP server for whole CLI” | **Yes** — be the A2A face of the CLI | **Translate** ACP streams to A2A for Tier-2 CLIs |

**Important:** “CLI vs MCP token efficiency” is about **not** forcing a **full coding agent** into an **MCP tool-shaped hole** in the orchestrator’s context — not about banning MCP everywhere.

---

## Bindings Fang actually uses (via SDK)

- **HTTP + JSON-RPC** for `message/send`, `message/stream`, task methods.
- **SSE** for streaming task updates (SDK `ExecutionEventBus`).
- **REST** where SDK exposes `restHandler` (verify version).

**gRPC:** SDK may expose it — track in `00-RESEARCH-PROGRAM.md` if you add a second transport.

---

## Adapter families (implementation language)

| Family | Examples | Parsing strategy |
|--------|----------|------------------|
| **JSONL / NDJSON** | Pi RPC, Codex `--json`, many stream modes | Line-buffered; **readline**; beware embedded newlines in JSON strings |
| **Stream-json** | Claude Code | NDJSON events; partial lines |
| **ACP** | Gemini CLI, Goose, OpenCode (modes vary) | JSON-RPC over stdio; session IDs |
| **Text + heuristics** | Some Aider paths, Crush | Regex / markers; **last resort** |

---

## Files to read externally (maintain versions in research notes)

- A2A specification repository (Linux Foundation / A2A project).
- `@a2a-js/sdk` release notes per bump.
- Upstream CLI `--help` and changelogs for each supported agent.
