/**
 * Tests for @fangai/core — JSONL reader, ProcessManager, PersistentProcess, Detector
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  attachJsonlReader,
  ProcessManager,
  PersistentProcess,
  detectAdapters,
} from '../core.ts';
import type { AgentAdapter, DetectionResult } from '../core.ts';

// Helper: create a Readable, attach reader, then push data on next tick
function createStreamAndPush(...chunks: (string | null)[]): { stream: Readable; detach: () => void; lines: string[] } {
  const stream = new Readable({ read() {} });
  const lines: string[] = [];
  const detach = attachJsonlReader(stream, (line) => lines.push(line));
  // Defer all pushes so the listener is attached first
  process.nextTick(() => {
    for (const chunk of chunks) {
      if (chunk === null) { stream.push(null); }
      else { stream.push(chunk); }
    }
  });
  return { stream, detach, lines };
}

// ─── attachJsonlReader ─────────────────────────────────────────────────────

describe('attachJsonlReader', () => {
  it('splits on LF only', async () => {
    const { lines, detach } = createStreamAndPush('line1\nline2\nline3\n', null);
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual(['line1', 'line2', 'line3']);
    detach();
  });

  it('handles CRLF input by stripping CR', async () => {
    const { lines, detach } = createStreamAndPush('hello\r\nworld\r\n', null);
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual(['hello', 'world']);
    detach();
  });

  it('does NOT split on U+2028 and U+2029 (unlike Node readline)', async () => {
    const text = `{"msg":"line1\u2028line2"}\n{"msg":"line3\u2029line4"}\n`;
    const { lines, detach } = createStreamAndPush(text, null);
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"msg":"line1\u2028line2"}');
    expect(lines[1]).toBe('{"msg":"line3\u2029line4"}');
    detach();
  });

  it('handles buffered partial lines across multiple chunks', async () => {
    const stream = new Readable({ read() {} });
    const lines: string[] = [];
    const detach = attachJsonlReader(stream, (line) => lines.push(line));
    process.nextTick(() => {
      stream.push('hel');
      stream.push('lo\nwor');
      stream.push('ld\n');
      stream.push(null);
    });
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual(['hello', 'world']);
    detach();
  });

  it('emits remaining buffer on end', async () => {
    const { lines, detach } = createStreamAndPush('trailing', null);
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual(['trailing']);
    detach();
  });

  it('ignores empty lines', async () => {
    const { lines, detach } = createStreamAndPush('\n\nhello\n\n\nworld\n\n', null);
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual(['hello', 'world']);
    detach();
  });

  it('cleanup function removes listeners', async () => {
    const stream = new Readable({ read() {} });
    const lines: string[] = [];
    const detach = attachJsonlReader(stream, (line) => lines.push(line));
    detach();
    process.nextTick(() => {
      stream.push('after-detach\n');
      stream.push(null);
    });
    await new Promise(r => setTimeout(r, 50));
    expect(lines).toEqual([]);
  });
});

// ─── ProcessManager ────────────────────────────────────────────────────────

describe('ProcessManager', () => {
  let pm: ProcessManager;

  beforeEach(() => { pm = new ProcessManager(); });
  afterEach(async () => { await pm.killAll(1000); });

  it('spawns a process and captures stdout via JSONL reader', async () => {
    const lines: string[] = [];
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      pm.spawn('test-1', 'echo', ['hello'], {}, {
        onLine: (line) => lines.push(line),
        onError: () => {},
        onExit: (code, signal) => resolve({ code, signal }),
      });
    });

    const { code } = await exitPromise;
    expect(code).toBe(0);
    expect(lines).toContain('hello');
  });

  it('captures stderr', async () => {
    const errors: string[] = [];
    await new Promise<void>((resolve) => {
      pm.spawn('test-2', 'bash', ['-c', 'echo err >&2'], {}, {
        onLine: () => {},
        onError: (text) => errors.push(text),
        onExit: () => resolve(),
      });
    });
    expect(errors.some(e => e.includes('err'))).toBe(true);
  });

  it('reports non-zero exit code', async () => {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      pm.spawn('test-3', 'bash', ['-c', 'exit 42'], {}, {
        onLine: () => {},
        onError: () => {},
        onExit: (code, signal) => resolve({ code, signal }),
      });
    });
    expect(result.code).toBe(42);
  });

  it('kills a process with SIGTERM', async () => {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      pm.spawn('test-4', 'sleep', ['60'], {}, {
        onLine: () => {},
        onError: () => {},
        onExit: (code, signal) => resolve({ code, signal }),
      });
      setTimeout(() => pm.kill('test-4', 500), 50);
    });
    expect(result.signal).toBe('SIGTERM');
  });

  it('escalates to SIGKILL after timeout', async () => {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      pm.spawn('test-5', 'bash', ['-c', 'trap "" TERM; sleep 60'], {}, {
        onLine: () => {},
        onError: () => {},
        onExit: (code, signal) => resolve({ code, signal }),
      });
      setTimeout(() => pm.kill('test-5', 200), 50);
    });
    expect(result.signal).toBe('SIGKILL');
  }, 10000);

  it('killAll waits for all processes to exit', async () => {
    const exits: string[] = [];
    pm.spawn('a', 'sleep', ['5'], {}, {
      onLine: () => {},
      onError: () => {},
      onExit: () => exits.push('a'),
    });
    pm.spawn('b', 'sleep', ['5'], {}, {
      onLine: () => {},
      onError: () => {},
      onExit: () => exits.push('b'),
    });
    await pm.killAll(1000);
    expect(exits).toHaveLength(2);
  });

  it('has() and get() track processes', () => {
    pm.spawn('test-x', 'sleep', ['5'], {}, {
      onLine: () => {},
      onError: () => {},
      onExit: () => {},
    });
    expect(pm.has('test-x')).toBe(true);
    expect(pm.has('nonexistent')).toBe(false);
    expect(pm.get('test-x')).toBeDefined();
    expect(pm.get('nonexistent')).toBeUndefined();
  });
});

// ─── PersistentProcess ────────────────────────────────────────────────────

describe('PersistentProcess', () => {
  let pp: PersistentProcess;

  afterEach(async () => {
    if (pp) await pp.kill();
  });

  it('spawns and detects liveness', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();
    expect(pp.isAlive).toBe(true);
  });

  it('sends input and receives output', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    const received: string[] = [];
    const outputPromise = new Promise<void>((resolve) => {
      pp.setLineHandler('task-1', (line) => {
        received.push(line);
        if (received.length >= 1) resolve();
      });
    });

    pp.write('hello from test\n');
    await outputPromise;
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toContain('hello from test');
  });

  it('routes lines only to active task', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    const task1Lines: string[] = [];
    const task2Lines: string[] = [];

    pp.setLineHandler('task-1', (line) => task1Lines.push(line));
    pp.write('for task-1\n');
    await new Promise(r => setTimeout(r, 100));

    pp.removeLineHandler('task-1');
    pp.setLineHandler('task-2', (line) => task2Lines.push(line));
    pp.write('for task-2\n');
    await new Promise(r => setTimeout(r, 100));

    expect(task1Lines.some(l => l.includes('for task-1'))).toBe(true);
    expect(task2Lines.some(l => l.includes('for task-2'))).toBe(true);
    expect(task2Lines.some(l => l.includes('for task-1'))).toBe(false);
  });

  it('writeWhenActive defers stdin for queued tasks until promotion', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    const lines1: string[] = [];
    const lines2: string[] = [];

    pp.setLineHandler('t1', line => lines1.push(line));
    pp.writeWhenActive('t1', 'immediate\n');
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    pp.setLineHandler('t2', line => lines2.push(line));
    pp.writeWhenActive('t2', 'deferred-until-promoted\n');
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    expect(lines2.some(l => l.includes('deferred-until-promoted'))).toBe(false);

    pp.removeLineHandler('t1');
    await new Promise<void>(resolve => setTimeout(resolve, 150));

    expect(lines1.some(l => l.includes('immediate'))).toBe(true);
    expect(lines2.some(l => l.includes('deferred-until-promoted'))).toBe(true);
  });

  it('notifies handlers on unexpected process death', async () => {
    const crashInfo: { id: string; count: number }[] = [];
    pp = new PersistentProcess('cat', [], {}, {
      onCrash: (id, count) => { crashInfo.push({ id, count }); },
    });
    await pp.ensure();

    // Set up a task handler
    pp.setLineHandler('task-crash', () => {});

    // Simulate crash by killing the underlying process directly
    // (not via pp.kill(), which is a graceful shutdown)
    const proc = (pp as any).proc as import('node:child_process').ChildProcess;
    proc.kill('SIGKILL');

    // Wait for exit event to fire
    await new Promise(r => setTimeout(r, 200));

    // The onCrash callback should have fired
    expect(crashInfo.length).toBeGreaterThanOrEqual(1);
    expect(crashInfo[0].id).toBe('task-crash');
  });

  it('auto-responds to Pi extension UI requests', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    const received: string[] = [];
    pp.setLineHandler('task-ui', (line) => received.push(line));

    pp.write('{"type":"extension_ui_request","id":"ui-1","method":"confirm","message":"Continue?"}\n');
    await new Promise(r => setTimeout(r, 200));

    // Process should still be alive (didn't hang)
    expect(pp.isAlive).toBe(true);
  });

  it('treats the first extension_ui_request (ui.notify) as the ready signal', async () => {
    // Pi's loaded extensions emit a ui.notify as the very first stdout frame
    // after RPC mode starts. waitUntilReady() must unblock on that frame —
    // otherwise fangai's server.ts:187 throws "Persistent process did not
    // become ready within 30s" even though pi is healthy.
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    const ready = pp.waitUntilReady(2_000);
    // Simulate pi's init notify frame
    pp.write('{"type":"extension_ui_request","id":"n1","method":"notify","message":"A2A communication initialized","notifyType":"info"}\n');

    await ready; // must resolve, not reject
    expect((pp as any).readyEmitted).toBe(true);
  });

  it('signalReadyDone is idempotent — second extension_ui_request does not double-fire', async () => {
    pp = new PersistentProcess('cat', [], {});
    await pp.ensure();

    pp.write('{"type":"extension_ui_request","id":"n1","method":"notify","message":"first","notifyType":"info"}\n');
    await pp.waitUntilReady(2_000);
    const firstEmitted = (pp as any).readyEmitted;
    expect(firstEmitted).toBe(true);

    pp.write('{"type":"extension_ui_request","id":"u2","method":"confirm","message":"Continue?"}\n');
    await new Promise(r => setTimeout(r, 100));
    // Still alive after the second one; readyEmitted stays true and not reset.
    expect(pp.isAlive).toBe(true);
    expect((pp as any).readyEmitted).toBe(true);
  });
});

// ─── detectAdapters ────────────────────────────────────────────────────────

describe('detectAdapters', () => {
  it('filters out null detections', async () => {
    const mockAdapter: AgentAdapter = {
      id: 'mock',
      binary: 'nonexistent-binary-xyz',
      tier: 3,
      displayName: 'Mock',
      mode: 'oneshot',
      skills: [],
      buildArgs: () => [],
      formatInput: () => '',
      parseLine: () => [],
      detect: async () => null,
    };

    const results = await detectAdapters([mockAdapter]);
    expect(results).toHaveLength(0);
  });

  it('returns sorted by tier', async () => {
    const adapters: AgentAdapter[] = [
      {
        id: 'tier3', binary: '', tier: 3, displayName: 'T3', mode: 'oneshot',
        skills: [], buildArgs: () => [], formatInput: () => '', parseLine: () => [],
        detect: async () => ({ binary: 't3', version: '1.0.0', path: '/t3', tier: 3, protocol: 'text' }),
      },
      {
        id: 'tier1', binary: '', tier: 1, displayName: 'T1', mode: 'oneshot',
        skills: [], buildArgs: () => [], formatInput: () => '', parseLine: () => [],
        detect: async () => ({ binary: 't1', version: '1.0.0', path: '/t1', tier: 1, protocol: 'json' }),
      },
    ];

    const results = await detectAdapters(adapters);
    expect(results).toHaveLength(2);
    expect(results[0].adapter.tier).toBe(1);
    expect(results[1].adapter.tier).toBe(3);
  });
});
