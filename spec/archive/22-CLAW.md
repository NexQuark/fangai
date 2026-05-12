# SPEC 22 — Claw: The System Operations Muscle

> The arm that touches the OS. Whitelist registry. Three-layer defense. Same Muscle interface.

**Status:** Draft · **Author:** VENOM + Cursor Opus 4.7 · **Date:** 2026-05-12  
**Depends on:** SPEC-03, SPEC-17, SPEC-18, SPEC-23

---

## 22.1 Tools (Whitelist)

```ts
type ClawTool =
  | 'systemctl-status' | 'systemctl-restart'
  | 'journalctl'
  | 'ps' | 'top' | 'free' | 'uptime'
  | 'df' | 'du' | 'lsof'
  | 'netstat' | 'ss' | 'iptables-list'
  | 'apt-list' | 'apt-search';
```

**Explicitly NOT available — and there is no flag to enable them:**
```
rm, dd, mkfs, fdisk, parted, mount, umount,
iptables -F / -A / -D, ip link, kill (-9 or otherwise),
shutdown, reboot, halt, poweroff,
chmod, chown (when path outside repo)
```

To add a tool: write entry in `clawTools.ts` registering command builder + argument validator + output parser, then update PACT. Three places to change = three pairs of eyes.

---

## 22.2 Security — Three Independent Layers

**Layer 1 — PACT regex sweep:** SoulPump evaluates ALL frames (including Claw's) against `pact.rules.forbidden` regexes. `rm -rf` fails here before Claw even sees the frame.

**Layer 2 — Tool registry:** `ClawMuscle` calls `pact.assertClawAllowed(tool, args)` before each exec. Tool not in registry → `PACT_CLAW_TOOL_DENIED`.

**Layer 3 — Argument validation:** Per-tool validators. Path-typed args run through PathRules. Service-typed args run through `allowedServices` set. String args checked against `argDenylist`.

**Output-level:** stdout truncation to `maxOutputLines`, secret-scan (redact strings matching `/api[_-]?key|password|token/i`) before persisting to ledger.

---

## 22.3 PACT Configuration

```yaml
claw:
  allowedTools: [systemctl-status, journalctl, ps, df, free, uptime]
  allowedServices: [fang-cursor, fang-pi, fang-opencode]
  readOnlyByDefault: true
  maxOutputLines: 4096
  maxArgChars: 256
  argDenylist: ["..", "/etc/shadow", "/root/.ssh"]
```

If `readOnlyByDefault: true` and tool is `systemctl-restart`, frame must carry `meta.labels['claw.write'] = 'true'` AND that label must be in PACT signed frame allowance.

---

## 22.4 Adapter Interface

```ts
export class ClawMuscle implements Muscle {
  readonly id = 'claw';
  readonly tier = 0 as const;
  readonly skills = ['system.diagnose','system.logs','system.health','system.processes'];

  constructor(private deps: { pact: PactAccessor; ledger: BloodLedger; runner?: ShellRunner }) {}

  async execute(frame: ClawFrame): Promise<InkResult> {
    const { tool, args } = parseClawIntent(frame.payload.intent, frame.payload.inputs);
    this.deps.pact.assertClawAllowed(tool, args);  // throws PactViolation
    await this.deps.ledger.append({ type:'task.start', agentId:'claw', correlationId: frame.payload.correlationId, payload:{ tool, args }});
    const cmd = buildCommand(tool, args);           // pure function
    const out = await (this.deps.runner ?? defaultRunner).run(cmd, { timeoutMs: 30_000, maxOutputBytes: 4*1024*1024 });
    const parsed = parsers[tool](out.stdout, out.stderr, out.code);
    return {
      status: out.code === 0 ? 'ok' : 'failed',
      artifacts: [{ id: crypto.randomUUID(), mimeType: 'application/json', inline: JSON.stringify(parsed) }],
      spentBudget: { durationMs: out.durationMs },
      fitnessSignal: { quality: out.code === 0 ? 0.9 : 0.2, latencyMs: out.durationMs }
    };
  }
}
```

**Same `Muscle` shape as every other adapter.** The privilege is structural (the tool registry), not the interface.

---

## 22.5 Example — Diagnose 3am Restart

**VENOM dispatches:**
```json
{"method":"ink/dispatch","params":{
  "intent":"system.diagnose:service-restart",
  "prompt":"Why did fang-cursor restart at 03:00 UTC on 2026-05-12?",
  "selector":{"kind":"direct","agentId":"claw"},
  "budget":{"durationMs":60000},
  "meta":{"labels":{"target":"fang-cursor","since":"2026-05-12T03:00:00Z","until":"2026-05-12T04:00:00Z"}}
}}
```

**Inside Claw:**
```
1. parseClawIntent → suggests: [systemctl-status, journalctl]
2. pact.assertClawAllowed:
   - systemctl-status fang-cursor → OK (service in allowedServices)
   - journalctl -u fang-cursor --since '03:00' --until '04:00' → OK
3. exec systemctl-status:
   parsed: { activeState:'active', subState:'running', restartCount: 3 }
4. exec journalctl:
   parsed: { lines: [...], oomEvents: 2, exitCodes: [137,137], firstError: 'OOM killed (memory > 512M)' }
5. Compose artifact:
   {
     "service":"fang-cursor", "window":["03:00","04:00"], "restarts":2,
     "rootCauseHypothesis":"OOM (memory.max=512M; spike to 540M before kill)",
     "evidence":["lines 1234-1241","lines 1502-1509"],
     "suggestedAction":"raise systemd MemoryMax to 1G or profile leak"
   }
6. Return InkResult{ status:'ok', artifacts:[that JSON], fitnessSignal:{quality:0.9} }
```

**Follow-up:** VENOM may dispatch to Cursor: "patch systemd unit per Claw's recommendation." That second dispatch hits PACT path rules (must touch `systemd/*` → see `paths.allow`).

---

## 22.6 Skills

```ts
skills: [
  'system.diagnose',    // why is X happening?
  'system.logs',        // read and analyze logs
  'system.health',      // heartbeat: df, free, uptime, ps
  'system.processes',   // process table, resource usage
]
```

Claw is NOT a general-purpose shell. It is a diagnostic instrument. Every tool produces structured output. No raw terminal access.

🐙
