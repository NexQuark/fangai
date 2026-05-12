# Architecture target (production)

**Implementation home:** **[repository root](https://github.com/kariemSeiam/fangai)** in the public repo **[`kariemSeiam/fangai`](https://github.com/kariemSeiam/fangai)** (`pnpm` workspace; see [`README.md`](../README.md)).

This is the **intended** end state after merging lessons from earlier internal prototypes:

| Prototype lineage | Take |
|--------|------|
| **v3 (Express + SDK stack)** | Express + `@a2a-js/sdk`, `@fangai/*` packages, adapter packages, CI/Docker/docs |
| **v1** | **Persistent** executor path for Pi `--mode rpc` (long-lived process, multiplex tasks) |
| **v2** | **`ProcessManager`** (readline, SIGTERM→SIGKILL, timeouts), **`Detector`** (`which` + version), rich **`AgentAdapter`** / multi-event **`parseLine`** |

**Drop:** v2’s hand-rolled Hono A2A server — use SDK handlers instead.

---

## Package layout (target)

Align with existing v3 naming; avoid unnecessary renames.

```
packages/
  core/           # FangServer, FangAgentExecutor, AdapterRegistry, config
  cli/            # Commander CLI: wrap, start, discover, send, card, …
  adapters/*/     # pi, claude, aider, opencode, generic, … (optional packages)
```

**`@fangai/client`** (see `fang/packages/client`) — `FangClient`, `discoverRunningAgents`, `callJsonRpc`; route-by-tier helpers remain optional.

Optional future:

```
packages/
  client/         # @fangai/client — shipped (extend with routing / retries as needed)
```

---

## Executor model

1. **Oneshot** — spawn per task, parse stdout, exit (Claude/Aider batch modes, etc.).
2. **Persistent** — one (or pooled) long-lived process; stdin/stdout JSONL or RPC; **must** map cleanly to SDK `ExecutionEventBus` and task isolation.

**Non-negotiable:** For Pi RPC, persistent mode is not optional — respawning per task **voids** the point of `--mode rpc`.

---

## Adapter contract (directional)

Move from “single `TaskUpdate | null`” toward **multiple domain events per line** where agents emit rich JSON:

```ts
// Conceptual — align with implementation during merge
parseLine(line: string): AdapterEvent[]
```

Translation layer maps `AdapterEvent[]` → SDK `eventBus.publish(…)`.

---

## Observability

- Structured logs (level, taskId, adapterId).
- Health endpoint: process model (oneshot vs persistent), SDK version, adapter id.
- Optional: OpenTelemetry hook (later phase).

---

## Security

- API key middleware (restore from v1 idea if dropped in v3).
- Document **never** pass untrusted strings into `shell: true`.
- Sandboxing is **agent-dependent** — Fang documents flags; it does not promise kernel-level isolation unless integrated with external sandbox tools.

---

## Testing strategy

- **Unit:** parsers per adapter (fixtures: real stdout lines).
- **Integration:** mock child process streams.
- **Contract:** hit JSON-RPC with golden requests against a test `AgentExecutor` stub.

---

## Relation to orchestrators (Pi, VENOM, etc.)

Fang makes an agent **callable**. The **routing story** (“send refactor to Aider, reasoning to Claude”) belongs in:

- a separate **orchestrator** package, or
- Pi extensions / skills,

…using **`A2AClient`** (SDK) or `@fangai/client` once shipped.
