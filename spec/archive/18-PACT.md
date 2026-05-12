# SPEC 18 — PACT: The Body's Constitution

> The immune system. One canonical location. Append-only. Signature-chained. Enforced before execution.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-23

---

## 18.1 Location & Discovery

```
<repoRoot>/.fang/PACT.md          ← canonical (project)
~/.fang/PACT.md                    ← user fallback
/etc/fang/PACT.md                  ← system fallback (least priority)
```

Discovery order: project → user → system. First found wins (no merge). `inherit: extend` means child PACT layers on top of parent — tightens, never loosens.

---

## 18.2 Schema

YAML frontmatter (machine-read, enforced) + markdown body (human-read, informational only — **not** evaluated by SoulPump).

```yaml
---
pact: 1                                  # schema version of PACT itself
repoHash: sha256:9af...                  # binds to this body
version: 3                               # this PACT version
prev: sha256:c1b...                      # sha256 of previous PACT file content
issuedAt: 2026-05-12T00:00:00Z
issuedBy: venom
signature: ed25519:base64...             # signs (prev || canonical(rules))
ttl: 90d                                 # optional; re-sign after
rules:
  recursion:
    maxDepth: 4
    maxFanOut: 6
  budgets:
    global:
      tokensPerHour: 500000
      costUsdPerDay: 25
    perAgent:
      pi:       { tokensPerHour: 100000 }
      cursor:   { tokensPerHour: 200000, costUsdPerDay: 12 }
      opencode: { tokensPerHour: 100000 }
      claw:     { tokensPerHour: 5000 }
  paths:
    allow:
      - "packages/**"
      - "spec/**"
      - "docs/**"
    deny:
      - ".git/**"
      - "node_modules/**"
      - "**/secrets/**"
      - "**/.env*"
  agents:
    allow: [pi, cursor, opencode, claude, claw, venom]
    deny: []
    tierCaps: { 0: [claw], 3: [] }
  forbidden:
    - "shell:.*\\brm\\s+-rf\\b"
    - "shell:.*\\bdd\\s+if="
    - "shell:.*\\bmkfs\\b"
    - "shell:.*\\biptables\\s+-F"
    - "shell:.*shutdown|reboot|halt"
    - "http:.*://(169\\.254|10\\.|192\\.168|127\\.)"
  claw:
    allowedTools: [systemctl-status, systemctl-restart, journalctl, ps, df, du, free, lsof, netstat, ss, uptime]
    allowedServices: [fang-cursor, fang-pi, fang-opencode]
    readOnlyByDefault: true
    maxOutputLines: 4096
    maxArgChars: 256
    argDenylist: ["..", "/etc/shadow", "/root/.ssh"]
  inheritance: extend                    # extend | override
  allowOverride: false                   # children may not loosen
---

# §1 Identity
This body is bound to repo `kariemSeiam/fangai`.

# §2 Spirit
The body limps; it does not crash. Pact violations are rejections, not warnings.

# §3 Amendment process
PACT.md is append-only. New version = new file `PACT-v<N>.md`, links via `prev`. Only VENOM signs.
```

---

## 18.3 Evaluation Function

```ts
// packages/body/src/soul/pump.ts
export interface EvalContext {
  body: BodyHandle;
  ledger: BloodLedgerReader;
  now: () => Date;
}

export type PactDecision =
  | { ok: true; signedAt: string }
  | { ok: false; violation: { code: PactErrorCode; rule: string; detail: string; fitnessImpact: number } };

export function evaluate(frame: InkPayload, pact: Pact, ctx: EvalContext): PactDecision {
  // 1. Identity: repoHash match
  if (frame.repoHash !== pact.repoHash)
    return violation('PACT_WRONG_BODY', '$1', `expected ${pact.repoHash}`, -1.0);

  // 2. Pact freshness: frame.pactRef must be current or valid ancestor
  if (!isValidPactRef(frame.pactRef, pact))
    return violation('PACT_STALE', '$1', 'pactRef outdated', -0.5);

  // 3. Agent allowlist
  if (!pact.rules.agents.allow.includes(frame.selector))
    return violation('PACT_AGENT_DENIED', '$3.agents', frame.selector, -0.3);

  // 4. Depth check
  if (frame.depth >= pact.rules.recursion.maxDepth)
    return violation('PACT_DEPTH_EXCEEDED', '$3.recursion', `depth=${frame.depth}`, -0.1);

  // 5. Budget check
  const spent = ctx.ledger.windowSpend(frame.selector.agentId, 3600_000);
  const cap  = pact.rules.budgets.perAgent[frame.selector.agentId] ?? pact.rules.budgets.global;
  if (spent.tokens + (frame.budget.tokens ?? 0) > cap.tokensPerHour)
    return violation('PACT_BUDGET_EXCEEDED', '$3.budgets', `tokens=${spent.tokens}`, -0.2);

  // 6. Path rules
  for (const input of frame.inputs) {
    if (matchesGlob(input.uri, pact.rules.paths.deny))
      return violation('PACT_PATH_FORBIDDEN', '$3.paths', input.uri, -0.5);
  }

  // 7. Forbidden operations (regex sweep on prompt + all inputs)
  for (const re of pact.rules.forbidden) {
    if (new RegExp(re, 'i').test(frame.prompt))
      return violation('PACT_FORBIDDEN_OP', '$3.forbidden', re, -1.0);
  }

  return { ok: true, signedAt: new Date().toISOString() };
}
```

