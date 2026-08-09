/**
 * @fangai/server — A2A server + BridgeExecutor
 * Uses @a2a-js/sdk for protocol compliance.
 * Bridges CLI agents via ProcessManager (oneshot) and PersistentProcess.
 */

import { randomUUID } from 'node:crypto';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import {
  agentCardHandler, jsonRpcHandler, restHandler, UserBuilder,
} from '@a2a-js/sdk/server/express';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import {
  type AgentAdapter, type FangConfig, type AdapterEvent,
  type PersistentAttachableAdapter,
  ProcessManager, PersistentProcess,
} from './core.ts';
import { CursorAgentAdapter, CursorSessionStore, type CursorSession } from './cursor-adapter.ts';
import { FangTaskStore } from './fang-task-store.ts';
import { TaskEventStore } from './task-event-store.ts';

// ─── BridgeExecutor ────────────────────────────────────────────────────────

export class BridgeExecutor implements AgentExecutor {
  private pm = new ProcessManager();
  private persistent: PersistentProcess | null = null;
  private adapter: AgentAdapter;
  private config: FangConfig;
  /** taskId → contextId for lifecycle + cancel signaling */
  private contextByTaskId = new Map<string, string>();
  /** Per-task event log — feeds /tasks/{id}/events SSE replay. */
  readonly events = new TaskEventStore();

  /**
   * Tap into bus.publish so every emitted event is also recorded in the event
   * store for SSE replay. Wraps once per execute() — no per-call-site churn.
   */
  private tapBus(bus: ExecutionEventBus, taskId: string): void {
    const original = bus.publish.bind(bus);
    bus.publish = (event) => {
      this.events.append(taskId, event);
      original(event);
    };
  }

  /**
   * Publish a v1.0-shaped AgentExecutionEvent on the bus. v1.0 wraps every
   * event in a discriminated { kind, data } envelope (see @a2a-js/sdk@1.0.1
   * `AgentExecutionEvent`): the v0.3 flat form the executor used to publish
   * is no longer accepted by the SDK's ResultManager listener.
   *
   * Kinds map to:
   *   'task'          -> data: Task
   *   'message'       -> data: Message
   *   'statusUpdate'  -> data: TaskStatusUpdateEvent   (was 'status-update' in v0.3)
   *   'artifactUpdate'-> data: TaskArtifactUpdateEvent (was 'artifact-update' in v0.3)
   */
  private pub(
    bus: ExecutionEventBus,
    kind: 'task' | 'message' | 'statusUpdate' | 'artifactUpdate',
    data: unknown,
  ): void {
    bus.publish({ kind, data } as Parameters<ExecutionEventBus['publish']>[0]);
  }

  constructor(adapter: AgentAdapter, config: FangConfig) {
    this.adapter = adapter;
    this.config = config;
  }

  private forgetTrackedTask(taskId: string): void {
    this.contextByTaskId.delete(taskId);
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const taskId = ctx.taskId;
    const contextId = ctx.contextId;
    this.tapBus(bus, taskId);

    // Extract user text
    const parts = ctx.userMessage.parts ?? [];
    const text = (parts as Array<{ kind?: string; text?: string }>)
      .filter(p => p.kind === 'text' && typeof p.text === 'string')
      .map(p => p.text!)
      .join('\n').trim();

    if (!text) {
      this.publishMessage(bus, taskId, contextId, 'No message text provided.', 'rejected');
      bus.finished();
      return;
    }

    this.contextByTaskId.set(taskId, contextId);

    const task = { id: taskId, message: text, context: { workdir: this.config.workdir } };

    if (this.adapter.mode === 'persistent') {
      await this.executePersistent(ctx, bus, task);
    } else {
      await this.executeOneshot(ctx, bus, task);
    }
  }

