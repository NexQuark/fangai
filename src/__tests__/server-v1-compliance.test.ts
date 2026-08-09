/**
 * @file A2A v1.0.1 compliance tests for the fangai HTTP surface.
 *
 * Spec sources:
 *   - spec/01-A2A-HTTP-PROFILE.md     (endpoint inventory)
 *   - spec/02-TASK-LIFECYCLE.md       (states, transitions)
 *   - spec/07-ERRORS-CANCELLATION.md  (cancel protocol + error codes)
 *   - spec/a2a-v1/MIGRATION-fangai.md (0.3.0 → 1.0 deltas)
 *   - @a2a-js/sdk@1.0.1 AgentCard     (securitySchemes, securityRequirements,
 *                                       supportedInterfaces[*].protocolVersion)
 *
 * These tests are intentionally written against the spec rather than the
 * current (v0.3.0-era) implementation. The single test that pins the prod
 * code (`agentCard.protocolVersion === '1.0'`) is expected to fail until the
 * migration in spec/a2a-v1/MIGRATION-fangai.md is complete. That is the
 * point of TDD here — capture the delta as a failing assertion, then make
 * it green during the upgrade.
 *
 * Important: NO production code in src/ is modified by these tests.
 *
 * Task-seeding strategy: the current `BridgeExecutor` (src/server.ts)
 * publishes events in v0.3 shape (`{kind: 'task', id, contextId, ...}`),
 * but @a2a-js/sdk@1.0.1's `ResultManager.processEvent` reads them in v1.0
 * shape (`{kind: 'task', data: {id, contextId, ...}}`) and throws
 * `TypeError: Cannot read properties of undefined (reading 'id'/'status')`.
 * As a result, calling `requestHandler.sendMessage(...)` either:
 *   (a) with `true`/`echo` (fast CLI): returns a bare Message (not a Task)
 *       because the executor finishes before the SDK can stash a Task, OR
 *   (b) with `sleep N` (long-running CLI): hangs forever because the
 *       executor never settles, so the SDK's event bus never finishes.
 * Neither outcome is usable for testing the HTTP endpoints, so these
 * tests bypass `sendMessage` and write directly to the shared `taskStore`
 * (and the per-task `events` store for SSE) using reflection on the
 * SDK's private fields. This keeps the HTTP endpoint tests independent
 * of the executor's broken event shape — a separate set of executor-
 * level tests will be added once the event-shape migration lands.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, FangConfig } from '../core.ts';
import { createFangServer } from '../server.ts';
import { TaskState } from '@a2a-js/sdk';
import type { Task } from '@a2a-js/sdk';

// ─── Stub adapter ─────────────────────────────────────────────────────────

/**
 * A minimal AgentAdapter. The HTTP endpoint tests don't drive the executor,
 * so the CLI choice is mostly cosmetic — `sleep 30` is used so any leaked
 * process outlives the test (ProcessManager SIGKILLs after taskTimeout).
 */
class StubAdapter implements AgentAdapter {
  readonly id: string = 'stub';
  readonly binary: string;
  readonly tier: 1 | 2 | 3 = 3;
  readonly displayName: string = 'Stub Adapter';
  readonly mode: 'oneshot' | 'persistent' = 'oneshot';
  skills: Array<{ id: string; name: string; tags: string[] }> = [
    { id: 'code-edit', name: 'code-edit', tags: ['edit'] },
  ];

  constructor(opts: { cli?: string } = {}) {
    this.binary = opts.cli ?? 'sleep 30';
  }

  buildArgs(): string[] {
    return [];
  }

  formatInput(): string {
    return '';
  }

  parseLine(): [] {
    return [];
  }

  async detect(): Promise<null> {
    return null;
  }
}

// ─── HTTP test harness ────────────────────────────────────────────────────

interface BootedServer {
  server: Server;
  url: string;
  agentCard: ReturnType<typeof createFangServer>['agentCard'];
  requestHandler: ReturnType<typeof createFangServer>['requestHandler'];
  /** Internal — exposed via reflection. Use seedTask/seedEvents helpers. */
  readonly _internals: {
    taskStore: { save(t: Task): Promise<void>; load(id: string): Promise<Task | undefined> };
    events: { append(taskId: string, ev: unknown): number; read(taskId: string, fromSeq?: number): unknown[]; latestSeq(taskId: string): number };
  };
  close: () => Promise<void>;
}

