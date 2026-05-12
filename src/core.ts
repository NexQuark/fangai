/**
 * @fangai/core — types, adapter interface, process manager, detector
 *
 * Uses LF-only JSONL reader (not Node readline) for protocol compliance.
 * Pi's RPC protocol explicitly requires splitting on \n only — readline
 * also splits on U+2028 and U+2029 which are valid inside JSON strings.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Structured Logging ─────────────────────────────────────────────────

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    l: level,
    m: msg,
    ...(data ?? {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface AgentTask {
  id: string;
  message: string;
  context?: { workdir?: string; files?: string[]; metadata?: Record<string, unknown> };
}

export interface DetectionResult {
  binary: string;
  version: string;
  path: string;
  tier: 1 | 2 | 3;
  protocol: string;
}

export type AdapterEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; tool: string; input?: Record<string, unknown> }
  | { type: 'tool-result'; tool: string; output: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'status'; state: 'working' | 'completed' | 'failed' | 'input-required' }
  | { type: 'error'; message: string; code?: string }
  /** Pi RPC: Pi requested execution of a host-registered tool (reverse direction vs agent tool_execution_*). */
  | { type: 'host-tool-request'; requestId: string; toolCallId: string; tool: string; input: Record<string, unknown> }
  /** Pi RPC: cancellation for a pending `host_tool_call` (identified by outbound `targetId`). */
  | { type: 'host-tool-cancel'; cancelId: string; targetRequestId: string }
  /** Non-fatal protocol telemetry (compaction milestones, todos, Pi-internal signals like ttsr). */
  | { type: 'protocol-log'; subtype: string; detail?: Record<string, unknown> };

/** Content shape accepted by oh-my-pi `host_tool_result` (subset of AgentToolResult). */
export type RpcHostToolResultContent = ReadonlyArray<Record<string, unknown>>;

export interface RpcParsedResponse {
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Executes a Pi `host_tool_call`. Must return fragments suitable for `{ result: { content } }`.
 * Use `abortSignal` to cooperatively abort when Pi emits `host_tool_cancel`.
 */
export type RpcHostToolExecutor = (
  ctx: {
    requestId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    abortSignal: AbortSignal;
  },
) => Promise<{ content: RpcHostToolResultContent; isError?: boolean }>;

/** Optional hooks for adapters that need to bind/unbind a PersistentProcess singleton. */
export interface PersistentAttachableAdapter {
  attachPersistent(proc: PersistentProcess): void | Promise<void>;
  detachPersistent?(): void | Promise<void>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly binary: string;
  readonly tier: 1 | 2 | 3;
  readonly displayName: string;
  readonly mode: 'oneshot' | 'persistent';
  skills: Array<{ id: string; name: string; tags: string[] }>;

  buildArgs(task: AgentTask, config: FangConfig): string[];
  formatInput(task: AgentTask): string;
  parseLine(line: string): AdapterEvent[];
  detect(): Promise<DetectionResult | null>;
  dispose?(): Promise<void>;
}

export interface FangConfig {
  cli: string;
  port: number;
  name?: string;
  workdir?: string;
  env?: Record<string, string>;
  maxConcurrent?: number;
  taskTimeout?: number;
  killTimeout?: number;
  agentFlags?: string[];
  apiKey?: string;
  cors?: boolean;
}

// ─── LF-only JSONL reader ─────────────────────────────────────────────────
// Strict JSONL framing: split on \n only. Does NOT use Node readline,
// which incorrectly splits on U+2028 and U+2029 (valid in JSON strings).
// Based on Pi's own attachJsonlLineReader implementation.

export function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  let buffer = '';

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      // Strip optional \r (accept \r\n input)
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  };

  const onEnd = () => {
    if (buffer.length > 0) {
      let remaining = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (remaining.length > 0) onLine(remaining);
      buffer = '';
    }
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  // Return cleanup function
  return () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
  };
}

// ─── Process Manager ──────────────────────────────────────────────────────

export class ProcessManager {
  private processes = new Map<string, ChildProcess>();
  private killTimers = new Map<string, NodeJS.Timeout>();
  private cleanups = new Map<string, () => void>();

