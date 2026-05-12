# Research program (continuous)

Goal: **prevent the blueprint from lying** and catch ecosystem shifts before they become rework. Research is not a one-time essay; it is a **recurring obligation** with owners and exit criteria.

---

## 1. Tier-1: Re-verify on every minor release (agents)

For each CLI agent Fang claims to support, maintain a **capability card** (YAML or table in `04-VERSION-MATRIX.md`) with:

| Field | Example |
|-------|---------|
| Binary name(s) | `pi`, `claude`, `aider` |
| Version tested | exact semver from `--version` |
| Invocation | minimal flags Fang relies on |
| Input contract | stdin / args / env |
| Output contract | JSONL / NDJSON / text / ACP |
| Persistent? | yes / no / N/A |
| Failure modes | hangs, TUI noise, partial JSON |

**Cadence:** monthly or when upstream ships a major/minor.

**Method:** scripted smoke (where safe): `--help`, `--version`, dry-run flags; document anything that requires API keys separately.

---

## 2. Tier-2: Protocol and SDK

| Topic | Question | Where to look |
|-------|----------|----------------|
| A2A spec version | What does `@fangai/core` target vs what the spec says? | A2A repo, `@a2a-js/sdk` release notes |
| Agent Card URL | `/.well-known/agent-card.json` vs aliases | SDK handlers + our tests |
| JSON-RPC surface | Method names still `message/send`, etc.? | SDK `DefaultRequestHandler` |
| Client API | Does SDK expose a first-class client? | `@a2a-js/sdk` → `client` exports (`A2AClient`) |

**Exit criterion:** Each release has a **Spec alignment** subsection in release notes (3–5 bullets).

---

## 3. Tier-3: Competitive landscape (quarterly)

Refresh answers to:

- Who wraps CLIs with **REST** (e.g. agentapi) vs **A2A**?
- Any **native A2A server mode** shipping in major CLIs?
- LiteLLM / gateways: integration points for Fang servers?

**Anti-pattern:** Star counts and anecdotal HN claims without a dated source.

---

## 4. Tier-4: Token economy claims (marketing hygiene)

Treat benchmark numbers as **hypotheses**:

- Keep a **primary source list** (URL + date + what was measured).
- Prefer ranges and “order of magnitude” in public copy unless a number is pinned to a reproducible benchmark harness.

---

## 5. Deliverables from research spikes

Each spike produces **one** of:

- A row update in `04-VERSION-MATRIX.md`
- A new ADR (short file under `spec/adr/` if you adopt ADRs)
- A test fixture (stdout sample) checked into `packages/*/tests/fixtures/`

**No spike without an artifact** — otherwise it did not happen.

---

## 6. Suggested backlog (first 30 days)

1. **Aider:** confirm `--json` / `--json-output` flags across versions; align adapter and docs (blueprint said “text only” — likely obsolete).
2. **Pi RPC:** document `prompt` / `abort` / line framing; add fixtures from real JSONL lines.
3. **SDK client:** prototype `@fangai/client` as thin re-export + ergonomics, or document “use `A2AClient` directly.”
4. **Gemini / Goose ACP:** defer until Pi + Claude + Aider are stable on the merged architecture — but keep a stub capability card.

---

## 7. Cross-links (deeper dives)

| Topic | Document |
|-------|----------|
| Competitors, gateways, hosts | [08-ECOSYSTEM-MAP.md](./08-ECOSYSTEM-MAP.md) |
| Terms, A2A vs MCP vs ACP | [09-GLOSSARY-AND-PROTOCOLS.md](./09-GLOSSARY-AND-PROTOCOLS.md) |
| Pi + OpenCode upstream (pi-mono, opencode) | [15-UPSTREAM-PI-AND-OPencode.md](./15-UPSTREAM-PI-AND-OPencode.md) |
| Answerable research questions | [10-RESEARCH-BACKLOG.md](./10-RESEARCH-BACKLOG.md) |
| npm, GitHub, Docker, semver | [11-DISTRIBUTION-AND-PUBLISHING.md](./11-DISTRIBUTION-AND-PUBLISHING.md) |
| Fixtures, CI, contracts | [12-TESTING-AND-CONTRACTS.md](./12-TESTING-AND-CONTRACTS.md) |
| Brand vs SEO keywords | [13-NAMING-AND-DISCOVERY.md](./13-NAMING-AND-DISCOVERY.md) |
| Threat model, trust | [14-SECURITY-AND-TRUST-BOUNDARIES.md](./14-SECURITY-AND-TRUST-BOUNDARIES.md) |
| Formal decisions | [adr/README.md](./adr/README.md) |
