# SPEC 19 — Body.boot(): The Entry Point

> The single function that brings the organism to life. 11 phases. Identity first, capabilities last.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-18, SPEC-23

---

## 19.1 Config Shape

```ts
interface BodyConfig {
  workdir: string;                       // repo root; home of .fang/
  repoHash?: string;                     // optional; auto-detected from git
  pactPath?: string;                     // default: .fang/PACT.md
  sensesPath?: string;                   // default: .fang/senses/
  muscles: {
    autoDiscover: boolean;               // chokidar on muscles/*.adapter.ts
    paths: string[];                     // additional search paths
    static: MuscleConfig[];              // hand-configured muscles
  };
  skin: {
    http?: { port: number; host?: string; apiKey?: string };
    cli?: { enabled: boolean };
    hermes?: { enabled: boolean };
  };
  hearts: {
    soul:   { enforce: 'hard' | 'soft' };
    context:{ intervalMs: number };      // default: 2000
    task:   { maxConcurrency: number };
  };
  blood: {
    path: string;                        // default: .fang/blood/
    rotation: { maxBytes?: number; maxAgeMs?: number };
  };
  memory: {
    path: string;                        // default: .fang/memory/
    model?: string;                      // cheap model for SIPHON extraction
  };
  ledger: {
    path: string;
    rotation: { maxBytes?: number; maxAgeMs?: number };
  };
}
```

---

## 19.2 Boot Sequence (11 Phases)

```
Phase 1  — Load config, validate, apply defaults
Phase 2  — Open BloodLedger (append-only JSONL)
Phase 3  — Compute/verify repoHash (identity). FAIL = hard exit.
Phase 4  — Load PACT, verify signature chain
Phase 5  — Open MemoryStore
Phase 6  — Mount static muscles + auto-discover muscle files
Phase 7  — Mount senses (MCP servers)
Phase 8  — Wire Hearts: create PulseBus, instantiate SoulPump → ContextPump → TaskPump
Phase 9  — Pact load: verify signature chain, register with SoulPump. FAIL = exit.
Phase 10 — Start HTTP skin (health endpoint before full serve)
Phase 11 — Emit body.ready pulse → announce to fleet
```

**Phase 3 failure = hard exit.** Wrong repoHash means this body is mounted on the wrong project. Everything downstream depends on correct identity.

**Phase 9 failure = hard exit.** Invalid PACT signature means the body cannot enforce any rules. Unsafe to operate.

**Phase 6-7 failures = degraded mode.** Missing muscles/senses emit `muscle.degraded` / `sense.degraded` pulses. Body operates with reduced capabilities. `/health` reports `status: 'degraded'`.

---

## 19.3 Implementation

```ts
// packages/body/src/boot.ts
export async function boot(cfg: BodyConfig): Promise<BodyHandle> {
  const phase = (n: number, label: string) => log('info', `boot:${n}`, { label });

  phase(1, 'config');
  const resolved = resolveConfig(cfg);

  phase(2, 'ledger');
  const ledger = new BloodLedger({ path: resolved.ledger.path, rotation: resolved.ledger.rotation });
  await ledger.open();

  phase(3, 'identity');
  const repoHash = resolved.repoHash ?? await computeRepoHash(resolved.workdir);
  if (!repoHash) throw new BootError('identity', 'Cannot compute repoHash — not a git repo?');

  phase(4, 'senses-init');
  const senseRegistry = new SenseRegistry({ paths: [resolved.sensesPath] });
  await senseRegistry.scan();

  phase(5, 'memory');
  const memory = new MemoryStore({ path: resolved.memory.path });

  phase(6, 'muscles');
  const muscleRegistry = new MuscleRegistry({ autoDiscover: resolved.muscles.autoDiscover, paths: resolved.muscles.paths });
  for (const m of resolved.muscles.static) await muscleRegistry.mount(m);
  if (resolved.muscles.autoDiscover) muscleRegistry.startWatching();

  phase(7, 'senses');
  const sensePool = new SensePool(senseRegistry);
  await sensePool.warmAll();

  phase(8, 'hearts');
  const conductor = new Conductor(ledger);
  const soul = new SoulPump(conductor, pact);
  const ctx  = new ContextPump(conductor, ledger, memory, muscleRegistry);
  const task = new TaskPump(conductor, muscleRegistry, soul);

  phase(9, 'pact');
  const pact = await loadAndVerifyPact(resolved.pactPath, repoHash);
  soul.setPact(pact);

  phase(10, 'skin');
  let httpServer: HttpServer | undefined;
  if (resolved.skin.http) {
    httpServer = new HttpServer(resolved.skin.http, { conductor, muscleRegistry, ledger });
    await httpServer.listen();
  }

  phase(11, 'ready');
  conductor.emit('body.ready', 'boot', { repoHash, pactVersion: pact.version, muscles: muscleRegistry.ids(), senses: sensePool.ids() });

  return {
    repoHash, pact, ledger, memory, conductor,
    muscles: muscleRegistry, senses: sensePool,
    http: httpServer,
    stop: async () => { /* graceful teardown */ },
    health: () => buildHealthReport({ muscles: muscleRegistry, senses: sensePool, pact, ledger }),
  };
}
```

---

## 19.4 Graceful Shutdown (`body.stop()`)

```
1. Emit body.dying pulse
2. Stop accepting new tasks (TaskPump closes inbound)
3. Drain in-flight tasks (wait up to 30s)
4. Close HTTP server
5. Unmount senses (close MCP processes)
6. Unmount muscles (close persistent processes)
7. Close MemoryStore
8. Close BloodLedger
9. Emit body.dead pulse
10. Conductor.drain() (remove all listeners)
```

---

## 19.5 Health During Boot

`/health` returns progressively richer responses:

```
Phase 1-2:  { status: 'booting', phase: 'config', ready: false }
Phase 3-9:  { status: 'booting', phase: 'hearts', ready: false }
Phase 10:   { status: 'booting', phase: 'skin', ready: false, http: 'listening' }
Phase 11:   { status: 'ok', ready: true, repoHash, pactVersion, muscles: [...], senses: [...] }
```

After ready: full health report with per-muscle status, per-sense status, budget remaining, pact version. `ready: true` = accepting tasks.

---

## 19.6 Hot Reload

- **Adding a muscle:** Drop `new-agent.adapter.ts` into `muscles/` → chokidar detects → `muscle.mounted` pulse → appears in health and selector candidates within 2s (ContextPump sweep).
- **Removing a muscle:** Delete file → `muscle.unmounted` pulse → drained of in-flight tasks → removed from registry.
- **PACT update:** Write new `PACT-v<N+1>.md` → SoulPump detects via fs watch → verifies chain → atomically swaps active PACT. In-flight frames evaluated against the PACT that was active at dispatch time.
- **Config change:** Requires restart. `kill -SIGUSR2` triggers graceful shutdown + re-boot without dropping in-flight tasks.

🐙