  spawn(
    taskId: string,
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    handlers: {
      onLine: (line: string) => void;
      onError: (text: string) => void;
      onExit: (code: number | null, signal: string | null) => void;
    },
  ): ChildProcess {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: { ...process.env as Record<string, string>, ...opts.env },
    });
    this.processes.set(taskId, proc);
    log('info', 'process_spawned', { taskId, cmd, pid: proc.pid });

    // LF-only JSONL reader — protocol compliant
    const detach = attachJsonlReader(proc.stdout!, handlers.onLine);
    this.cleanups.set(taskId, detach);

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) handlers.onError(line);
      }
    });

    proc.on('exit', (code, signal) => {
      log('info', 'process_exited', { taskId, code, signal });
      detach();
      this.processes.delete(taskId);
      this.cleanups.delete(taskId);
      const timer = this.killTimers.get(taskId);
      if (timer) { clearTimeout(timer); this.killTimers.delete(taskId); }
      handlers.onExit(code, signal);
    });

    proc.on('error', (err) => {
      log('error', 'process_error', { taskId, error: err.message });
      detach();
      this.processes.delete(taskId);
      this.cleanups.delete(taskId);
      handlers.onError(err.message);
      handlers.onExit(1, null);
    });

    return proc;
  }

  stdin(taskId: string, data: string, close = false): void {
    const proc = this.processes.get(taskId);
    if (!proc) return;
    proc.stdin!.write(data);
    if (close) proc.stdin!.end();
  }

  kill(taskId: string, timeout = 5000): void {
    const proc = this.processes.get(taskId);
    if (!proc) return;
    log('warn', 'process_kill', { taskId, timeout });
    proc.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, timeout);
    this.killTimers.set(taskId, timer);
  }

  async killAll(timeout = 5000): Promise<void> {
    const ids = [...this.processes.keys()];
    if (ids.length === 0) return;
    await Promise.all(ids.map(id => new Promise<void>(resolve => {
      const proc = this.processes.get(id);
      if (!proc) { resolve(); return; }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, timeout);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
      proc.kill('SIGTERM');
    })));
  }

  has(taskId: string): boolean { return this.processes.has(taskId); }
  get(taskId: string): ChildProcess | undefined { return this.processes.get(taskId); }
}

// ─── Persistent Process Manager ───────────────────────────────────────────
// Supports multiple concurrent tasks via per-task line handlers.
// Lines are routed to the active task. When a task completes (status event),
// the next queued task becomes active.
//
// Pi / oh-my-pi additions:
// - `waitUntilReady()` — first `{ "type":"ready" }` from stdout before commands
// - `sendRpcCommand` — stdin JSON-RPC-style commands correlated by optional `id`
// - Host tool callbacks — executes `host_tool_call` writes `host_tool_result`
// Extension UI responses — auto-respond so the agent doesn't hang.

export class PersistentProcess {
  private proc: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private readonly cmd: string;
  private readonly args: string[];
  private readonly opts: { cwd?: string; env?: Record<string, string> };

  /** Map of taskId → line handler. Only the active task receives lines. */
  private taskHandlers = new Map<string, (line: string) => void>();
  /** Ordered queue of task IDs waiting to be active. */
  private taskQueue: string[] = [];
  /** The currently active task ID (receiving stdout lines). */
  private activeTaskId: string | null = null;

  /** Deferred stdin payloads for queued tasks (`writeWhenActive` only — not RPC `write`). */
  private writeBuffer = new Map<string, string[]>();
  /** Notify waiters once a task becomes active and buffered stdin has been flushed. */
  private writeWaiters = new Map<string, Array<() => void>>();

  /** Correlates `{ type:'response', id }` frames to pending `sendRpcCommand` awaits. */
  private pendingResponses = new Map<string, {
    settle: (r: RpcParsedResponse | null) => void;
    timer: NodeJS.Timeout;
  }>();

  private readyEmitted = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private rpcDefaultTimeoutMs = 120_000;

  private rpcHostExecutor: RpcHostToolExecutor | undefined;
  /** requestId (`host_tool_call.id`) → abort when Pi sends matching targetId cancel */
  private hostAbortByRequestId = new Map<string, AbortController>();

  /** Crash callback — fired when process exits unexpectedly with pending handlers. */
  readonly onCrash?: (crashedTaskId: string, remainingCount: number) => void;