async function boot(opts: {
  cli?: string;
  apiKey?: string;
  adapterMode?: 'oneshot' | 'persistent';
} = {}): Promise<BootedServer> {
  const cli = opts.cli ?? 'sleep 30';
  const adapter = new StubAdapter({ cli });
  const cfg: FangConfig & { adapter: AgentAdapter } = {
    cli,
    port: 0,
    adapter,
    name: 'fang-test',
    workdir: process.cwd(),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  };

  const { setupApp, agentCard, requestHandler } = createFangServer(cfg);
  const app: Express = express();
  setupApp(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  // The SDK's `DefaultRequestHandler` holds `taskStore` and `agentExecutor`
  // as `private readonly` fields. At runtime they are ordinary properties
  // — we access them via a narrow cast because we explicitly want to
  // bypass `sendMessage` (see file header for why).
  const internals = requestHandler as unknown as {
    taskStore: BootedServer['_internals']['taskStore'];
    agentExecutor: { events: BootedServer['_internals']['events'] };
  };

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    agentCard,
    requestHandler,
    _internals: {
      taskStore: internals.taskStore,
      events: internals.agentExecutor.events,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Save a task directly to the shared taskStore in the given state. */
async function seedTask(booted: BootedServer, state: TaskState, overrides: Partial<Task> = {}): Promise<Task> {
  const now = new Date().toISOString();
  const defaultStatus = { state, message: undefined, timestamp: now };
  const task: Task = {
    id: overrides.id ?? randomUUID(),
    contextId: overrides.contextId ?? randomUUID(),
    status: defaultStatus,
    artifacts: [],
    history: [],
    metadata: undefined,
    ...overrides,
  };
  // The spread above lets callers override any field including `status`,
  // but if they didn't we already set it via `defaultStatus`. Reset
  // `status` to the default after the spread so it isn't accidentally
  // overwritten by `overrides` keys that don't include it (defensive).
  if (overrides.status === undefined) task.status = defaultStatus;
  await booted._internals.taskStore.save(task);
  return task;
}

/** Append N synthetic events to the per-task SSE event log. */
function seedEvents(booted: BootedServer, taskId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    booted._internals.events.append(taskId, {
      kind: 'artifact-update',
      taskId,
      contextId: 'seed-ctx',
      artifact: {
        artifactId: 'stdout',
        name: 'output',
        parts: [{ kind: 'text', text: `chunk-${i}` }],
      },
      append: i > 0,
      lastChunk: i === count - 1,
    });
  }
}

/** Wait until /tasks/:id reports one of the expected states. */
async function waitForState(
  baseUrl: string,
  taskId: string,
  states: string[],
  maxMs = 2000,
): Promise<{ id: string; status: { state: string } }> {
  const deadline = Date.now() + maxMs;
  let last: { id: string; status: { state: string } } | null = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${baseUrl}/tasks/${taskId}`);
    if (r.ok) {
      const t = (await r.json()) as { id: string; status: { state: string } };
      last = t;
      if (states.includes(t.status.state)) return t;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Task ${taskId} did not reach state [${states.join(',')}] within ${maxMs}ms; last seen: ${JSON.stringify(last)}`,
  );
}

/** Read the full SSE response body until `event: end` or close. */
async function readSseUntilEnd(resp: Response, maxMs = 2000): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 100));
    const next = reader.read();
    const winner = await Promise.race([next, timeout]);
    if (winner === 'timeout') {
      if (buf.includes('event: end')) break;
      continue;
    }
    const { value, done } = winner as Awaited<typeof next>;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('event: end')) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* noop */
  }
  return buf;
}

// ─── /healthz alias compliance (spec/01) ─────────────────────────────────

