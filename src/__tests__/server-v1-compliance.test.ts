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
 * current (v0.3.0-era) implementation. Several will FAIL until the
 * migration in spec/a2a-v1/MIGRATION-fangai.md is complete. That is the
 * point of TDD here — capture the deltas as failing assertions first,
 * then make them green during the upgrade.
 *
 * Important: NO production code in src/ is modified by these tests.
 *
 * Task-seeding strategy: the v1.0.1 JSON-RPC handler rejects requests
 * because the current AgentCard has no `supportedInterfaces` (it uses
 * top-level `protocolVersion`). To exercise the HTTP endpoints without
 * coupling to the JSON-RPC envelope, tests seed tasks via the SDK's
 * DefaultRequestHandler directly (`requestHandler.sendMessage`) — which
 * is what the production Express handlers ultimately call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, FangConfig } from '../core.ts';
import { createFangServer } from '../server.ts';
import type { ServerCallContext, Task } from '@a2a-js/sdk';
import { ServerCallContext as ServerCallContextClass } from '@a2a-js/sdk/server';

// ─── Stub adapter ─────────────────────────────────────────────────────────

/**
 * A minimal AgentAdapter that never spawns anything itself. Tests that need
 * a running task pre-seed the task into the taskStore by going through the
 * SDK's request handler directly.
 */
class StubAdapter implements AgentAdapter {
  readonly id: string;
  readonly binary: string;
  readonly tier: 1 | 2 | 3;
  readonly displayName: string;
  readonly mode: 'oneshot' | 'persistent';
  skills: Array<{ id: string; name: string; tags: string[] }>;

  constructor(opts: { id?: string; binary?: string; mode?: 'oneshot' | 'persistent' } = {}) {
    this.id = opts.id ?? 'stub';
    this.binary = opts.binary ?? 'true';
    this.tier = 3;
    this.displayName = 'Stub Adapter';
    this.mode = opts.mode ?? 'oneshot';
    this.skills = [{ id: 'code-edit', name: 'code-edit', tags: ['edit'] }];
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
  close: () => Promise<void>;
}

async function boot(opts: {
  cli?: string;
  apiKey?: string;
  adapterMode?: 'oneshot' | 'persistent';
} = {}): Promise<BootedServer> {
  const adapter = new StubAdapter({ binary: opts.cli ?? 'true', mode: opts.adapterMode ?? 'oneshot' });
  const cfg: FangConfig & { adapter: AgentAdapter } = {
    cli: opts.cli ?? 'true',
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
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    agentCard,
    requestHandler,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Build a v1.0.1 ServerCallContext for direct SDK calls. */
function makeContext(): ServerCallContext {
  return new ServerCallContextClass({});
}

/** Seed a task by invoking the SDK handler directly (bypasses JSON-RPC envelope). */
async function seedTask(booted: BootedServer, text: string): Promise<Task> {
  const result = await booted.requestHandler.sendMessage(
    {
      tenant: '',
      message: {
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text }],
      },
      configuration: undefined,
      metadata: undefined,
    },
    makeContext(),
  );
  // result can be a Message or a Task
  if ('id' in result && result.id !== undefined) {
    return result as Task;
  }
  throw new Error(`sendMessage did not return a task: ${JSON.stringify(result)}`);
}

/** Wait until /tasks/:id reports the given terminal state. */
async function waitForTerminalState(
  baseUrl: string,
  taskId: string,
  states: string[],
  maxMs = 5000,
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Task ${taskId} did not reach terminal state [${states.join(',')}] within ${maxMs}ms; last seen: ${JSON.stringify(last)}`,
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
    booted = await boot({ cli: 'true' });
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

  it('returns the persisted task after a request-handler submission', async () => {
    const seeded = await seedTask(booted, 'hello fang');
    const r = await fetch(`${booted.url}/tasks/${seeded.id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; contextId: string; status: { state: string } };
    expect(body.id).toBe(seeded.id);
    expect(typeof body.contextId).toBe('string');
    expect(['submitted', 'working', 'completed', 'failed', 'canceled', 'rejected', 'input-required'])
      .toContain(body.status.state);
  });
});

// ─── POST /tasks/:id/cancel (spec/02 + spec/07) ──────────────────────────

