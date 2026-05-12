# SPEC 21 — Testing Strategy

> The organism must be testable at every layer. Coverage gates locked. CI defined.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12

---

## 21.1 Unit Tests — Mock vs Real

| Mocked | Real |
|--------|------|
| `child_process.spawn` (always) | `Conductor` / PulseBus |
| HTTP muscle endpoints (msw) | `BloodLedger` (tmp dir) |
| Filesystem for PACT (in-memory) | `SoulPump.evaluate` |
| Clock (`vi.useFakeTimers`) for deadlines | Zod schemas |
| Random (uuid stub) for deterministic ids | Dispatcher resolver |

**Coverage gates:**
- `packages/body` ≥ 85% lines
- `nerves/`, `soul/`, `blood/` ≥ 95%

---

## 21.2 Integration Tests — Pi→Cursor Without Real Agents

**FakeMuscle** class implementing `Muscle` interface:
```ts
class FakeMuscle implements Muscle {
  id: string;
  tier: number;
  skills: string[];
  responses: Map<string, InkResult>;

  async execute(frame: Frame): Promise<InkResult> {
    return this.responses.get(frame.payload.intent) ?? { status: 'ok', artifacts: [] };
  }
}
```

**Test:** `VENOM frame in → assert ledger lineage, child dispatch fired, result composed.`

---

## 21.3 Contract Tests — JSON Schema as Source of Truth

Schemas in `packages/body/contracts/`:
```
contracts/
  ink/
    dispatch.schema.json
    progress.schema.json
    result.schema.json
    decline.schema.json
  pulse/
    pulse.schema.json
  blood/
    entry.schema.json
  pact/
    pact.schema.json
```

For each schema: generator test materializing samples of every variant, validated with ajv. TS types inferred via `json-schema-to-typescript`. CI check (`scripts/check-schema-parity.ts`) diffs inferred TS types against schemas — fails build on drift.

---

## 21.4 SIPHON Tests

**Fixtures:** `packages/body/fixtures/sessions/*.jsonl` (real recorded sessions, redacted).

```ts
const session = loadSession('cursor-refactor-2026-04.jsonl');
const records = await Siphon.extract(session);
expect(records).toMatchSnapshot('cursor-refactor.memory.snap');
```

Coverage: at least one fixture per (agent × kind) where `kind ∈ {decision, observation, preference, failure, fact}`.

---

## 21.5 Fitness Tests

```ts
const entries: BloodEntry[] = [
  { type:'task.end', agentId:'cursor', payload:{status:'ok'},   cost:{durationMs:10_000, tokens:5000} },
  { type:'task.end', agentId:'cursor', payload:{status:'ok'},   cost:{durationMs:12_000, tokens:5500} },
  { type:'task.end', agentId:'cursor', payload:{status:'failed'}, cost:{durationMs:30_000} },
];
const f = computeFitness('cursor', entries, { windowMs: 3_600_000 });
expect(f.score).toBeCloseTo(0.71, 2);
expect(f.components.successRate).toBeCloseTo(0.667, 3);
```

Formula locked in code. Tests pin it. Changes to weights require updating snapshots → forced review.

---

## 21.6 Pact Tests — Table-Driven

```ts
test.each([
  ['budget OK',    frameWith({tokens: 1000}),                pactWith({tokensPerHour: 10000}), {ok:true}],
  ['budget over',  frameWith({tokens: 20000}),               pactWith({tokensPerHour: 10000}), {code:'PACT_BUDGET_EXCEEDED'}],
  ['rm -rf',       frameWith({prompt:'please rm -rf node_modules'}), pactBase,                  {code:'PACT_FORBIDDEN_OP'}],
  ['path deny',    frameWith({uri:'.git/config'}),           pactBase,                          {code:'PACT_PATH_FORBIDDEN'}],
  ['depth=4',      frameWith({depth: 4}),                     pactWith({maxDepth: 4}),          {code:'PACT_DEPTH_EXCEEDED'}],
  ['agent denied', frameWith({lineage:[{agentId:'crush'}]}),  pactWith({allow:['pi','cursor']}), {code:'PACT_AGENT_DENIED'}],
])('%s', (_, frame, pact, want) => {
  const res = evaluate(frame, pact, ctxFake);
  if ('code' in want) expect(res).toMatchObject({ ok:false, violation:{ code: want.code }});
  else expect(res.ok).toBe(true);
});
```

---

## 21.7 E2E — "Three Agents, One Task"

`packages/body/src/__tests__/e2e/three-agents.test.ts`:

- Spin up three `FakeMuscle` HTTP servers on random ports (pi, cursor, opencode)
- Boot a real `Body` against them via real `BodyConfig`
- Send VENOM ask via `FangClient.streamMessage`
- Assert: pi receives → pi dispatches to cursor → cursor dispatches to opencode → all results compose → final A2A response back to VENOM
- Assert ledger: exactly 3 `task.start`, 3 `task.end`, 2 `ink.dispatched`, 2 `ink.received`, 6 `pact.passed`, 0 `pact.rejected`

**Wall time budget:** 5 seconds.

---

## 21.8 CI Pipeline

```
.github/workflows/
  ci.yml            # on push + PR
  e2e.yml           # on PR + nightly main
  release.yml       # on tag
```

| Trigger | Jobs |
|---------|------|
| **push** | `pnpm install --frozen-lockfile` → typecheck → lint → build → unit tests (Node 20 + 22) |
| **PR** | Above + contract tests (schema validation) + integration tests + coverage report |
| **merge to main** | E2E suite (with FakeMuscles) + optional nightly `RUN_REAL_PI=1` |
| **tag `v*`** | Full pipeline + publish to npm via `pnpm release:verify && pnpm release:publish` |

---

## 21.9 Test Command Reference

```bash
# All tests
pnpm -r test

# Body package only
pnpm --filter @fangai/body test

# With coverage
pnpm --filter @fangai/body test --coverage

# E2E only
pnpm --filter @fangai/body test e2e

# Single file
pnpm --filter @fangai/body test dispatcher.test.ts

# Watch mode
pnpm --filter @fangai/body test --watch
```

🐙