describe('GET /healthz (spec/01 alias)', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await boot();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('returns 200 with status ok', async () => {
    const r = await fetch(`${booted.url}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });

  it('is mounted at the spec path /healthz (not just /health)', async () => {
    // The spec canonical name is /healthz; /health is a legacy alias kept
    // only for operator probes. /healthz MUST exist on its own.
    const r = await fetch(`${booted.url}/healthz`);
    expect(r.status).not.toBe(404);
  });

  it('returns the same body shape as the legacy /health route', async () => {
    const [h, hz] = await Promise.all([
      fetch(`${booted.url}/health`).then((r) => r.json()),
      fetch(`${booted.url}/healthz`).then((r) => r.json()),
    ]);
    // /healthz is the spec canonical path; it MUST agree with /health on
    // the operator-visible shape so existing probes keep working.
    expect(Object.keys(hz).sort()).toEqual(Object.keys(h).sort());
    expect(hz.status).toBe(h.status);
    expect(hz.agent).toBe(h.agent);
  });
});

// ─── GET /tasks/:id (spec/01 line 23) ────────────────────────────────────

describe('GET /tasks/:id (spec/01 REST endpoint)', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await boot();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('returns 404 for an unknown task id with a message mentioning the id', async () => {
    const r = await fetch(`${booted.url}/tasks/does-not-exist`);
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/does-not-exist/);
  });

  it('returns the persisted task when one exists in the store', async () => {
    const seeded = await seedTask(booted, TaskState.TASK_STATE_WORKING);
    const r = await fetch(`${booted.url}/tasks/${seeded.id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; contextId: string; status: { state: string } };
    expect(body.id).toBe(seeded.id);
    expect(body.contextId).toBe(seeded.contextId);
    expect(body.status.state).toBe('working');
  });
});

// ─── POST /tasks/:id/cancel (spec/02 + spec/07) ──────────────────────────

