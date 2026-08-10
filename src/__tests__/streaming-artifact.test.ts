/**
 * Regression test: streaming JSON-RPC `message/stream` must NOT crash
 * on artifact-update events after the v1.0 SDK's v0.3 compat layer.
 *
 * Background (see ~/.fang-handoff/a2a-stream-length-20260810-223400.md):
 *   toCompatArtifact → nonEmptyArray2(coreArtifact.extensions) threw
 *   "Cannot read properties of undefined (reading 'length')" because
 *   inline `artifact: { artifactId, name, parts }` literals in
 *   src/server.ts lacked `extensions: []`.
 *   prod fix 08b3ea6 introduced `agentArtifact()` helper.
 *
 * Approach: boot a real fang server via createFangServer (gets the full
 * agent card with all v1.0 required fields), then reach past the SDK's
 * private fields to replace `agentExecutor` with one that publishes an
 * artifactUpdate mid-stream. This drives the full legacy compat path
 * end-to-end without needing a real CLI process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  Role,
  TaskState,
  type Task,
} from '@a2a-js/sdk';
import type { RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';

import { createFangServer } from '../server.ts';
import type { AgentAdapter, FangConfig } from '../core.ts';
import type { TaskEventStore } from '../task-event-store.ts';

// ─── Stub adapter ─────────────────────────────────────────────────────────
class StubAdapter implements AgentAdapter {
  readonly id = 'stub';
  readonly binary = 'sleep 30';
  readonly tier = 3 as const;
  readonly displayName = 'Stub';
  readonly mode = 'oneshot' as const;
  skills = [{ id: 'noop', name: 'noop', tags: [] }];
  buildArgs(): string[] { return []; }
  formatInput(): string { return ''; }
  parseLine(): [] { return []; }
  async detect(): Promise<null> { return null; }
}

// ─── Test executor ────────────────────────────────────────────────────────
class ArtifactEmitExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;

    // The SDK requires an initial Task or Message event before any
    // artifactUpdate/statusUpdate (stream pattern state machine).
    // We seed a minimal Task event here. Note: must include BOTH
    // `history: []` AND `artifacts: []` — toCompatTask in the SDK's
    // v0.3 compat layer reads `.length` on both without optional
    // chaining (see express/index.js ~line 2726).
    bus.publish({
      kind: 'task',
      data: {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: new Date().toISOString(),
          message: {
            messageId: randomUUID(),
            role: Role.ROLE_AGENT,
            parts: [],
            contextId,
            taskId,
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
        },
        history: [],
        artifacts: [],
        metadata: {},
      },
    });

    // Full-v1.0-shaped artifactUpdate (the kind 08b3ea6 fixed).
    bus.publish({
      kind: 'artifactUpdate',
      data: {
        taskId,
        contextId,
        artifact: {
          artifactId: 'test-artifact',
          name: 'output',
          description: '',
          parts: [
            {
              content: { $case: 'text', value: 'streaming-ok' },
              metadata: undefined,
              filename: '',
              mediaType: 'text/plain',
            },
          ],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      },
    });

    // Final agent message so the SDK closes the stream.
    bus.publish({
      kind: 'message',
      data: {
        messageId: randomUUID(),
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: 'text', value: 'done' }, filename: '', mediaType: '', metadata: {} }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
    });
  }
}

interface Booted {
  url: string;
  events: TaskEventStore;
  taskStore: { save(t: Task, ctx: unknown): Promise<void>; load(id: string, ctx: unknown): Promise<Task | undefined> };
  close: () => Promise<void>;
}

async function boot(): Promise<Booted> {
  const adapter = new StubAdapter();
  const cfg: FangConfig & { adapter: AgentAdapter } = {
    cli: 'sleep 30',
    port: 0,
    adapter,
    name: 'streaming-test',
    workdir: process.cwd(),
  };
  const { setupApp, requestHandler, executor } = createFangServer(cfg);

  // Reach past private fields to swap the executor with our artifact
  // emitter. fang's BridgeExecutor is `private readonly` but is an
  // ordinary property at runtime — see server-v1-compliance.test.ts for
  // the same pattern.
  const handlerInternals = requestHandler as unknown as {
    agentExecutor: { execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> };
  };
  handlerInternals.agentExecutor = new ArtifactEmitExecutor();

  const app: express.Express = express();
  setupApp(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    events: executor.events,
    taskStore: (requestHandler as unknown as { taskStore: Booted['taskStore'] }).taskStore,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Read SSE blocks until the stream ends or the deadline is hit. */
async function readSseAll(res: Response, maxMs = 5_000): Promise<Array<{ event: string | null; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out: Array<{ event: string | null; data: unknown }> = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event: string | null = null;
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        try { out.push({ event, data: JSON.parse(data) }); }
        catch { /* ignore non-JSON */ }
      }
      sep = buf.indexOf('\n\n');
    }
  }
  try { await reader.cancel(); } catch {}
  return out;
}

describe('message/stream (legacy v0.3 JSON-RPC) regression — artifactUpdate must not crash compat', () => {
  let booted: Booted;
  beforeEach(async () => { booted = await boot(); });
  afterEach(async () => { await booted.close(); });

  it('emits artifact-update through the v0.3 compat layer without reading-undefined-length error', async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    let res: Response;
    try {
      res = await fetch(`${booted.url}/a2a/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'stream-1',
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              role: 'user',
              messageId: 'stream-msg-1',
              parts: [{ kind: 'text', text: 'go' }],
            },
          },
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

    const events = await readSseAll(res, 5_000);

    // Negative regression: NO `event: error` carrying the regression message.
    const regressionErr = events.find(
      (e) => e.event === 'error'
        && typeof e.data === 'object'
        && e.data !== null
        && 'error' in (e.data as Record<string, unknown>)
        && String((e.data as { error: { message?: string } }).error?.message ?? '')
          .includes('reading'),
    );
    expect(
      regressionErr,
      'streaming must not emit v0.3 compat crash on artifactUpdate',
    ).toBeUndefined();

    // Positive: at least one artifact-update payload made it through.
    // The v0.3 wire shape uses `kind: 'artifact-update'`.
    const artifactPayloads = events
      .map((e) => (typeof e.data === 'object' && e.data !== null
        ? (e.data as { result?: { kind?: string } }).result
        : undefined))
      .filter((r) => r?.kind === 'artifact-update');
    expect(artifactPayloads.length).toBeGreaterThanOrEqual(1);

    // And the artifact payload preserved our full v1.0 envelope (extensions).
    // The v0.3 wire shape uses nonEmptyArray semantics — empty arrays
    // are stripped. So `extensions` is either an array (when non-empty)
    // or absent. Critically, it is NOT undefined.length (which is the
    // pre-fix crash). Either branch is fine.
    const first = artifactPayloads[0] as { artifact?: { extensions?: unknown[]; parts?: Array<{ text?: string }> } };
    expect(first?.artifact?.parts?.[0]?.text).toBe('streaming-ok');
    expect(
      first?.artifact?.extensions === undefined
      || Array.isArray(first.artifact.extensions),
    ).toBe(true);
  });
});