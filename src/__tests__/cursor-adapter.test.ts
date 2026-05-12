/**
 * Tests for CursorAgentAdapter — the v2 cursor-agent CLI adapter
 */
import { describe, it, expect } from 'vitest';
import { detectAdapter as detectAdapterV2 } from '../adapters.ts';
import { CursorAgentAdapter, CursorSessionStore } from '../cursor-adapter.ts';
import type { AgentTask, FangConfig } from '../core.ts';

const dummyTask: AgentTask = { id: 'test-1', message: 'fix the bug in auth.ts' };
const dummyConfig: FangConfig = { cli: 'cursor-agent', port: 3003 };

// ─── CursorSessionStore ──────────────────────────────────────────────────

describe('CursorSessionStore', () => {
  it('registers and retrieves sessions', () => {
    const store = new CursorSessionStore();
    store.register('sess-1', '/workspace', 'composer-2-fast');
    const session = store.get('sess-1');
    expect(session).toBeDefined();
    expect(session!.id).toBe('sess-1');
    expect(session!.workspace).toBe('/workspace');
    expect(session!.model).toBe('composer-2-fast');
    expect(session!.turnCount).toBe(1);
  });

  it('increments turnCount on re-register', () => {
    const store = new CursorSessionStore();
    store.register('sess-1', '/ws', 'model');
    store.register('sess-1', '/ws', 'model');
    expect(store.get('sess-1')!.turnCount).toBe(2);
  });

  it('tracks lastSession', () => {
    const store = new CursorSessionStore();
    store.register('sess-1', '/ws', 'model');
    expect(store.lastSession).toBe('sess-1');
    store.register('sess-2', '/ws', 'model');
    expect(store.lastSession).toBe('sess-2');
  });

  it('clears all sessions', () => {
    const store = new CursorSessionStore();
    store.register('s1', '', '');
    store.register('s2', '', '');
    store.clear();
    expect(store.lastSession).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('expireLastSessionIfStale drops session and queues recap when turns exist', () => {
    const store = new CursorSessionStore({ sessionTtlMs: 60_000 });
    store.register('sess-old', '/w', 'm');
    store.recordCompletedTurn('sess-old', 'user says', 'assistant says');
    const sess = store.get('sess-old')!;
    sess.lastUsedAt = new Date(Date.now() - 120_000);

    store.expireLastSessionIfStale();
    expect(store.lastSession).toBeNull();
    expect(store.get('sess-old')).toBeUndefined();

    const recap = store.consumeColdRecap();
    expect(recap).toContain('user says');
    expect(recap).toContain('assistant says');
    expect(store.consumeColdRecap()).toBeNull();
  });

  it('expireLastSessionIfStale clears stale session without recap when no turns', () => {
    const store = new CursorSessionStore({ sessionTtlMs: 1000 });
    store.register('sess-x', '/w', 'm');
    const sess = store.get('sess-x')!;
    sess.lastUsedAt = new Date(Date.now() - 5000);

    store.expireLastSessionIfStale();
    expect(store.lastSession).toBeNull();
    expect(store.consumeColdRecap()).toBeNull();
  });
});

// ─── CursorAgentAdapter ──────────────────────────────────────────────────

describe('CursorAgentAdapter', () => {
  describe('with streamPartial=true (default)', () => {
    const adapter = new CursorAgentAdapter({ streamPartial: true });

    it('has correct metadata', () => {
      expect(adapter.id).toBe('cursor-agent');
      expect(adapter.tier).toBe(1);
      expect(adapter.mode).toBe('oneshot');
    });

    it('parses assistant with timestamp_ms (streaming delta)', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'assistant',
        timestamp_ms: 12345,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from cursor' }],
        },
      }));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text-delta');
      if (events[0].type === 'text-delta') expect(events[0].text).toBe('Hello from cursor');
    });

    it('skips consolidated assistant without timestamp_ms when streaming', () => {
      // This is the dedup logic — when streaming, the final consolidated
      // event (no timestamp_ms) is a duplicate of streamed deltas
      const events = adapter.parseLine(JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Consolidated text' }],
        },
      }));
      expect(events).toHaveLength(0);
    });

    it('parses system init and registers session', () => {
      const store = new CursorSessionStore();
      const adapterWithStore = new CursorAgentAdapter({ sessionStore: store, streamPartial: true });
      const events = adapterWithStore.parseLine(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc',
        cwd: '/project',
        model: 'composer-2',
      }));
      expect(events).toHaveLength(0);
      expect(store.lastSession).toBe('sess-abc');
      expect(store.get('sess-abc')!.workspace).toBe('/project');
    });

    it('ignores user echo events', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
      }));
      expect(events).toHaveLength(0);
    });

    it('parses result success as completed', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 5000,
      }));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status');
      if (events[0].type === 'status') expect(events[0].state).toBe('completed');
    });

    it('parses result error as error event', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'result',
        subtype: 'error',
        result: 'Something went wrong',
      }));
      expect(events[0].type).toBe('error');
    });

    it('parses tool_call started', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { shellToolCall: { args: { command: 'ls', description: 'List files' } } },
      }));
      expect(events[0].type).toBe('tool-call');
      if (events[0].type === 'tool-call') expect(events[0].tool).toBe('shell');
    });

    it('parses tool_call completed with stdout', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          shellToolCall: {
            args: { command: 'echo hello' },
            result: { success: { stdout: 'hello', stderr: '' } },
          },
        },
      }));
      // Should emit text-delta for stdout + tool-result
      expect(events.length).toBeGreaterThanOrEqual(1);
      const toolResult = events.find(e => e.type === 'tool-result');
      expect(toolResult).toBeDefined();
      if (toolResult?.type === 'tool-result') expect(toolResult.output).toBe('hello');
    });

    it('parses error events', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'error',
        message: 'Cursor agent crashed',
      }));
      expect(events[0].type).toBe('error');
      if (events[0].type === 'error') expect(events[0].message).toBe('Cursor agent crashed');
    });

    it('parses status events as working', () => {
      const events = adapter.parseLine(JSON.stringify({ type: 'status' }));
      expect(events[0].type).toBe('status');
      if (events[0].type === 'status') expect(events[0].state).toBe('working');
    });

    it('returns empty for blank lines', () => {
      expect(adapter.parseLine('')).toHaveLength(0);
      expect(adapter.parseLine('   ')).toHaveLength(0);
    });

    it('skips --continue after TTL expiry', () => {
      const store = new CursorSessionStore({ sessionTtlMs: 1 });
      store.register('old', '/w', 'm');
      store.get('old')!.lastUsedAt = new Date(Date.now() - 10_000);

      const adapter = new CursorAgentAdapter({ sessionStore: store, streamPartial: true });
      const args = adapter.buildArgs(dummyTask, dummyConfig);
      expect(args).not.toContain('--continue');
    });

    it('prepends cold recap in formatInput after TTL expiry', () => {
      const store = new CursorSessionStore({ sessionTtlMs: 1 });
      store.register('old', '/w', 'm');
      store.recordCompletedTurn('old', 'ping', 'pong');
      store.get('old')!.lastUsedAt = new Date(Date.now() - 10_000);

      const adapter = new CursorAgentAdapter({ sessionStore: store, streamPartial: true });
      adapter.buildArgs(dummyTask, dummyConfig);
      const stdin = adapter.formatInput(dummyTask);
      expect(stdin).toContain('ping');
      expect(stdin).toContain('pong');
      expect(stdin).toContain('fix the bug in auth.ts');
    });

    it('discards cold recap when metadata.newChat is true', () => {
      const store = new CursorSessionStore({ sessionTtlMs: 1 });
      store.register('old', '/w', 'm');
      store.recordCompletedTurn('old', 'a', 'b');
      store.get('old')!.lastUsedAt = new Date(Date.now() - 10_000);

      const adapter = new CursorAgentAdapter({ sessionStore: store, streamPartial: true });
      const task: AgentTask = {
        id: 't2',
        message: 'fresh',
        context: { metadata: { newChat: true } },
      };
      adapter.buildArgs(task, dummyConfig);
      const stdin = adapter.formatInput(task);
      expect(stdin).toBe('fresh\n');
    });

    it('records completed turns for recap', () => {
      const store = new CursorSessionStore();
      const adapter = new CursorAgentAdapter({ sessionStore: store, streamPartial: true });
      adapter.formatInput(dummyTask);
      adapter.parseLine(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 's-recap', cwd: '/p', model: 'm',
      }));
      adapter.parseLine(JSON.stringify({
        type: 'assistant',
        timestamp_ms: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }));
      adapter.parseLine(JSON.stringify({ type: 'result', subtype: 'success' }));

      const s = store.get('s-recap');
      expect(s?.turns).toHaveLength(1);
      expect(s?.turns[0]?.user).toContain('fix the bug');
      expect(s?.turns[0]?.assistant).toBe('done');
    });
  });

  describe('with streamPartial=false (oneshot without streaming)', () => {
    const adapter = new CursorAgentAdapter({ streamPartial: false });

    it('emits assistant message without timestamp_ms when not streaming', () => {
      // This is the KEY bug fix — without streaming, the assistant event
      // is the ONLY response. Must emit it.
      const events = adapter.parseLine(JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The fix for auth.ts' }],
        },
      }));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text-delta');
      if (events[0].type === 'text-delta') expect(events[0].text).toBe('The fix for auth.ts');
    });

    it('emits assistant with thinking blocks', () => {
      const events = adapter.parseLine(JSON.stringify({
        type: 'assistant',
        timestamp_ms: 999,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me analyze...' },
            { type: 'text', text: 'Here is the answer' },
          ],
        },
      }));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('thinking');
      expect(events[1].type).toBe('text-delta');
    });

    it('emits assistant with timestamp_ms too', () => {
      // When not streaming, ALL assistant events are real — emit them all
      const events = adapter.parseLine(JSON.stringify({
        type: 'assistant',
        timestamp_ms: 12345,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Streamed delta text' }],
        },
      }));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text-delta');
      if (events[0].type === 'text-delta') expect(events[0].text).toBe('Streamed delta text');
    });
  });
});

describe('detectAdapter with cursor-agent', () => {
  it('detects cursor-agent via fallback', () => {
    const adapter = detectAdapterV2('cursor-agent --print');
    expect(['cursor-agent']).toContain(adapter.id);
  });
});
