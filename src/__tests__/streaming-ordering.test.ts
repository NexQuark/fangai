/**
 * Regression test: streaming JSON-RPC `message/stream` must NOT emit a
 * "Stream ordering violation" error after the initial task event.
 *
 * Background (see ~/.fang-handoff/stream-message-ordering-20260810-231410.md
 * and commit eac1398): The SDK's v1.0 stream pattern state machine
 * (`_advanceStreamPattern` in @a2a-js/sdk/dist/server/index.js) requires
 * that after the initial `task` event, only `statusUpdate` and
 * `artifactUpdate` events may follow. fang's executor used to publish
 * a final `message` event, which the SDK rejected with
 * `Stream ordering violation: received message in task lifecycle stream.`
 *
 * prod fix eac1398: replaced all 4 `pub('message', ...)` calls with
 * terminal `pub('statusUpdate', { status: { state, message, timestamp } })`
 * calls. The final statusUpdate carries the agent message text in
 * `status.message.parts`.
 *
 * Boundary:
 *   - Drive a real `/a2a/jsonrpc` `message/stream` request end-to-end
 *   - Test executor publishes: Task event → artifactUpdate → statusUpdate(working)
 *     → statusUpdate(completed, message=...)
 *   - Assert NO `event: error` carrying "ordering violation"
 *   - Assert the FINAL statusUpdate has state in {completed, failed, canceled}
 *     AND its status.message.parts contain the expected text
 *   - Tolerate the trailing `event: end` shape on /tasks/:id/events
 *     (the test uses /a2a/jsonrpc, not the SSE endpoint)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  DefaultRequestHandler,
} from '@a2a-js/sdk/server';
import {
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import {
  Role,
  TaskState,
  type Task,
} from '@a2a-js/sdk';
import type { RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import { FangTaskStore } from '../fang-task-store.ts';

// ─── Test executor ────────────────────────────────────────────────────────
// Mimics what fang's prod executor does post-fix eac1398:
//   1. Publish initial Task event (stream → task-lifecycle pattern)
//   2. Publish artifactUpdate (allowed in task-lifecycle)
//   3. Publish statusUpdate(working) (allowed in task-lifecycle)
//   4. Publish TERMINAL statusUpdate(completed, message=...) — NOT a `message` event
class OrderingTestExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    const replyText = 'ordering-test-reply';

    // Initial Task event — full v1.0 shape (history, artifacts, message all present).
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

    // Mid-stream artifact update — must use full envelope (08b3ea6 fix shape).
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
              content: { $case: 'text', value: 'mid-stream-chunk' },
              metadata: {},
              filename: '',
              mediaType: 'text/plain',
            },
          ],
          metadata: {},
          extensions: [],
        },
        append: false,
        lastChunk: false,
        metadata: {},
      },
    });

    // Intermediate status update (working) — also allowed in task-lifecycle.
    bus.publish({
      kind: 'statusUpdate',
      data: {
        taskId,
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
        metadata: {},
      },
    });

    // TERMINAL status update with the agent message text inside.
    // This is the post-eac1398 fix shape: NOT a standalone `message` event,
    // but a `statusUpdate` with `status.message` carrying the reply.
    bus.publish({
      kind: 'statusUpdate',
      data: {
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          timestamp: new Date().toISOString(),
          message: {
            messageId: randomUUID(),
            role: Role.ROLE_AGENT,
            parts: [
              { content: { $case: 'text', value: replyText }, filename: '', mediaType: '', metadata: {} },
            ],
            contextId,
            taskId,
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
        },
        metadata: {},
      },
    });
  }
}

const TEST_AGENT_CARD = {
  name: 'streaming-ordering-test',
  description: 'streaming ordering regression fixture',
  version: '1.0.0',
  url: 'http://localhost',
  skills: [
    { id: 'noop', name: 'noop', tags: [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] },
  ],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
  },
  supportedInterfaces: [
    { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' },
    { protocolBinding: 'JSONRPC', protocolVersion: '0.3', url: 'http://localhost' },
  ],
  signatures: [],
  provider: undefined,
  securityRequirements: [],
  securitySchemes: {},
} as unknown as ConstructorParameters<typeof DefaultRequestHandler>[0];

interface Booted { url: string; close: () => Promise<void>; }

async function boot(): Promise<Booted> {
  const taskStore = new FangTaskStore();
  const executor = new OrderingTestExecutor();
  // Cast through `unknown` to bypass strict private-constructor typing on
// DefaultRequestHandler — see server-v1-compliance.test.ts for the same pattern.
const handler = new (DefaultRequestHandler as new (
  card: typeof TEST_AGENT_CARD,
  store: typeof taskStore,
  exec: { execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> },
) => InstanceType<typeof DefaultRequestHandler>)(TEST_AGENT_CARD, taskStore, executor);

  const app = express();
  app.use('/a2a/jsonrpc', jsonRpcHandler({
    requestHandler: handler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true },
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

describe('message/stream ordering — terminal statusUpdate replaces final message event', () => {
  let booted: Booted;
  beforeEach(async () => { booted = await boot(); });
  afterEach(async () => { await booted.close(); });

  it('emits a terminal statusUpdate(state=completed) with message.parts instead of a standalone message event', async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    let res: Response;
    try {
      res = await fetch(`${booted.url}/a2a/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'order-1',
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              role: 'user',
              messageId: 'order-msg-1',
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

    // Negative regression: NO ordering violation error.
    const orderingErr = events.find(
      (e) => e.event === 'error'
        && typeof e.data === 'object'
        && e.data !== null
        && 'error' in (e.data as Record<string, unknown>)
        && String((e.data as { error: { message?: string } }).error?.message ?? '')
          .includes('ordering violation'),
    );
    expect(orderingErr, 'streaming must not emit ordering violation after terminal statusUpdate').toBeUndefined();

    // Positive: a terminal statusUpdate must have arrived carrying the reply.
    // The v0.3 wire shape uses `kind: 'status-update'` with status.state.
    const statusUpdates = events
      .map((e) => (typeof e.data === 'object' && e.data !== null
        ? (e.data as { result?: { kind?: string; status?: { state?: number | string; message?: { parts?: Array<{ text?: string; content?: { value?: string } }> } } } }).result
        : undefined))
      .filter((r) => r?.kind === 'status-update');

    const terminal = statusUpdates.find(
      (s) => s?.status?.state === TaskState.TASK_STATE_COMPLETED
        || s?.status?.state === 'completed',
    );
    expect(terminal, 'a terminal statusUpdate(completed) must be present').toBeDefined();

    // The terminal statusUpdate.message.parts must carry the reply text.
    // The v0.3 wire uses {kind:'text', text:'...'} part shape.
    const parts = terminal?.status?.message?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? p.content?.value ?? '')
      .join('');
    expect(text).toBe('ordering-test-reply');
  });
});