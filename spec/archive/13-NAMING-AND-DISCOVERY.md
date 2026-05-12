# Naming and discovery (SEO / npm / GitHub)

## Two valid goals in tension

| Goal | Favors |
|------|--------|
| **Memorable brand** | `Fang`, wolf imagery, `@fangai/cli` |
| **Search clarity** | `a2a-cli`, `agent2agent`, `cli-to-a2a` in text |

**Recommendation:** Brand **Fang** everywhere human-facing; **first paragraph** of README and repo description must contain plain keywords: *“A2A server”, “CLI coding agents”, “Agent2Agent”, “wrap Claude / Pi / …”* so search engines and GitHub search still find you without the word “fang” alone.

---

## Package naming matrix

| Artifact | Suggested | Notes |
|----------|-----------|--------|
| npm scope | `@fangai/*` | Clear org ownership |
| CLI command | `fang` | Short; `package.json` `bin` |
| Repo | `fang` or `fang-ai` | GitHub URL is shareable |
| Optional unscoped | `a2a-bridge` / `fang-cli` | Only if available and legal — **not required** |

---

## PyPI / other ecosystems

If you later ship Python:

- Prefer **`fang-a2a`** or **`a2a-cli-bridge`** style names — **do not** assume npm name transfers.

---

## Discovery checklist (launch)

- [ ] GitHub **About** box: one-line + website/docs link
- [ ] npm **keywords** array full (`a2a`, `agent`, `cli`, `claude`, `bridge`, …)
- [ ] Awesome lists / directories (submit after stable 0.x)
- [ ] Cross-link from **LiteLLM** / A2A community docs if they maintain integration lists

---

## Confusion to pre-empt

- **“a2a-cli” on npm** may refer to **another** project — always disambiguate in README: *“This repository (Fang) publishes `@fangai/cli`.”*
- **MCP** — clarify Fang is **not** replacing MCP globally; it offers **A2A** for **whole agents**.
