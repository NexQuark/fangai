# Security and trust boundaries

Fang runs **arbitrary CLI strings** from configuration. Treat it as **powerful** and **dangerous** if misconfigured.

---

## Threat model (minimum)

| Threat | Mitigation |
|--------|------------|
| **Command injection** | Never `shell: true` with unsanitized user input; prefer argv arrays; allowlist adapters. |
| **Credential leak via logs** | Redact env in logs; document `DEBUG` behavior. |
| **Exposed HTTP** | Fang listens with **`listen(port)`** (no host) — on common Node setups that means **all interfaces**, not only localhost. Use **`fang wrap --host 127.0.0.1`** or **`FANG_HOST=127.0.0.1`** to bind localhost only. For LAN or production, use **`FANG_API_KEY` / `fang wrap --api-key`**, firewall/reverse proxy, and set **`FANG_PUBLIC_URL`** so the agent card matches the URL clients use. Agent card + `/health` stay unauthenticated for discovery and probes. |
| **Process escape** | Document that Fang is **not** a sandbox — rely on OS containers / agent’s own sandbox flags. |

---

## What Fang does **not** guarantee

- Isolation equivalent to **Docker gVisor** or **WASM** — unless you deploy Fang **inside** hardened containers.
- **Content safety** of model output — that’s the upstream agent.

---

## Supply chain

- Pin **`@a2a-js/sdk`** and review on upgrade.
- npm **provenance** / GitHub OIDC for publish when ready (`11`).

---

## User data

- Default **in-memory** task store — tasks lost on restart; document for GDPR-style expectations if you add persistence.