  constructor(
    cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> },
    callbacks?: { onCrash?: (crashedTaskId: string, remainingCount: number) => void },
  ) {
    this.cmd = cmd;
    this.args = args;
    this.opts = opts;
    this.onCrash = callbacks?.onCrash;
  }

  /** Replace / clear custom host tool execution (wired by PiAdapter / BridgeExecutor). */
  setHostToolExecutor(exec: RpcHostToolExecutor | undefined): void {
    this.rpcHostExecutor = exec;
  }

  /** Default timeout for correlated RPC awaits (milliseconds). */
  setRpcTimeoutMs(ms: number): void {
    this.rpcDefaultTimeoutMs = Math.max(1000, ms);
  }

  /**
   * Resolves once the child emits `{ "type": "ready" }` over stdout,
   * or rejects on timeout after `ensure()` spawned the process.
   */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.readyEmitted) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for Pi ready frame')), timeoutMs);
      this.readyWaiters.push({
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  /**
   * Send a Pi RPC command payload (stdin JSON line). Automatically assigns `id` if omitted.
   * Resolves only on matching `{ type:"response", id }` stdout line (consumes internally).
   *
   * Excludes prompts / steer / abort / follow_up flows where you want streaming — use adapter `write`/`formatInput` instead.
   */
  async sendRpcCommand(
    command: Record<string, unknown>,
    opts?: { timeoutMs?: number; correlationId?: string },
  ): Promise<RpcParsedResponse> {
    if (!this.isAlive || !this.proc?.stdin) {
      throw new Error('Persistent process is not alive');
    }
    const cid = opts?.correlationId ?? (command.id !== undefined ? String(command.id) : randomUUID());
    const body: Record<string, unknown> = { ...command, id: cid };

    const timeoutMs = opts?.timeoutMs ?? this.rpcDefaultTimeoutMs;

    const cmdHint = typeof body.type === 'string' ? body.type : 'rpc';

    const responsePromise = new Promise<RpcParsedResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(cid);
        log('warn', 'rpc_timeout', { correlationId: cid, command: cmdHint, timeoutMs });
        resolve({
          success: false,
          error: `RPC correlation timeout (${timeoutMs}ms) for command ${cmdHint}`,
        });
      }, timeoutMs);
      this.pendingResponses.set(cid, { settle: (r) => { clearTimeout(timer); resolve(r ?? { success: false, error: 'Empty RPC response' }); }, timer });
    });

    const line = JSON.stringify(body) + '\n';
    this.proc.stdin.write(line);

    return responsePromise;
  }

  /** Internal: correlate or route a stdout JSON frame before forwarding to adapters. Returns true if swallowed. */
  private dispatchStdoutJson(parsed: Record<string, unknown>): boolean {
    // Extension UI dialogs — mutate stdin (must precede swallow rules)
    if (parsed.type === 'extension_ui_request') {
      this.handleExtensionUIParsed(parsed);
      return false;
    }

    if (parsed.type === 'ready') {
      this.signalReadyDone();
      return false;
    }

    if (parsed.type === 'response') {
      const rid = parsed.id !== undefined ? String(parsed.id) : '';
      if (rid && this.pendingResponses.has(rid)) {
        const slot = this.pendingResponses.get(rid)!;
        this.pendingResponses.delete(rid);
        const success = !!parsed.success;
        const parsedResp: RpcParsedResponse = success
          ? { success: true, command: typeof parsed.command === 'string' ? parsed.command : undefined, data: parsed.data }
          : {
              success: false,
              command: typeof parsed.command === 'string' ? parsed.command : undefined,
              error: typeof parsed.error === 'string' ? parsed.error : 'RPC failure',
            };
        slot.settle(parsedResp);
        return true;
      }
      return false;
    }

    if (parsed.type === 'host_tool_call' && typeof parsed.id === 'string' && this.rpcHostExecutor) {
      void this.invokeHostToolAndReply(parsed).catch(() => {
        /* host_tool_reply sent inside */
      });
      return false;
    }

    if (parsed.type === 'host_tool_cancel' && typeof parsed.targetId === 'string') {
      const ac = this.hostAbortByRequestId.get(parsed.targetId);
      ac?.abort();
      return false;
    }

    return false;
  }

  private signalReadyDone(): void {
    if (this.readyEmitted) return;
    this.readyEmitted = true;
    for (const { resolve } of this.readyWaiters) {
      try { resolve(); } catch { /* noop */ }
    }
    this.readyWaiters.length = 0;
  }

  private async invokeHostToolAndReply(raw: Record<string, unknown>): Promise<void> {
    const exec = this.rpcHostExecutor;
    if (!exec || !this.proc?.stdin) return;

    const id = typeof raw.id === 'string' ? raw.id : '';
    const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
    const toolName = typeof raw.toolName === 'string' ? raw.toolName : 'unknown_tool';
    const args = typeof raw.arguments === 'object' && raw.arguments !== null ? raw.arguments as Record<string, unknown> : {};

    const ac = new AbortController();
    this.hostAbortByRequestId.set(id, ac);

    const sendResult = (result: RpcHostToolResultContent, isError?: boolean): void => {
      if (!this.proc?.stdin) return;
      const frame: Record<string, unknown> = {
        type: 'host_tool_result',
        id,
        result: { content: [...result] },
      };
      if (isError) frame.isError = true;
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    };

    try {
      const outcome = await exec({
        requestId: id,
        toolCallId,
        toolName,
        args,
        abortSignal: ac.signal,
      });
      sendResult([...outcome.content], !!outcome.isError);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResult([{ type: 'text', text: `Host tool error: ${msg}` }], true);
    } finally {
      this.hostAbortByRequestId.delete(id);
    }
  }

  /** Reset Pi-side waiters/maps when spawning a replacement process after death. */
  private resetStatefulSession(): void {
    this.clearDeferredWritesState();
    for (const { reject } of this.readyWaiters) {
      try { reject(new Error('Persistent process respawn — ready wait aborted')); } catch { /* noop */ }
    }
    this.readyWaiters.length = 0;

    for (const [, pend] of [...this.pendingResponses]) {
      try { pend.settle({ success: false, error: 'Persistent session reset — RPC await cleared' }); } catch { /* noop */ }
      clearTimeout(pend.timer);
    }
    this.pendingResponses.clear();
    this.readyEmitted = false;
    this.hostAbortByRequestId.clear();
  }

  private clearDeferredWritesState(): void {
    this.writeBuffer.clear();
    this.writeWaiters.clear();
  }

  private flushBufferedWrites(taskId: string): void {
    const chunks = this.writeBuffer.get(taskId);
    if (chunks === undefined || chunks.length === 0) return;
    for (let i = 0; i < chunks.length; i++) {
      this.write(chunks[i]);
    }
    this.writeBuffer.delete(taskId);
  }

  private resolveWriteWaiters(taskId: string): void {
    const ws = this.writeWaiters.get(taskId);
    if (ws === undefined || ws.length === 0) return;
    this.writeWaiters.delete(taskId);
    for (let i = 0; i < ws.length; i++) {
      try {
        ws[i]();
      } catch {
        /* noop */
      }
    }
  }

  /** After `activeTaskId` is assigned, flush stdin buffer then signal waiters. */
  private promoteActivatedTask(taskId: string): void {
    this.flushBufferedWrites(taskId);
    this.resolveWriteWaiters(taskId);
  }

  /**
   * Task prompt input — writes immediately only when `taskId` is active.
   * Queued tasks buffer until promoted (avoid interleaving with Pi busy on another prompt).
   */
  writeWhenActive(taskId: string, data: string): void {
    if (!this.proc) return;
    if (this.activeTaskId === taskId) {
      this.write(data);
      return;
    }
    let chunks = this.writeBuffer.get(taskId);
    if (chunks === undefined) {
      chunks = [];
      this.writeBuffer.set(taskId, chunks);
    }
    chunks.push(data);
  }

  getQueueDepth(): number {
    return this.getQueuedTaskIds().length;
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  /** Task IDs ordered after the active slot (exclusive of `activeTaskId`). */
  getQueuedTaskIds(): string[] {
    if (this.activeTaskId === null) {
      return this.taskQueue.slice();
    }
    const out: string[] = [];
    for (let i = 0; i < this.taskQueue.length; i++) {
      if (this.taskQueue[i] !== this.activeTaskId) {
        out.push(this.taskQueue[i]);
      }
    }
    return out;
  }

  private routeLineToActiveTask(line: string): void {
    if (!this.activeTaskId) return;
    const handler = this.taskHandlers.get(this.activeTaskId);
    handler?.(line);
  }

  private ingestStdoutLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.routeLineToActiveTask(line);
        return;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      this.routeLineToActiveTask(line);
      return;
    }

    const swallowedCorrelation = this.dispatchStdoutJson(obj);
    if (!swallowedCorrelation) this.routeLineToActiveTask(line);
  }


  /**
   * Register a handler for a task. The handler will receive stdout lines
   * when this task becomes active.
   */
  setLineHandler(taskId: string, handler: (line: string) => void): void {
    this.taskHandlers.set(taskId, handler);
    // If this is the first task and nothing is active, activate immediately
    if (!this.activeTaskId && this.taskQueue.length === 0) {
      this.activeTaskId = taskId;
      this.taskQueue.push(taskId);
      this.promoteActivatedTask(taskId);
    } else {
      this.taskQueue.push(taskId);
    }
  }

  /** Remove a task's handler (e.g., after completion). */
  removeLineHandler(taskId: string): void {
    this.taskHandlers.delete(taskId);
    this.writeBuffer.delete(taskId);
    this.writeWaiters.delete(taskId);
    this.taskQueue = this.taskQueue.filter(id => id !== taskId);
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
      // Activate next task in queue
      this.advanceQueue();
    }
  }

  private advanceQueue(): void {
    if (this.activeTaskId) return;
    while (this.taskQueue.length > 0) {
      const next = this.taskQueue[0];
      if (this.taskHandlers.has(next)) {
        this.activeTaskId = next;
        this.promoteActivatedTask(next);
        return;
      }
      // Handler was removed but task still in queue — skip
      this.taskQueue.shift();
    }
  }

  async ensure(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return; // still alive

    this.resetStatefulSession();

    this.proc = spawn(this.cmd, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: { ...process.env as Record<string, string>, ...this.opts.env },
    });

    // LF-only JSONL reader — protocol compliant
    this.detachReader = attachJsonlReader(this.proc.stdout!, (line) => {
      this.ingestStdoutLine(line);
    });

    this.proc.stderr!.on('data', (_chunk: Buffer) => {
      // stderr from persistent process — log but don't fail
    });

    this.proc.on('exit', () => {
      log('warn', 'persistent_exited', { activeTaskId: this.activeTaskId, queuedCount: this.taskQueue.length });
      if (this.detachReader) { this.detachReader(); this.detachReader = null; }


      for (const [, pend] of [...this.pendingResponses]) {
        try { pend.settle({ success: false, error: 'Persistent process exited before RPC response arrived' }); } catch { /* noop */ }
        clearTimeout(pend.timer);
      }
      this.pendingResponses.clear();

      if (this.activeTaskId && this.taskHandlers.size > 0) {
        const crashedId = this.activeTaskId;
        const remaining = this.taskHandlers.size;
        const errorLine = JSON.stringify({ type: 'error', message: 'Process crashed unexpectedly' });
        for (const [, handler] of this.taskHandlers) {
          try { handler(errorLine); } catch { /* swallow handler errors during crash */ }
        }
        this.onCrash?.(crashedId, remaining);
      }
      this.proc = null;
      this.activeTaskId = null;
      this.clearDeferredWritesState();
    });

    await new Promise<void>((resolve) => {
      this.proc!.once('spawn', () => resolve());
      this.proc!.once('error', () => { this.proc = null; resolve(); });
    });
  }

  /**
   * Auto-respond to Pi extension UI dialog requests.
   *
   * Pi extensions can call ctx.ui.select(), confirm(), input(), editor() —
   * these emit extension_ui_request on stdout and block until we send
   * extension_ui_response on stdin. Without a response, the agent hangs.
   *
   * Fire-and-forget methods (notify, setStatus, setWidget, setTitle,
   * set_editor_text) don't need a response — correctly ignored.
   */
  private handleExtensionUIParsed(e: Record<string, unknown>): void {
    if (typeof e.id !== 'string') return;

    const method = typeof e.method === 'string' ? e.method : '';
    const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
    if (!dialogMethods.has(method)) return;

    const id = e.id;
    let response: Record<string, unknown>;
    if (method === 'confirm') response = { type: 'extension_ui_response', id, confirmed: false };
    else if (method === 'select') response = { type: 'extension_ui_response', id, cancelled: true };
    else response = { type: 'extension_ui_response', id, cancelled: true };

    this.write(JSON.stringify(response) + '\n');
  }

  write(data: string): void {
    if (!this.proc) return;
    this.proc.stdin!.write(data);
  }

  async kill(): Promise<void> {
    if (this.proc) {
      log('info', 'persistent_kill', {});
      if (this.detachReader) { this.detachReader(); this.detachReader = null; }

      for (const [, pend] of [...this.pendingResponses]) {
        try { pend.settle({ success: false, error: 'Persistent process killed' }); } catch { /* noop */ }
        clearTimeout(pend.timer);
      }
      this.pendingResponses.clear();
      for (const { reject } of this.readyWaiters) {
        try { reject(new Error('Persistent process killed')); } catch { /* noop */ }
      }
      this.readyWaiters.length = 0;
      this.hostAbortByRequestId.clear();

      this.proc.kill('SIGTERM');
      this.proc = null;
      this.activeTaskId = null;
      this.clearDeferredWritesState();
    }
  }

  get isAlive(): boolean { return this.proc !== null && this.proc.exitCode === null; }
}

// ─── Detector ─────────────────────────────────────────────────────────────

export async function detectAdapters(adapters: AgentAdapter[]): Promise<Array<{ adapter: AgentAdapter; detection: DetectionResult }>> {
  const results: Array<{ adapter: AgentAdapter; detection: DetectionResult }> = [];
  for (const adapter of adapters) {
    try {
      const detection = await adapter.detect();
      if (detection) results.push({ adapter, detection });
    } catch { /* not installed */ }
  }
  return results.sort((a, b) => a.adapter.tier - b.adapter.tier);
}