  private async executeOneshot(ctx: RequestContext, bus: ExecutionEventBus, task: { id: string; message: string; context?: any }): Promise<void> {
    const { taskId, contextId } = ctx;
    const config = this.config;
    const adapter = this.adapter;
    const timeout = config.taskTimeout ?? 300;

    // Seed the ResultManager with a task event so it can track this execution.
    // Without this, status-update/artifact-update events reference an unknown taskId
    // and ResultManager.currentTask stays null → "no task context found" on completion.
    this.pub(bus, 'task', {
      id: taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      history: [],
    });

    const [cmd, ...cliArgs] = this.splitCli(config.cli);
    const extraArgs = adapter.buildArgs(task, config);
    let accumulated = '';
    let settled = false;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pm.kill(taskId);
        this.publishMessage(bus, taskId, contextId, `Task timed out after ${timeout}s`);
        bus.finished();
        resolve();
      }, timeout * 1000);

      this.pm.spawn(taskId, cmd, [...cliArgs, ...extraArgs], {
        cwd: config.workdir, env: config.env,
      }, {
        onLine: (line) => {
          if (settled) return;
          const events = adapter.parseLine(line);
          for (const ev of events) {
            if (ev.type === 'text-delta' && ev.text) {
              accumulated += ev.text;
              this.pub(bus, 'artifactUpdate', {
                taskId, contextId,
                artifact: { artifactId: 'stdout', name: 'output', parts: [{ kind: 'text', text: ev.text }] },
                append: true, lastChunk: false,
              });
            }
            if (ev.type === 'status' && ev.state === 'completed') {
              settled = true;
              clearTimeout(timer);
              this.forgetTrackedTask(taskId);
              this.pub(bus, 'message', {
                messageId: randomUUID(),
                contextId,
                taskId,
                role: 'agent',
                parts: [{ kind: 'text', text: accumulated || 'Done' }],
              });
              bus.finished();
              resolve();
            }
            if (ev.type === 'error') {
              settled = true;
              clearTimeout(timer);
              this.forgetTrackedTask(taskId);
              this.pub(bus, 'statusUpdate', {
                taskId, contextId,
                status: {
                  state: 'failed',
                  message: {
                    kind: 'message',
                    messageId: randomUUID(),
                    contextId,
                    taskId,
                    role: 'agent',
                    parts: [{ kind: 'text', text: ev.message }],
                  },
                  timestamp: new Date().toISOString(),
                },
              });
              bus.finished();
              resolve();
            }
          }
        },
        onError: (text) => {
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: { artifactId: 'stderr', name: 'errors', parts: [{ kind: 'text', text }] },
          });
        },
        onExit: (code) => {
          clearTimeout(timer);
          if (settled) { resolve(); return; }
          settled = true;
          if (code === 0) {
            this.forgetTrackedTask(taskId);
            this.pub(bus, 'message', {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: 'agent',
              parts: [{ kind: 'text', text: accumulated || '(no output)' }],
            });
          } else {
            this.forgetTrackedTask(taskId);
            this.pub(bus, 'message', {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: 'agent',
              parts: [{ kind: 'text', text: `Error: exit code ${code}` }],
            });
          }
          bus.finished();
          resolve();
        },
      });

      this.pm.stdin(taskId, adapter.formatInput(task), true);
    });
  }

  private async executePersistent(ctx: RequestContext, bus: ExecutionEventBus, task: { id: string; message: string }): Promise<void> {
    const { taskId, contextId } = ctx;
    const config = this.config;
    const adapter = this.adapter;
    const timeout = config.taskTimeout ?? 600;

    // Seed ResultManager — same reason as executeOneshot
    this.pub(bus, 'task', {
      id: taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      history: [],
    });

    // Ensure persistent process is running
    if (!this.persistent) {
      const [cmd, ...cliArgs] = this.splitCli(config.cli);
      const extraArgs = adapter.buildArgs(task, config);
      this.persistent = new PersistentProcess(cmd, [...cliArgs, ...extraArgs], { cwd: config.workdir, env: config.env });
    }

    await this.persistent.ensure();
    try { await this.persistent.waitUntilReady(30_000); }
    catch { this.publishMessage(bus, taskId, contextId, 'Persistent process did not become ready within 30s'); bus.finished(); return; }
    if (!this.persistent.isAlive) {
      this.publishMessage(bus, taskId, contextId, 'Failed to start persistent process');
      bus.finished();
      return;
    }

    await this.attachPersistentHooks();

    let accumulated = '';
    let settled = false;

    // Timeout guard
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.persistent!.removeLineHandler(taskId);
      this.publishMessage(bus, taskId, contextId, `Task timed out after ${timeout}s`);
      bus.finished();
    }, timeout * 1000);

    // Register per-task line handler — routes stdout to THIS task's bus
    this.persistent.setLineHandler(taskId, (line: string) => {
      if (settled) return;
      const events = adapter.parseLine(line);
      for (const ev of events) {
        if ((ev.type === 'text-delta' || ev.type === 'thinking') && ev.text) {
          accumulated += ev.text;
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: ev.type === 'thinking' ? 'pi-thinking' : 'stdout',
              name: ev.type === 'thinking' ? 'thinking' : 'output',
              parts: [{ kind: 'text', text: ev.text }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'tool-call') {
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: 'pi-agent-tool-call',
              name: 'tool-call',
              parts: [{ kind: 'text', text: `[${ev.tool}] ${JSON.stringify(ev.input ?? {})}` }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'tool-result') {
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: 'pi-agent-tool-result',
              name: 'tool-result',
              parts: [{ kind: 'text', text: `${ev.tool}: ${ev.output}` }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'protocol-log') {
          const detail = ev.detail ? ` ${JSON.stringify(ev.detail)}` : '';
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: `pi-protocol-${ev.subtype}`,
              name: `pi-protocol/${ev.subtype}`,
              parts: [{ kind: 'text', text: `[pi] ${ev.subtype}${detail}` }],
            },
            append: true,
            lastChunk: false,
          });
        }
        if (ev.type === 'host-tool-request') {
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: 'pi-host-tool-request',
              name: `host-tool/${ev.tool}`,
              parts: [{
                kind: 'text',
                text: `[host_tool_call id=${ev.requestId}] ${ev.tool} ${JSON.stringify(ev.input)}`,
              }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'host-tool-cancel') {
          this.pub(bus, 'artifactUpdate', {
            taskId, contextId,
            artifact: {
              artifactId: 'pi-host-tool-cancel',
              name: 'host-tool-cancel',
              parts: [{
                kind: 'text',
                text: `[host_tool_cancel] cancelId=${ev.cancelId} target=${ev.targetRequestId}`,
              }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'status' && ev.state === 'completed') {
          settled = true;
          clearTimeout(timer);
          // Publish final message for sync clients
          this.forgetTrackedTask(taskId);
          this.pub(bus, 'message', {
            messageId: randomUUID(),
            contextId,
            taskId,
            role: 'agent',
            parts: [{ kind: 'text', text: accumulated || 'Done' }],
          });
          bus.finished();
          // Clean up handler after completion
          this.persistent!.removeLineHandler(taskId);
        }
        if (ev.type === 'status' && ev.state === 'working') {
          this.pub(bus, 'statusUpdate', {
            taskId, contextId,
            status: { state: 'working', timestamp: new Date().toISOString() },
          });
        }
        if (ev.type === 'error') {
          settled = true;
          clearTimeout(timer);
          this.forgetTrackedTask(taskId);
          this.pub(bus, 'statusUpdate', {
            taskId, contextId,
            status: {
              state: 'failed',
              message: {
                kind: 'message',
                messageId: randomUUID(),
                contextId,
                taskId,
                role: 'agent',
                parts: [{ kind: 'text', text: ev.message }],
              },
              timestamp: new Date().toISOString(),
            },
          });
          bus.finished();
          this.persistent!.removeLineHandler(taskId);
        }
      }
    });

    // Deferred until this task owns Pi's stdin (`writeWhenActive` buffers if still queued).
    this.persistent.writeWhenActive(taskId, adapter.formatInput(task));
  }

  /**
   * Live Pi queue diagnostics for orchestrators (null unless persistent session exists).
   */
  getPersistentQueueInfo(): {
    persistentQueueDepth: number;
    persistentActiveTaskId: string | null;
    persistentQueuedTaskIds: string[];
  } | null {
    if (this.adapter.mode !== 'persistent') {
      return null;
    }
    if (this.persistent === null) {
      return {
        persistentQueueDepth: 0,
        persistentActiveTaskId: null,
        persistentQueuedTaskIds: [],
      };
    }
    return {
      persistentQueueDepth: this.persistent.getQueueDepth(),
      persistentActiveTaskId: this.persistent.getActiveTaskId(),
      persistentQueuedTaskIds: this.persistent.getQueuedTaskIds(),
    };
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const contextId = this.contextByTaskId.get(taskId);
    const cid = contextId !== undefined ? contextId : '';

    this.pm.kill(taskId);
    if (this.persistent) {
      this.persistent.removeLineHandler(taskId);
    }

    const messageId = randomUUID();
    const cancelMessage =
      cid !== ''
        ? {
            kind: 'message' as const,
            role: 'agent' as const,
            messageId,
            contextId: cid,
            taskId,
            parts: [{ kind: 'text' as const, text: 'Task canceled by client.' }],
          }
        : {
            kind: 'message' as const,
            role: 'agent' as const,
            messageId,
            taskId,
            parts: [{ kind: 'text' as const, text: 'Task canceled by client.' }],
          };

    this.pub(bus, 'statusUpdate', {
      taskId,
      contextId: cid !== '' ? cid : taskId,
      status: {
        state: 'canceled',
        message: cancelMessage,
        timestamp: new Date().toISOString(),
      },
    });

    this.forgetTrackedTask(taskId);
    bus.finished();
  }

  async shutdown(): Promise<void> {
    this.contextByTaskId.clear();
    await this.detachPersistentHooks();
    this.pm.killAll();
    if (this.persistent) await this.persistent.kill();
    this.persistent = null;
  }

  /** Wire PiAdapter (or similar) singleton — enables sendCommand/host tools between tasks */
  private async attachPersistentHooks(): Promise<void> {
    if (!this.persistent) return;
    const a = this.adapter as AgentAdapter & Partial<PersistentAttachableAdapter>;
    if (typeof a.attachPersistent === 'function') await Promise.resolve(a.attachPersistent(this.persistent));
  }

  private async detachPersistentHooks(): Promise<void> {
    const a = this.adapter as AgentAdapter & Partial<PersistentAttachableAdapter>;
    if (typeof a.detachPersistent === 'function') await Promise.resolve(a.detachPersistent());
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private publishMessage(bus: ExecutionEventBus, taskId: string, contextId: string, text: string, state: 'failed' | 'rejected' = 'failed') {
    this.forgetTrackedTask(taskId);
    this.pub(bus, 'statusUpdate', {
      taskId, contextId,
      status: {
        state,
        message: {
          kind: 'message',
          messageId: randomUUID(),
          contextId,
          taskId,
          role: 'agent',
          parts: [{ kind: 'text', text }],
        },
        timestamp: new Date().toISOString(),
      },
    });
  }

  private splitCli(cli: string): string[] {
    const parts: string[] = [];
    let cur = '', inQ: string | null = null;
    for (const ch of cli) {
      if (inQ) { if (ch === inQ) inQ = null; else cur += ch; }
      else if (ch === '"' || ch === "'") inQ = ch;
      else if (ch === ' ' || ch === '\t') { if (cur) { parts.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  }
}

// ─── Server Factory ─────────────────────────────────────────────────────────

export function createFangServer(config: FangConfig & { adapter: AgentAdapter }) {
  const { adapter, port, ...rest } = config;
  const name = config.name || adapter.displayName + '-agent';

  const agentCardBase = {
    name,
    description: `${adapter.displayName} via fang — A2A bridge`,
    version: '1.0.0',
    skills: adapter.skills.map(s => ({ ...s, description: s.name })),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      bridge: 'fang',
      tier: adapter.tier,
      mode: adapter.mode,
    },
  };

  // A2A v1.0 AgentCard shape (see @a2a-js/sdk@1.0.1 `AgentCard`). v1.0 dropped
  // the v0.3 top-level `protocolVersion` / `url` / `preferredTransport` /
  // `security` in favor of `supportedInterfaces[*]` (which carries the
  // transport-specific URL + protocolVersion + protocolBinding) and a
  // top-level `securityRequirements` array. Several fields that were
  // optional in v0.3 are now required: `signatures`, `provider`,
  // `capabilities`, `securitySchemes`. The `legacyCompat` option on
  // the agentCardHandler below lets the same card be served in the v0.3
  // shape (via toCompatAgentCard) to clients that opt in with
  // `A2A-Version: 0.3`.
  const baseUrl = process.env.FANG_PUBLIC_URL ?? `http://localhost:${port}`;
  const agentCard = {
    ...agentCardBase,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a/rest`,   protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', tenant: '' },
      { url: `${baseUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC',    protocolVersion: '1.0', tenant: '' },
    ],
    // Required in v1.0 (was optional in v0.3). Empty array is the spec-
    // compliant way to say "no JWS signatures on this card yet"; signing
    // is a future enhancement.
    signatures: [],
    // Required in v1.0 (can be undefined). fangai does not advertise a
    // separate provider entity; the bridge is the agent's own identity.
    provider: undefined,
    // Required in v1.0. The /readyz and /tasks/:id/events endpoints are
    // custom additions not in the A2A spec, so extensions stays empty.
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    // Required in v1.0. Empty map when no auth is configured; bearer
    // scheme advertised only when an --api-key is set so unauthenticated
    // deployments stay free of misleading auth hints.
    securitySchemes: config.apiKey
      ? { bearer: { type: 'http', scheme: 'bearer' } }
      : {},
    // Required in v1.0. Empty array by default; populated only when
    // --api-key is configured (replaces v0.3's `security: [{ ... }]`).
    // SecurityRequirement is a {schemes: {name: StringList}} wrapper per
    // v1.0, where StringList itself is {list: string[]}.
    securityRequirements: config.apiKey
      ? [{ schemes: { bearer: { list: [] } } }]
      : [],
  };

  const executor = new BridgeExecutor(adapter, { ...rest, port });
  const taskStore = new FangTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  return {
    executor,
    agentCard,
    requestHandler,
    setupApp: (app: express.Express) => {
      app.use(express.json({ limit: '10mb' }));

      // CORS
      if (config.cors) {
        app.use((_req: Request, res: Response, next: NextFunction) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          if (_req.method === 'OPTIONS') return res.sendStatus(204);
          next();
        });
      }

      // Public routes — must be mounted BEFORE auth gate (A2A spec requires public agent card)
      // legacyCompat.enabled lets a v0.3 client (identified by the
      // A2A-Version: 0.3 header, or by omitting the header entirely)
      // receive a v0.3-shaped card via toCompatAgentCard(). v1.0 clients
      // get the canonical v1.0 card unchanged. Per-version ETags and a
      // Vary: A2A-Version response header keep shared HTTP caches from
      // serving the wrong shape to the wrong client.
      app.use('/.well-known/agent-card.json', agentCardHandler({
        agentCardProvider: requestHandler,
        legacyCompat: { enabled: true },
      }));
      // Readiness probe: 200 if the wrapped CLI agent is alive AND has signalled ready.
      // Distinct from /health (server liveness) and from agentAlive:false cases where
      // the HTTP server is up but the spawn-on-first-task model means pi hasn't started yet.
      app.get('/readyz', (_req: Request, res: Response) => {
        if (adapter.mode !== 'persistent') {
          // oneshot adapters don't have a persistent agent to be ready
          return res.status(200).json({ status: 'ready', mode: 'oneshot' });
        }
        const pp = executor['persistent'] as PersistentProcess | null;
        const alive = pp?.isAlive ?? false;
        const ready = pp?.['readyEmitted'] ?? false;
        const ok = alive && ready;
        res.status(ok ? 200 : 503).json({
          status: ok ? 'ready' : 'not_ready',
          mode: 'persistent',
          agentAlive: alive,
          readySignaled: ready,
          persistentQueue: executor.getPersistentQueueInfo(),
        });
      });
      // Extract the legacy /health handler so we can also mount it at /healthz
      // (the path the A2A spec calls for). The handler is unchanged.
      const legacyHealthHandler = (_req: Request, res: Response): void => {
        const pq = executor.getPersistentQueueInfo();
        const base: Record<string, unknown> = {
          status: 'ok',
          agent: name,
          mode: adapter.mode,
          tier: adapter.tier,
        };
        if (pq !== null) {
          base.persistentQueue = pq;
        }
        base.agentAlive = adapter.mode === 'persistent' ? (executor['persistent']?.isAlive ?? false) : null;
        if (adapter instanceof CursorAgentAdapter) {
          const cursorAdapter = adapter as CursorAgentAdapter;
          Object.assign(base, {
            sessions: cursorAdapter.sessionStore.list().length,
            activeSession: cursorAdapter.sessionStore.lastSession,
            defaultModel: cursorAdapter.defaultModel,
            capabilities: {
              multiTurn: true,
              sessionManagement: true,
              modelSelection: true,
              worktreeIsolation: cursorAdapter.useWorktrees,
              streaming: true,
              planMode: true,
            },
          });
        }
        res.json(base);
      };
      // Mount both /health (legacy) and /healthz (spec/01). /health stays for
      // backwards compatibility with operators and probes already configured.
      app.get('/health', legacyHealthHandler);
      app.get('/healthz', legacyHealthHandler);

      // Auth gate — applied to all routes below this point only
      if (config.apiKey) {
        app.use((req: Request, res: Response, next: NextFunction) => {
          if (req.headers.authorization !== `Bearer ${config.apiKey}`) {
            return res.status(401).json({ error: { message: 'Unauthorized' } });
          }
          next();
        });
      }

      // A2A endpoints — protected by auth gate above (if configured)
      // JSON-RPC + REST handlers also gain legacyCompat so a v0.3 client
      // sending `A2A-Version: 0.3` (or no header at all) gets the v0.3
      // request envelope accepted and routed through the SDK's compat
      // module. v1.0 clients get the canonical v1.0 path.
      app.use('/a2a/jsonrpc', jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
        legacyCompat: { enabled: true },
      }));
      app.use('/a2a/rest', restHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
        legacyCompat: { enabled: true },
      }));

      // ── Task status lookup (spec/01) ──────────────────────────────────
      // @a2a-js/sdk's express handlers expose GetTask only via the JSON-RPC
      // and REST envelopes above. spec/01 also lists GET /tasks/{id} as a
      // first-class endpoint for orchestrators to poll without re-parsing
      // JSON-RPC envelopes. 404 when the task ID is unknown.
      app.get('/tasks/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
        try {
          const task = await taskStore.load(req.params.id);
          if (!task) {
            return res.status(404).json({ error: { message: `Task ${req.params.id} not found` } });
          }
          res.json(task);
        } catch (err) {
          next(err);
        }
      });

      // POST /tasks/:id/cancel — spec/02 + spec/07 cancellation protocol.
      // spec/07: 404 if unknown, 409 if already terminal, 200 with final task state.
      // We do not call executor.cancelTask() because the SDK's bus manager is
      // private and we cannot thread the cancellation event back to taskStore
      // that way. Instead we SIGTERM the underlying process and write the
      // canceled state directly to both taskStore and the SSE event log.
      app.post('/tasks/:id/cancel', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
        const taskId = req.params.id;
        try {
          const existing = await taskStore.load(taskId);
          if (!existing) {
            return res.status(404).json({
              error: { code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found`, details: { taskId } },
            });
          }
          // v1.0 SDK types Task.status as TaskStatus | undefined, so guard explicitly.
          const currentState = existing.status?.state;
          const terminal = currentState !== undefined
            && ['completed', 'failed', 'canceled', 'rejected'].includes(currentState);
          if (terminal) {
            return res.status(409).json({
              error: {
                code: 'TASK_ALREADY_COMPLETED',
                message: `Task ${taskId} is already in terminal state ${currentState}`,
                details: { taskId, state: currentState },
              },
              task: existing,
            });
          }

          // SIGTERM the oneshot child (if any) and detach the persistent
          // line handler. ProcessManager already enforces SIGKILL after its
          // own grace window — fire-and-forget here per spec/07 step 5.
          executor['pm'].kill(taskId);
          const pp = executor['persistent'] as PersistentProcess | null;
          if (pp) pp.removeLineHandler(taskId);

          const cancelMessage = {
            kind: 'message' as const,
            role: 'agent' as const,
            messageId: randomUUID(),
            contextId: existing.contextId,
            taskId,
            parts: [{ kind: 'text' as const, text: 'Task canceled by client.' }],
          };
          const canceledStatus = {
            state: 'canceled' as const,
            message: cancelMessage,
            timestamp: new Date().toISOString(),
          };
          const canceledTask = { ...existing, status: canceledStatus };
          await taskStore.save(canceledTask, {} as Parameters<typeof taskStore.save>[1]);

          // Record into the per-task event store so SSE subscribers see it.
          // v1.0 envelope: {kind: 'statusUpdate', data: {...}}.
          executor.events.append(taskId, {
            kind: 'statusUpdate',
            data: {
              taskId,
              contextId: existing.contextId,
              status: canceledStatus,
            },
          } as Parameters<typeof executor.events.append>[1]);

          res.status(200).json(canceledTask);
        } catch (err) {
          next(err);
        }
      });

      // ── Task event stream (SSE) — spec/01 line 24 ───────────────────
      // GET /tasks/{id}/events replays every per-task event published via the
      // ExecutionEventBus during execute(). Supports both the standard SSE
      // Last-Event-ID header and an explicit ?from=<seq> query param for
      // reconnecting clients. Auto-closes after the task enters a terminal
      // state (completed/failed/canceled/rejected) with an `event: end` marker.
      app.get('/tasks/:id/events', (req: Request<{ id: string }, {}, {}, { from?: string }>, res: Response) => {
        const taskId = req.params.id;
        void taskStore.load(taskId).then((task) => {
          if (!task) {
            res.status(404).json({ error: { message: `Task ${taskId} not found` } });
            return;
          }
          const fromHeader = req.headers['last-event-id'];
          const fromHeaderNum = typeof fromHeader === 'string' ? parseInt(fromHeader, 10) : NaN;
          const fromQueryNum = req.query?.from !== undefined ? parseInt(req.query.from, 10) : NaN;
          const fromSeq = Number.isFinite(fromHeaderNum) && fromHeaderNum > 0
            ? fromHeaderNum
            : (Number.isFinite(fromQueryNum) && fromQueryNum > 0 ? fromQueryNum : 0);

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();

          const writeEntry = (entry: ReturnType<TaskEventStore['read']>[number]): void => {
            res.write(`id: ${entry.seq}\n`);
            res.write(`event: ${(entry.event as { kind: string }).kind}\n`);
            res.write(`data: ${JSON.stringify(entry.event)}\n\n`);
          };

          for (const entry of executor.events.read(taskId, fromSeq)) writeEntry(entry);

          // v1.0 SDK types Task.status as TaskStatus | undefined, so guard explicitly.
          const currentState = task.status?.state;
          const terminal = currentState !== undefined
            && ['completed', 'failed', 'canceled', 'rejected'].includes(currentState);
          if (terminal) {
            res.write(`event: end\ndata: {"state":"${currentState}"}\n\n`);
            res.end();
            return;
          }

          let lastSeq = executor.events.latestSeq(taskId);
          const interval = setInterval(() => {
            const live = executor.events.read(taskId, lastSeq);
            for (const entry of live) {
              writeEntry(entry);
              lastSeq = entry.seq;
              const k = (entry.event as { kind: string }).kind;
              if (k === 'status-update') {
                const final = (entry.event as { final?: boolean }).final;
                const state = (entry.event as { status?: { state?: string } }).status?.state;
                if (final && state && ['completed', 'failed', 'canceled', 'rejected'].includes(state)) {
                  clearInterval(interval);
                  res.write(`event: end\ndata: {"state":"${state}"}\n\n`);
                  res.end();
                  return;
                }
              }
            }
          }, 250);

          req.on('close', () => {
            clearInterval(interval);
            try { res.end(); } catch { /* noop */ }
          });
        }).catch((err) => {
          res.status(500).json({ error: { message: String((err as Error).message ?? err) } });
        });
      });

      // ── Cursor-specific management endpoints ────────────────────────
      // Only mounted when adapter is CursorAgentAdapter
      if (adapter instanceof CursorAgentAdapter) {
        const cursorAdapter = adapter as CursorAgentAdapter;

        // List active Cursor sessions
        app.get('/cursor/sessions', (_req: Request, res: Response) => {
          const sessions = cursorAdapter.sessionStore.list();
          res.json({
            sessions: sessions.map(s => ({
              id: s.id,
              workspace: s.workspace,
              model: s.model,
              turns: s.turnCount,
              created: s.createdAt.toISOString(),
              lastUsed: s.lastUsedAt.toISOString(),
            })),
            active: cursorAdapter.sessionStore.lastSession,
          });
        });

        // Get specific session details
        app.get('/cursor/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
          const session = cursorAdapter.sessionStore.get(req.params.id);
          if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
          }
          res.json({
            id: session.id,
            workspace: session.workspace,
            model: session.model,
            turns: session.turnCount,
            created: session.createdAt.toISOString(),
            lastUsed: session.lastUsedAt.toISOString(),
          });
        });

        // Start a new conversation (clear session continuity)
        app.post('/cursor/sessions/new', (_req: Request, res: Response) => {
          cursorAdapter.sessionStore.clear();
          res.json({ status: 'ok', message: 'Session cleared — next task starts fresh' });
        });

        // Get supported models (proxy to cursor-agent models)
        app.get('/cursor/models', async (_req: Request, res: Response) => {
          try {
            const { execFile: ef } = await import('node:child_process');
            const { promisify: prom } = await import('node:util');
            const efAsync = prom(ef);
            const { stdout } = await efAsync(cursorAdapter.binary, ['models'], { timeout: 10000 }) as { stdout: string };
            // Parse model list (one per line, format: "model-id - Display Name")
            const models = stdout.trim().split('\n')
              .filter((line: string) => line.includes(' - '))
              .map((line: string) => {
                const parts = line.split(' - ');
                const id = parts[0]?.trim() ?? '';
                const name = parts.slice(1).join(' - ').trim();
                return { id, name };
              });
            res.json({ models, default: cursorAdapter.defaultModel });
          } catch (err: any) {
            res.status(500).json({ error: { message: err.message } });
          }
        });
      }
    },
  };
}