describe('POST /tasks/:id/cancel (spec/02 + spec/07)', () => {
  describe('404 for unknown task', () => {
    let booted: BootedServer;
    beforeEach(async () => {
      booted = await boot();
    });
    afterEach(async () => {
      await booted.close();
    });

    it('returns 404 with TASK_NOT_FOUND error code', async () => {
      const r = await fetch(`${booted.url}/tasks/no-such-task/cancel`, { method: 'POST' });
      expect(r.status).toBe(404);
      const body = (await r.json()) as {
        error?: { code?: string; message?: string; details?: { taskId?: string } };
      };
      expect(body.error?.code).toBe('TASK_NOT_FOUND');
      expect(body.error?.details?.taskId).toBe('no-such-task');
    });
  });

  describe('409 for already-terminal task', () => {
    let booted: BootedServer;
    beforeEach(async () => {
      booted = await boot();
    });
    afterEach(async () => {
      await booted.close();
    });

    it('returns 409 TASK_ALREADY_COMPLETED for a task in `completed` state', async () => {
      const seeded = await seedTask(booted, TaskState.TASK_STATE_COMPLETED);

      const r = await fetch(`${booted.url}/tasks/${seeded.id}/cancel`, { method: 'POST' });
      expect(r.status).toBe(409);
      const body = (await r.json()) as {
        error?: { code?: string; message?: string; details?: { state?: string } };
        task?: { id: string; status: { state: string } };
      };
      expect(body.error?.code).toBe('TASK_ALREADY_COMPLETED');
      expect(body.error?.details?.state).toBe('completed');
      expect(body.task?.id).toBe(seeded.id);
      expect(body.task?.status.state).toBe('completed');
    });

    it('returns 409 for a task in `canceled` state (cancel-after-cancel)', async () => {
      // spec/07 says "already terminal" includes `canceled`; verify the
      // route enforces the same gate on the cancel-on-cancel path.
      const seeded = await seedTask(booted, TaskState.TASK_STATE_CANCELED);

      const r = await fetch(`${booted.url}/tasks/${seeded.id}/cancel`, { method: 'POST' });
      expect(r.status).toBe(409);
      const body = (await r.json()) as {
        error?: { code?: string; details?: { state?: string } };
      };
      expect(body.error?.code).toBe('TASK_ALREADY_COMPLETED');
      expect(body.error?.details?.state).toBe('canceled');
    });
  });

  describe('200 transition: working → canceled', () => {
    let booted: BootedServer;
    beforeEach(async () => {
      booted = await boot();
    });
    afterEach(async () => {
      await booted.close();
    });

    it('transitions a working task to canceled and returns 200 with the new state', async () => {
      const seeded = await seedTask(booted, TaskState.TASK_STATE_WORKING);

      const r = await fetch(`${booted.url}/tasks/${seeded.id}/cancel`, { method: 'POST' });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        id: string;
        status: { state: string; message?: { parts?: Array<{ kind?: string; text?: string }> } };
      };
      expect(body.id).toBe(seeded.id);
      // spec/04 uses American spelling `canceled` (A2A v1.0.1).
      expect(body.status.state).toBe('canceled');
      const text = body.status.message?.parts?.[0]?.text ?? '';
      expect(text.toLowerCase()).toContain('cancel');
    });

    it('persists the canceled state so subsequent GET reflects it', async () => {
      const seeded = await seedTask(booted, TaskState.TASK_STATE_WORKING);
      await fetch(`${booted.url}/tasks/${seeded.id}/cancel`, { method: 'POST' });

      const r = await fetch(`${booted.url}/tasks/${seeded.id}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: { state: string } };
      expect(body.status.state).toBe('canceled');
    });
  });
});

// ─── GET /tasks/:id/events SSE (spec/01) ──────────────────────────────────

describe('GET /tasks/:id/events SSE', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await boot();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('emits `event: end` immediately for a task already in a terminal state', async () => {
    const seeded = await seedTask(booted, TaskState.TASK_STATE_COMPLETED);

    const r = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const body = await readSseUntilEnd(r, 1500);
    expect(body).toMatch(/event: end/);
    expect(body).toMatch(/"state":"completed"/);
  });

  it('returns 404 for an unknown task id', async () => {
    const r = await fetch(`${booted.url}/tasks/missing-task/events`);
    expect(r.status).toBe(404);
  });

  it('honors Last-Event-ID header for resuming mid-stream', async () => {
    const seeded = await seedTask(booted, TaskState.TASK_STATE_COMPLETED);
    seedEvents(booted, seeded.id, 5);

    // First pass: collect every event with its seq.
    const first = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    const firstBody = await readSseUntilEnd(first, 1500);
    const allSeqs = Array.from(firstBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    expect(allSeqs.length).toBe(5);

    // Pick a mid-stream seq and ask the server to resume from there.
    const resumeFrom = allSeqs[Math.floor(allSeqs.length / 2)]!;
    const resumed = await fetch(`${booted.url}/tasks/${seeded.id}/events`, {
      headers: { 'Last-Event-ID': String(resumeFrom) },
    });
    expect(resumed.status).toBe(200);
    const resumedBody = await readSseUntilEnd(resumed, 1500);
    const resumedSeqs = Array.from(resumedBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    // Every replayed event MUST have a seq strictly greater than the
    // resume cursor. spec/01 resume contract.
    for (const s of resumedSeqs) {
      expect(s).toBeGreaterThan(resumeFrom);
    }
  });

  it('honors ?from=N query parameter as an alternative resume cursor', async () => {
    const seeded = await seedTask(booted, TaskState.TASK_STATE_COMPLETED);
    seedEvents(booted, seeded.id, 5);

    const first = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    const firstBody = await readSseUntilEnd(first, 1500);
    const allSeqs = Array.from(firstBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    expect(allSeqs.length).toBe(5);

    const from = allSeqs[0]!; // resume from the first seq → no replays of seq ≤ from
    const resumed = await fetch(`${booted.url}/tasks/${seeded.id}/events?from=${from}`);
    expect(resumed.status).toBe(200);
    const resumedBody = await readSseUntilEnd(resumed, 1500);
    const resumedSeqs = Array.from(resumedBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    // from=N means seq > N → no events with id ≤ from should be replayed.
    for (const s of resumedSeqs) {
      expect(s).toBeGreaterThan(from);
    }
  });
});

// ─── Agent card v1.0 compliance ───────────────────────────────────────────

describe('Agent card v1.0 compliance', () => {
  describe('protocolVersion (spec/a2a-v1/MIGRATION-fangai.md #15)', () => {
    it('advertises protocolVersion "1.0" on every supportedInterface (currently 0.3.0)', async () => {
      const booted = await boot();
      try {
        // v1.0.1 of the SDK dropped the top-level `protocolVersion` field
        // and moved it onto each AgentInterface inside `supportedInterfaces`.
        // The migration requires "1.0" on every interface. We also assert
        // the top-level field is absent so a future regression to the v0.3
        // shape is caught.
        const card = booted.agentCard as Record<string, unknown>;
        expect(card.protocolVersion).toBeUndefined();
        expect(Array.isArray(booted.agentCard.supportedInterfaces)).toBe(true);
        expect(booted.agentCard.supportedInterfaces.length).toBeGreaterThan(0);
        for (const i of booted.agentCard.supportedInterfaces) {
          expect(i.protocolVersion).toBe('1.0');
        }
      } finally {
        await booted.close();
      }
    });

    it('serves protocolVersion "1.0" on the wire via /.well-known/agent-card.json', async () => {
      const booted = await boot();
      try {
        const r = await fetch(`${booted.url}/.well-known/agent-card.json`);
        expect(r.status).toBe(200);
        const card = (await r.json()) as {
          protocolVersion?: string;
          supportedInterfaces?: Array<{ protocolBinding?: string; protocolVersion?: string }>;
        };
        // v1.0 wire shape: top-level `protocolVersion` MUST NOT appear, and
        // every supportedInterfaces[*] MUST advertise protocolVersion '1.0'.
        expect(card.protocolVersion).toBeUndefined();
        expect(Array.isArray(card.supportedInterfaces)).toBe(true);
        expect(card.supportedInterfaces!.length).toBeGreaterThan(0);
        for (const i of card.supportedInterfaces!) {
          expect(i.protocolVersion).toBe('1.0');
        }
      } finally {
        await booted.close();
      }
    });
  });

  describe('securitySchemes + securityRequirements (spec/a2a-v1 #7)', () => {
    it('omits security fields entirely when no apiKey is configured', async () => {
      const booted = await boot();
      try {
        // Unauthenticated deployments MUST advertise an empty security
        // surface so clients don't try to send Authorization headers.
        const r = await fetch(`${booted.url}/.well-known/agent-card.json`);
        const card = (await r.json()) as {
          securitySchemes?: Record<string, unknown>;
          securityRequirements?: unknown;
          security?: unknown;
        };
        expect(card.securitySchemes ?? {}).toEqual({});
        // v1.0 wire shape: `security` (v0.3) MUST NOT appear; only the
        // renamed `securityRequirements` (which is also empty when no auth
        // is configured) is valid.
        expect(card.security).toBeUndefined();
        expect(card.securityRequirements ?? []).toEqual([]);
      } finally {
        await booted.close();
      }
    });

    it('advertises securitySchemes (map) and securityRequirements (array) when apiKey is configured', async () => {
      const booted = await boot({ apiKey: 'test-secret' });
      try {
        const r = await fetch(`${booted.url}/.well-known/agent-card.json`);
        expect(r.status).toBe(200);
        const card = (await r.json()) as {
          securitySchemes?: Record<string, unknown>;
          securityRequirements?: Array<Record<string, unknown>>;
          security?: Array<Record<string, unknown>>;
        };
        // v1.0.1 schema: `securitySchemes` is a non-empty map AND
        // `securityRequirements` is a non-empty array of {scheme: scopes}.
        expect(card.securitySchemes).toBeDefined();
        expect(typeof card.securitySchemes).toBe('object');
        expect(Object.keys(card.securitySchemes!).length).toBeGreaterThan(0);

        // The v1.0.1 rename: `security` → `securityRequirements`. v0.3's
        // top-level `security` MUST NOT appear on the wire — it's a hidden
        // legacy field now that v0.3 clients are served via toCompatAgentCard
        // (see spec/01 + MIGRATION-fangai.md row #2).
        expect(card.security).toBeUndefined();
        expect(Array.isArray(card.securityRequirements)).toBe(true);
        expect(card.securityRequirements!.length).toBeGreaterThan(0);
        // Every requirement must reference an existing scheme.
        const schemeNames = Object.keys(card.securitySchemes!);
        for (const req of card.securityRequirements!) {
          for (const name of Object.keys(req)) {
            expect(schemeNames).toContain(name);
          }
        }
      } finally {
        await booted.close();
      }
    });
  });

  describe('v1.0 field renames (spec/a2a-v1 #1, #2, #3)', () => {
    it('does not expose the renamed `supportsAuthenticatedExtendedCard` field', async () => {
      const booted = await boot();
      try {
        const card = booted.agentCard as Record<string, unknown>;
        expect(card.supportsAuthenticatedExtendedCard).toBeUndefined();
      } finally {
        await booted.close();
      }
    });

    it('does not expose the old `extendedAgentCard` at the top level (v1 moved it into AgentCapabilities)', async () => {
      const booted = await boot();
      try {
        const card = booted.agentCard as Record<string, unknown>;
        expect(card.extendedAgentCard).toBeUndefined();
      } finally {
        await booted.close();
      }
    });
  });
});