describe('POST /tasks/:id/cancel (spec/02 + spec/07)', () => {
  describe('404 for unknown task', () => {
    let booted: BootedServer;
    beforeEach(async () => {
      booted = await boot({ cli: 'true' });
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
      // `true` exits 0 immediately, so the task reaches a terminal state.
      booted = await boot({ cli: 'true' });
    });
    afterEach(async () => {
      await booted.close();
    });

    it('returns 409 TASK_ALREADY_COMPLETED for a completed task', async () => {
      const seeded = await seedTask(booted, 'finish now');
      await waitForTerminalState(booted.url, seeded.id, ['completed', 'failed', 'canceled', 'rejected']);

      const r = await fetch(`${booted.url}/tasks/${seeded.id}/cancel`, { method: 'POST' });
      // If the task settled into `failed`/`canceled`/`rejected` instead of
      // `completed`, the 409 still applies (terminal state). We then check
      // the response is well-formed.
      expect(r.status).toBe(409);
      const body = (await r.json()) as {
        error?: { code?: string; message?: string; details?: { state?: string } };
        task?: { id: string; status: { state: string } };
      };
      expect(body.error?.code).toBe('TASK_ALREADY_COMPLETED');
      expect(body.task?.id).toBe(seeded.id);
      expect(['completed', 'failed', 'canceled', 'rejected']).toContain(body.error?.details?.state);
    });
  });

  describe('200 transition: working → canceled', () => {
    let booted: BootedServer;
    beforeEach(async () => {
      // `sleep 30` keeps the child process alive long enough to cancel.
      booted = await boot({ cli: 'sleep 30' });
    });
    afterEach(async () => {
      await booted.close();
    });

    it('transitions a working task to canceled and returns 200 with the new state', async () => {
      const seeded = await seedTask(booted, 'long running');
      // Wait until the task is in a non-terminal state (working/submitted).
      await waitForTerminalState(booted.url, seeded.id, ['submitted', 'working']);

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
      const seeded = await seedTask(booted, 'cancel me');
      await waitForTerminalState(booted.url, seeded.id, ['submitted', 'working']);
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
    booted = await boot({ cli: 'true' });
  });
  afterEach(async () => {
    await booted.close();
  });

  it('emits `event: end` immediately for a task already in a terminal state', async () => {
    const seeded = await seedTask(booted, 'quick');
    await waitForTerminalState(booted.url, seeded.id, [
      'completed',
      'failed',
      'canceled',
      'rejected',
    ]);

    const r = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const body = await readSseUntilEnd(r, 1500);
    expect(body).toMatch(/event: end/);
  });

  it('returns 404 for an unknown task id', async () => {
    const r = await fetch(`${booted.url}/tasks/missing-task/events`);
    expect(r.status).toBe(404);
  });

  it('honors Last-Event-ID header for resuming mid-stream', async () => {
    const seeded = await seedTask(booted, 'sse resume');
    await waitForTerminalState(booted.url, seeded.id, [
      'completed',
      'failed',
      'canceled',
      'rejected',
    ]);

    // First pass: collect every event with its seq.
    const first = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    const firstBody = await readSseUntilEnd(first, 1500);
    const allSeqs = Array.from(firstBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    expect(allSeqs.length).toBeGreaterThan(0);

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
    const seeded = await seedTask(booted, 'sse from query');
    await waitForTerminalState(booted.url, seeded.id, [
      'completed',
      'failed',
      'canceled',
      'rejected',
    ]);

    const first = await fetch(`${booted.url}/tasks/${seeded.id}/events`);
    const firstBody = await readSseUntilEnd(first, 1500);
    const allSeqs = Array.from(firstBody.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
    expect(allSeqs.length).toBeGreaterThan(0);

    const from = allSeqs[0]!; // resume from the first seq → expect no replays of seq ≤ from
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
    it('advertises protocolVersion "1.0" (currently 0.3.0)', async () => {
      const booted = await boot();
      try {
        // v1.0.1 of the SDK renamed the top-level `protocolVersion` to
        // live on each AgentInterface inside `supportedInterfaces`. The
        // migration requires "1.0" everywhere it appears.
        expect(booted.agentCard.protocolVersion).toBe('1.0');
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
          supportedInterfaces?: Array<{ protocolVersion?: string }>;
        };
        // Acceptable places to find the protocolVersion string:
        //   - top-level `protocolVersion` (compat shape), OR
        //   - inside every supportedInterfaces[*].protocolVersion (v1.0.1)
        const onInterfaces = (card.supportedInterfaces ?? []).every((i) => i.protocolVersion === '1.0');
        const onTopLevel = card.protocolVersion === '1.0';
        expect(onTopLevel || onInterfaces).toBe(true);
        if (card.supportedInterfaces !== undefined) {
          for (const i of card.supportedInterfaces) {
            expect(i.protocolVersion).toBe('1.0');
          }
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
        expect(card.securityRequirements ?? []).toEqual([]);
        expect(card.security ?? []).toEqual([]);
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

        // The v1.0.1 rename: `security` → `securityRequirements`.
        // Spec compliance requires securityRequirements to be present and
        // non-empty when auth is required.
        const reqs = card.securityRequirements ?? card.security;
        expect(Array.isArray(reqs)).toBe(true);
        expect(reqs!.length).toBeGreaterThan(0);
        // Every requirement must reference an existing scheme.
        const schemeNames = Object.keys(card.securitySchemes!);
        for (const req of reqs!) {
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
