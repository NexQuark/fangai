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

// ─── BridgeExecutor ────────────────────────────────────────────────────────

export class BridgeExecutor implements AgentExecutor {
  private pm = new ProcessManager();
  private persistent: PersistentProcess | null = null;
  private adapter: AgentAdapter;
  private config: FangConfig;
  /** taskId → contextId for lifecycle + cancel signaling */
  private contextByTaskId = new Map<string, string>();

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
    bus.publish({
      kind: 'task',
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
              bus.publish({
                kind: 'artifact-update', taskId, contextId,
                artifact: { artifactId: 'stdout', name: 'output', parts: [{ kind: 'text', text: ev.text }] },
                append: true, lastChunk: false,
              });
            }
            if (ev.type === 'status' && ev.state === 'completed') {
              settled = true;
              clearTimeout(timer);
              this.forgetTrackedTask(taskId);
              bus.publish({ kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: accumulated || 'Done' }] });
              bus.finished();
              resolve();
            }
            if (ev.type === 'error') {
              settled = true;
              clearTimeout(timer);
              this.forgetTrackedTask(taskId);
              bus.publish({
                kind: 'status-update', taskId, contextId, final: true,
                status: { state: 'failed', message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: ev.message }] }, timestamp: new Date().toISOString() },
              });
              bus.finished();
              resolve();
            }
          }
        },
        onError: (text) => {
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
            artifact: { artifactId: 'stderr', name: 'errors', parts: [{ kind: 'text', text }] },
          });
        },
        onExit: (code) => {
          clearTimeout(timer);
          if (settled) { resolve(); return; }
          settled = true;
          if (code === 0) {
            this.forgetTrackedTask(taskId);
            bus.publish({ kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: accumulated || '(no output)' }] });
          } else {
            this.forgetTrackedTask(taskId);
            bus.publish({ kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: `Error: exit code ${code}` }] });
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
    bus.publish({
      kind: 'task',
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
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
            artifact: {
              artifactId: ev.type === 'thinking' ? 'pi-thinking' : 'stdout',
              name: ev.type === 'thinking' ? 'thinking' : 'output',
              parts: [{ kind: 'text', text: ev.text }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'tool-call') {
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
            artifact: {
              artifactId: 'pi-agent-tool-call',
              name: 'tool-call',
              parts: [{ kind: 'text', text: `[${ev.tool}] ${JSON.stringify(ev.input ?? {})}` }],
            },
            append: true, lastChunk: false,
          });
        }
        if (ev.type === 'tool-result') {
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
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
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
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
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
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
          bus.publish({
            kind: 'artifact-update', taskId, contextId,
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
          bus.publish({ kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: accumulated || 'Done' }] });
          bus.finished();
          // Clean up handler after completion
          this.persistent!.removeLineHandler(taskId);
        }
        if (ev.type === 'status' && ev.state === 'working') {
          bus.publish({
            kind: 'status-update', taskId, contextId, final: false,
            status: { state: 'working', timestamp: new Date().toISOString() },
          });
        }
        if (ev.type === 'error') {
          settled = true;
          clearTimeout(timer);
          this.forgetTrackedTask(taskId);
          bus.publish({
            kind: 'status-update', taskId, contextId, final: true,
            status: { state: 'failed', message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: ev.message }] }, timestamp: new Date().toISOString() },
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

    bus.publish({
      kind: 'status-update',
      taskId,
      contextId: cid !== '' ? cid : taskId,
      final: true,
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
    bus.publish({
      kind: 'status-update', taskId, contextId, final: true,
      status: { state, message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text }] }, timestamp: new Date().toISOString() },
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

  const agentCard = {
    name,
    description: `${adapter.displayName} via fang — A2A bridge`,
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url: process.env.FANG_PUBLIC_URL ?? `http://localhost:${port}`,
    capabilities: { streaming: true },
    skills: adapter.skills.map(s => ({ ...s, description: s.name })),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      bridge: 'fang',
      tier: adapter.tier,
      mode: adapter.mode,
    },
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
      app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
      app.get('/health', (_req: Request, res: Response) => {
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
      });

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
      app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

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