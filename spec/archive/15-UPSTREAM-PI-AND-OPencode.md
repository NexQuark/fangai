# Upstream references — Pi (pi-mono) and OpenCode

Fang adapters for **Pi** and **OpenCode** must track these repositories as **primary sources of truth** for protocols, CLI flags, and breaking changes. Local clones for deep dives live under **`products/fang/playgorund/`** (optional; not submodules).

| Upstream | URL | Role for Fang |
|----------|-----|----------------|
| **Pi** | [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono) | `packages/coding-agent` — `--mode rpc` JSONL over stdio; command vocabulary in `rpc-types.ts` |
| **OpenCode** | [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) | `packages/opencode` CLI — `run` (SDK + `--format json`), `serve` (HTTP), attach URL |

---

## Pi (`pi-mono`)

**Entry:** `packages/coding-agent/src/main.ts` — `AppMode` includes `"rpc"`; `runRpcMode()` when `--mode rpc`.

**Protocol (authoritative):**

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` — **stdin commands** (`RpcCommand`, e.g. `{ type: "prompt", message }`, `{ type: "abort" }`) and **stdout** responses/events (JSONL, LF-framed).
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — `runRpcMode`, session event subscription, `serializeJsonLine` / strict JSONL framing (`jsonl.ts` — split on `\n` only, not generic readline Unicode breaks).
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — spawns `["--mode", "rpc"]` for embedders.

**Fang alignment**

- `@fangai/pi` **`PiAdapter`** must send **`{ type: "prompt", message }`** (not a generic chat `message` role object) per `RpcCommand`.
- **Persistent** execution matches long-lived `pi --mode rpc` + line-by-line stdout (events still stream after `type: "response"` acks).

**Cadence:** re-diff `rpc-types.ts` on each **minor** `pi` / `@mariozechner/pi-coding-agent` release you support.

---

## OpenCode (`anomalyco/opencode`)

**CLI (authoritative):**

- `packages/opencode/src/cli/cmd/run.ts` — **`--format json`** emits **one JSON object per line** to stdout (`type`, `timestamp`, `sessionID`, plus event payload; e.g. `text` with `part`, `error`, `tool_use`). The user message is passed via **argv / SDK session.prompt**, not by writing an ad-hoc JSON blob to stdin for the default path.
- `packages/opencode/src/cli/cmd/serve.ts` — headless HTTP server; pairs with SDK / clients; optional **`OPENCODE_SERVER_PASSWORD`** (see warning in command).

**Fang alignment (current vs target)**

- **`@fangai/adapter-opencode`** still parses **JSON lines** for subprocess-style integrations (`opencode run --format json` when stdin/stdout wrapping applies).
- **Supported path (Fang CLI):** `fang wrap opencode --open-code-url http://127.0.0.1:<port>` (optional `--open-code-password`, `--open-code-directory`) talks to a running **`opencode serve`** via **`@opencode-ai/sdk`** in `@fangai/core` — no subprocess for the agent binary.
- **`opencode run --attach http://…`** inside OpenCode itself uses the same server; Fang’s `--open-code-url` is the same idea from the A2A side.

**Cadence:** grep `run.ts` / SDK gen types when bumping the OpenCode version you claim in `fang detect` hints.

---

## Playground layout

After clone (shallow is enough for source reading):

- [pi-mono](https://github.com/badlogic/pi-mono) (local clone path is up to you)
- [opencode](https://github.com/anomalyco/opencode) (default branch upstream is often **`dev`**; pin a tag in research notes when you cite behavior)

These directories may be **gitignored** in your fork if you prefer not to vendor upstream; the spec links remain the durable reference.