**Key properties:**
- Pure function of `(frame, pact, ctx)` — testable without side effects
- Runs synchronously in SoulPump before TaskPump ever sees the frame
- Returns `{ ok: false, violation: { fitnessImpact } }` — the dispatcher applies this penalty to the agent's fitness score
- `ctx.ledger` is read-only — evaluation never writes

---

## 18.4 Error Codes

| Code | Meaning | Fitness Impact |
|------|---------|----------------|
| `PACT_WRONG_BODY` | repoHash mismatch | -1.0 |
| `PACT_FROM_FUTURE` | issuedAt > now | -0.3 |
| `PACT_AGENT_DENIED` | agent not in allowlist | -0.3 |
| `PACT_DEPTH_EXCEEDED` | recursion too deep | -0.1 |
| `PACT_FORBIDDEN_OP` | matched forbidden regex | -1.0 |
| `PACT_PATH_FORBIDDEN` | input path denied | -0.5 |
| `PACT_BUDGET_EXCEEDED` | token/hour cap exceeded | -0.2 |
| `PACT_CLAW_TOOL_DENIED` | Claw tool not allowed | -0.5 |
| `PACT_SIGNATURE_INVALID` | ed25519 signature fails | -1.0 |
| `PACT_PREV_CHAIN_BROKEN` | `prev` hash doesn't chain | -0.3 |

---

## 18.5 Versioning & Signature Chain

```
PACT-v1.md  ←  genesis (VENOM signs)
  prev: null
  signature: sign(null || canonical(rules_v1))

PACT-v2.md
  prev: sha256(PACT-v1.md content)
  signature: sign(prev || canonical(rules_v2))

PACT-v3.md
  prev: sha256(PACT-v2.md content)
  ...
```

**Verification:** SoulPump walks the chain from the current PACT back to genesis. Any break → `PACT_PREV_CHAIN_BROKEN`. Signatures verified with ed25519 public key embedded in the body's identity config.

---

## 18.6 Inheritance Model

| `inheritance` | Behavior |
|---------------|----------|
| `extend` | Child PACT layers on top of parent. Rules merge (child overrides parent). Allowlists intersect (AND). Denylists union (OR). Budgets take the tighter cap. Depth takes the smaller max. |
| `override` | Child completely replaces parent. Used when a project needs entirely different rules. |

`allowOverride: false` in a parent PACT means children **must** use `extend`. This prevents a sub-project from weakening security.

---

## 18.7 What SoulPump Rejects Look Like

```json
{
  "kind": "pact.rejected",
  "code": "PACT_FORBIDDEN_OP",
  "rule": "shell:.*\\brm\\s+-rf\\b",
  "detail": "prompt matched forbidden pattern",
  "pactVersion": 3,
  "fitnessImpact": -1.0,
  "frame": { "correlationId": "...", "intent": "..." }
}
```

This is emitted as a Pulse (`pact.rejected`), written to BloodLedger, and surfaced to the parent as an error reply on the `replyTopic` channel. The agent that generated the violating frame receives a fitness penalty.

---

## 18.8 Defense in Depth

PACT enforcement is the first layer. Additional layers:

1. **SoulPump** — pre-flight PACT evaluation (this spec)
2. **ClawMuscle** — per-operation allowlist (SPEC-22)
3. **Muscle sandbox** — OS-level isolation (future: containers, SPEC-14)
4. **Output scanning** — secret redaction before ledger persistence

Three independent layers reject `rm -rf /` — PACT regex, tool not registered, path validator. No single bypass compromises the body.

🐙
