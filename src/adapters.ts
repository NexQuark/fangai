/**
 * Pi adapter — persistent RPC mode via --mode rpc
 * Tier 1. Full bidirectional JSONL protocol.
 *
 * Pi RPC protocol (JSONL over stdio):
 *   INPUT:  {"id":"<taskId>","type":"prompt","message":"<text>"}\n
 *   OUTPUT: RpcCommand / event matrix — `oh-my-pi/docs/rpc.md` (vendored sibling in this repo).
 *
 * Event types from Pi:
 *   agent_start, agent_end, turn_start, turn_end,
 *   message_start, message_update, message_end,
 *   tool_execution_start, tool_execution_update, tool_execution_end,
 *   queue_update, compaction_start/end, auto_retry_start/end,
 *   extension_error, extension_ui_request
 *
 * assistantMessageEvent types:
 *   start, text_start, text_delta, text_end,
 *   thinking_start, thinking_delta, thinking_end,
 *   toolcall_start, toolcall_delta, toolcall_end,
 *   done, error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentAdapter,
  AgentTask,
  FangConfig,
  AdapterEvent,
  DetectionResult,
  PersistentAttachableAdapter,
  PersistentProcess,
  RpcParsedResponse,
  RpcHostToolExecutor,
} from './core.ts';

const execFileAsync = promisify(execFile);

/** Resolve a binary path using system `which` — avoids the `which` npm package ESM bug on Node 24. */
async function whichBinary(binary: string): Promise<string> {
  const { stdout } = await execFileAsync('which', [binary], { timeout: 5000 });
  return stdout.trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Escape special regex characters in a string for use in RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract a semver-like version string from CLI output. */
function parseVersion(output: string): string {
  const match = output.match(/(\d+\.\d+\.\d+(?:[-+.\w]*)?)/);
  return match ? match[1] : 'unknown';
}

/** Run `binary --version` and return the parsed version, or 'unknown'. */
async function detectVersion(binary: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 5000 });
    return parseVersion(stdout.trim());
  } catch {
    // Fallback: try -v
    try {
      const { stdout } = await execFileAsync(binary, ['-v'], { timeout: 5000 });
      return parseVersion(stdout.trim());
    } catch {
      return 'unknown';
    }
  }
}

async function resolvePiBinary(): Promise<{ cmd: string; path: string }> {
  for (const cand of ['pi', 'omp'] as const) {
    try {
      const pathResolved = await whichBinary(cand);
      return { cmd: cand, path: pathResolved };
    } catch {
      continue;
    }
  }
  throw new Error('Neither pi nor omp on PATH');
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function stringifyToolChunksFromResult(resultUnknown: unknown): string {
  if (!isRecord(resultUnknown)) return '';
  const content = resultUnknown.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const piece of content) {
    if (!isRecord(piece)) continue;
    if (piece.type === 'text' && typeof piece.text === 'string') out += piece.text;
    else out += `${JSON.stringify(piece)}\n`;
  }
  return out;
}

function parseToolArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      const nested = JSON.parse(raw);
      return isRecord(nested) ? nested : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(raw) ? raw : undefined;
}

function parseAssistantEnvelope(evtUnknown: unknown): AdapterEvent[] {
  if (!isRecord(evtUnknown)) return [];
  return parseAssistantMessageEvent(evtUnknown);
}

function parseAssistantMessageEvent(evtVal: Record<string, unknown>): AdapterEvent[] {
  const evtTypeVal = evtVal.type;
  if (typeof evtTypeVal !== 'string') return [];

  if (evtTypeVal === 'text_delta' && typeof evtVal.delta === 'string')
    return [{ type: 'text-delta', text: evtVal.delta }];
  if (evtTypeVal === 'thinking_delta' && typeof evtVal.delta === 'string')
    return [{ type: 'thinking', text: evtVal.delta }];

  if (evtTypeVal === 'toolcall_end') {
    const tc = evtVal.toolCall;
    if (!isRecord(tc)) return [];
    const nm = tc.name;
    const nameVal = typeof nm === 'string' ? nm : 'unknown';
    return [{ type: 'tool-call', tool: nameVal, input: parseToolArguments(tc.arguments) }];
  }

  switch (evtTypeVal) {
    case 'start':
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_end':
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'done':
      return [];

    case 'error': {
      const r = evtVal.reason;
      const er = evtVal.error;
      const msg =
        typeof r === 'string' ? r : typeof er === 'string' ? er : 'Streaming error';
      return [{ type: 'error', message: msg }];
    }

    default:
      return [];
  }
}

/** Optional `AgentTask.context.metadata.pi` for steering / queued follow-ups. */
export type PiInputMode = 'prompt' | 'steer' | 'follow_up' | 'abort';
export interface PiTaskDirective {
  inputType?: PiInputMode;
  streamingBehavior?: 'steer' | 'followUp';
}
export interface PiTodoTaskWire { id: string; content: string; status: string }
export interface PiTodoPhaseWire { id?: string; name: string; tasks: PiTodoTaskWire[] }
export interface PiRpcSessionState {
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  interruptMode?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  queuedMessageCount?: number;
  todoPhases?: PiTodoPhaseWire[];
  model?: { provider?: string; id?: string };
}
export interface PiHostToolDefinitionWire {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

export class PiAdapter implements AgentAdapter, PersistentAttachableAdapter {
  readonly id = 'pi';
  readonly tier = 1 as const;
  readonly displayName = 'Pi';
  readonly mode = 'persistent' as const;
  readonly binary = 'pi';
  /** Populated via `detect()` — first match between `pi` and `omp` */
  resolvedBinary = 'pi';
  resolvedPath?: string;

  private proc: PersistentProcess | null = null;
  private lastHostDefs: PiHostToolDefinitionWire[] | null = null;

  skills = [
    { id: 'code', name: 'Code any task', tags: ['typescript', 'python', 'bash', 'react', 'go'] },
    { id: 'refactor', name: 'Refactor', tags: ['refactor', 'clean', 'types'] },
    { id: 'debug', name: 'Debug & fix', tags: ['debug', 'error', 'fix'] },
  ];

  attachPersistent(proc: PersistentProcess): void | Promise<void> {
    this.proc = proc;
    if (this.lastHostDefs?.length) void this.refreshHostDefinitions();
  }

  detachPersistent(): void | Promise<void> {
    this.proc?.setHostToolExecutor(undefined);
    this.proc = null;
  }

  private requirePersistent(): PersistentProcess {
    const p = this.proc;
    if (!p) throw new Error('PiAdapter PersistentProcess not bound yet (BridgeExecutor calls attachPersistent after spawn)');
    return p;
  }

  async refreshHostDefinitions(opts?: { timeoutMs?: number }): Promise<void> {
    const defs = this.lastHostDefs;
    if (!defs?.length) return;
    const p = this.proc;
    if (!p) return;
    await p.sendRpcCommand({ type: 'set_host_tools', tools: defs }, opts);
  }

  async sendCommand(
    payload: Record<string, unknown>,
    opts?: { timeoutMs?: number; correlationId?: string },
  ): Promise<RpcParsedResponse> {
    return this.requirePersistent().sendRpcCommand(payload, opts);
  }

  async setModel(provider: string, modelId: string, opts?: { timeoutMs?: number }): Promise<void> {
    const r = await this.sendCommand({ type: 'set_model', provider, modelId }, opts);
    if (!r.success) throw new Error(`set_model failed: ${r.error ?? 'unknown'}`);
  }

  async getState(opts?: { timeoutMs?: number }): Promise<PiRpcSessionState> {
    const r = await this.sendCommand({ type: 'get_state' }, opts);
    if (!r.success || r.data === undefined) throw new Error(`get_state failed: ${r.error ?? ''}`);
    return r.data as PiRpcSessionState;
  }

  async setTodos(phases: PiTodoPhaseWire[], opts?: { timeoutMs?: number }): Promise<PiTodoPhaseWire[]> {
    const r = await this.sendCommand({ type: 'set_todos', phases }, opts);
    if (!r.success || r.data === undefined) throw new Error(`set_todos failed: ${r.error ?? ''}`);
    const phasesOut = isRecord(r.data) ? r.data.todoPhases : undefined;
    return Array.isArray(phasesOut) ? (phasesOut as PiTodoPhaseWire[]) : phases;
  }

  async setHostTools(
    defs: PiHostToolDefinitionWire[],
    executor?: RpcHostToolExecutor,
    opts?: { timeoutMs?: number },
  ): Promise<string[]> {
    this.lastHostDefs = defs.slice();
    const p = this.requirePersistent();
    p.setHostToolExecutor(executor);
    const r = await p.sendRpcCommand({ type: 'set_host_tools', tools: defs }, opts);
    if (!r.success || r.data === undefined) throw new Error(`set_host_tools failed: ${r.error ?? ''}`);
    const namesUnknown = isRecord(r.data) ? r.data.toolNames : undefined;
    return Array.isArray(namesUnknown) ? namesUnknown.map(v => String(v)) : defs.map(d => d.name);
  }

  async compact(customInstructions?: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    const payload: Record<string, unknown> = { type: 'compact' };
    if (typeof customInstructions === 'string') payload.customInstructions = customInstructions;
    const r = await this.sendCommand(payload, opts);
    if (!r.success) throw new Error(`compact failed: ${r.error ?? ''}`);
    return r.data;
  }

  async setAutoCompaction(enabled: boolean, opts?: { timeoutMs?: number }): Promise<void> {
    const r = await this.sendCommand({ type: 'set_auto_compaction', enabled }, opts);
    if (!r.success) throw new Error(`set_auto_compaction failed: ${r.error ?? ''}`);
  }

  /** oh-my-pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). */
  async setThinkingLevel(level: string, opts?: { timeoutMs?: number }): Promise<void> {
    const r = await this.sendCommand({ type: 'set_thinking_level', level }, opts);
    if (!r.success) throw new Error(`set_thinking_level failed: ${r.error ?? ''}`);
  }

  async cycleThinkingLevel(opts?: { timeoutMs?: number }): Promise<unknown> {
    const r = await this.sendCommand({ type: 'cycle_thinking_level' }, opts);
    if (!r.success) throw new Error(`cycle_thinking_level failed: ${r.error ?? ''}`);
    return r.data;
  }

  async cycleModel(opts?: { timeoutMs?: number }): Promise<unknown> {
    const r = await this.sendCommand({ type: 'cycle_model' }, opts);
    if (!r.success) throw new Error(`cycle_model failed: ${r.error ?? ''}`);
    return r.data;
  }

  async getAvailableModels(opts?: { timeoutMs?: number }): Promise<unknown> {
    const r = await this.sendCommand({ type: 'get_available_models' }, opts);
    if (!r.success || r.data === undefined) throw new Error(`get_available_models failed: ${r.error ?? ''}`);
    return r.data;
  }

  async bash(command: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    const r = await this.sendCommand({ type: 'bash', command }, opts);
    if (!r.success || r.data === undefined) throw new Error(`bash failed: ${r.error ?? ''}`);
    return r.data;
  }

  async abortBash(opts?: { timeoutMs?: number }): Promise<void> {
    const r = await this.sendCommand({ type: 'abort_bash' }, opts);
    if (!r.success) throw new Error(`abort_bash failed: ${r.error ?? ''}`);
  }

  buildArgs(_task: AgentTask, _config: FangConfig): string[] {
    return ['--mode', 'rpc'];
  }

  formatInput(task: AgentTask): string {
    const metaUnknown = task.context?.metadata;
    let piDirective: PiTaskDirective | undefined;
    if (isRecord(metaUnknown) && metaUnknown.pi !== undefined && isRecord(metaUnknown.pi))
      piDirective = metaUnknown.pi as PiTaskDirective;

    if (!piDirective?.inputType || piDirective.inputType === 'prompt') {
      const body: Record<string, unknown> = { id: task.id, type: 'prompt', message: task.message };
      if (piDirective?.streamingBehavior) body.streamingBehavior = piDirective.streamingBehavior;
      return JSON.stringify(body) + '\n';
    }

    if (piDirective.inputType === 'steer')
      return JSON.stringify({ id: task.id, type: 'steer', message: task.message }) + '\n';
    if (piDirective.inputType === 'follow_up')
      return JSON.stringify({ id: task.id, type: 'follow_up', message: task.message }) + '\n';

    return JSON.stringify({ id: task.id, type: 'abort' }) + '\n';
  }

  parseLine(line: string): AdapterEvent[] {
    let rec: Record<string, unknown>;
    try {
      const parsedUnknown: unknown = JSON.parse(line);
      if (!isRecord(parsedUnknown)) return [];
      rec = parsedUnknown;
    } catch {
      return [];
    }

    switch (rec.type) {
      case 'extension_ui_request':
      case 'response':
        return [];

      case 'ready':
        return [{ type: 'status', state: 'working' }];

      case 'message_update':
        return parseAssistantEnvelope(rec.assistantMessageEvent);

      case 'message_start':
      case 'message_end':
        return [];

      case 'turn_end':
        return [{ type: 'status', state: 'completed' }];

      case 'tool_execution_start':
        return [{ type: 'status', state: 'working' }];
      case 'tool_execution_update':
        return [{ type: 'status', state: 'working' }];
      case 'tool_execution_end': {
        const tnUnknown = rec.toolName;
        const tn = typeof tnUnknown === 'string' ? tnUnknown : 'unknown';
        return [{
          type: 'tool-result',
          tool: tn,
          output: stringifyToolChunksFromResult(rec.result),
          isError: !!rec.isError,
        }];
      }

      case 'agent_start':
      case 'turn_start':
        return [{ type: 'status', state: 'working' }];
      case 'agent_end':
        return [{ type: 'status', state: 'completed' }];

      case 'auto_retry_start':
        return [{ type: 'status', state: 'working' }];
      case 'auto_retry_end':
        return [];

      case 'auto_compaction_start':
        return [{ type: 'status', state: 'working' }, { type: 'protocol-log', subtype: 'auto-compaction-start' }];
      case 'auto_compaction_end':
        return [{ type: 'protocol-log', subtype: 'auto-compaction-end' }];

      case 'ttsr_triggered':
        return [{ type: 'protocol-log', subtype: 'ttsr-triggered' }];
      case 'todo_reminder':
        return [{ type: 'protocol-log', subtype: 'todo-reminder' }];
      case 'todo_auto_clear':
        return [{ type: 'protocol-log', subtype: 'todo-auto-clear' }];

      case 'extension_error':
        return [{
          type: 'error',
          message: typeof rec.error === 'string' ? rec.error : 'Extension error',
          code: 'extension_error',
        }];

      case 'host_tool_call': {
        const rid = typeof rec.id === 'string' ? rec.id : '';
        const tcid = typeof rec.toolCallId === 'string' ? rec.toolCallId : '';
        const nameVal = typeof rec.toolName === 'string' ? rec.toolName : 'unknown_tool';
        const argsUnknown = rec.arguments;
        const innerArgs = isRecord(argsUnknown) ? argsUnknown : {};
        return [{ type: 'host-tool-request', requestId: rid, toolCallId: tcid, tool: nameVal, input: innerArgs }];
      }

      case 'host_tool_cancel':
        return [{
          type: 'host-tool-cancel',
          cancelId: typeof rec.id === 'string' ? rec.id : '',
          targetRequestId: typeof rec.targetId === 'string' ? rec.targetId : '',
        }];

      case 'error': {
        const errUnknown = rec.error ?? rec.message;
        return [{ type: 'error', message: typeof errUnknown === 'string' ? errUnknown : 'Unknown pi error' }];
      }

      default:
        return [];
    }
  }

  async detect(): Promise<DetectionResult | null> {
    try {
      const resolved = await resolvePiBinary();
      this.resolvedBinary = resolved.cmd;
      this.resolvedPath = resolved.path;
      const version = await detectVersion(resolved.cmd);
      return { binary: resolved.cmd, version, path: resolved.path, tier: 1, protocol: 'jsonl-rpc' };
    } catch {
      return null;
    }
  }
}

/**
 * Claude Code adapter — stream-json print mode
 * Tier 1. Uses -p --output-format stream-json --verbose.
 * Event types: system, assistant (with message.content), result, error.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly binary = 'claude';
  readonly tier = 1 as const;
  readonly displayName = 'Claude Code';
  readonly mode = 'oneshot' as const;
  skills = [
    { id: 'reasoning', name: 'Complex reasoning', tags: ['reasoning', 'architecture', 'design'] },
    { id: 'code', name: 'Code generation', tags: ['typescript', 'python', 'system-design'] },
  ];

  buildArgs(task: AgentTask, config: FangConfig): string[] {
    const maxTurns = config.agentFlags?.find((f, i, arr) => arr[i - 1] === '--max-turns') ?? '10';
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', maxTurns];
    if (task.context?.workdir) args.push('--cwd', task.context.workdir);
    else if (config.workdir) args.push('--cwd', config.workdir);
    if (config.agentFlags?.length) {
      // Skip --max-turns from agentFlags since we already set it
      const filtered = config.agentFlags.filter((f, i, arr) => f !== '--max-turns' && arr[i - 1] !== '--max-turns');
      args.push(...filtered);
    }
    return args;
  }

  formatInput(task: AgentTask): string {
    return task.message;
  }

  parseLine(line: string): AdapterEvent[] {
    if (!line.trim()) return [];
    let obj: any;
    try { obj = JSON.parse(line); } catch {
      return [{ type: 'text-delta', text: line + '\n' }];
    }

    switch (obj.type) {
      // Claude stream-json format: type=assistant has message.content[].text
      case 'assistant': {
        const text = obj.message?.content
          ?.filter((p: any) => p.type === 'text')
          ?.map((p: any) => p.text)
          ?.join('') || '';
        return text ? [{ type: 'text-delta', text }] : [];
      }
      case 'result':
        return [{ type: 'status', state: obj.is_error ? 'failed' : 'completed' }];
      case 'error':
        return [{ type: 'error', message: String(obj.message || 'Unknown error') }];
      case 'system':
      case 'rate_limit_event':
        return [];
      default:
        return obj.text ? [{ type: 'text-delta', text: obj.text }] : [];
    }
  }

  async detect(): Promise<DetectionResult | null> {
    try {
      const path = await whichBinary(this.binary);
      const version = await detectVersion(this.binary);
      return { binary: this.binary, version, path, tier: 1, protocol: 'stream-json' };
    } catch { return null; }
  }
}

/**
 * OpenCode adapter
 * Tier 2. Supports -f json and ACP stdio.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly binary = 'opencode';
  readonly tier = 2 as const;
  readonly displayName = 'OpenCode';
  readonly mode = 'oneshot' as const;
  skills = [
    { id: 'code', name: 'Code tasks', tags: ['typescript', 'python'] },
  ];

  buildArgs(task: AgentTask, config: FangConfig): string[] {
    const args = ['run', '--format', 'json'];
    if (task.context?.workdir) args.push('--dir', task.context.workdir);
    else if (config.workdir) args.push('--dir', config.workdir);
    // OpenCode takes message as positional args, not stdin
    args.push(task.message);
    return args;
  }

  formatInput(_task: AgentTask): string {
    // Message already in buildArgs; return empty for stdin
    return '';
  }

  parseLine(line: string): AdapterEvent[] {
    if (!line.trim()) return [];
    try {
      const obj = JSON.parse(line);
      const text = obj.text || obj.content || obj.part?.text || '';
      if (obj.type === 'text' || obj.type === 'response') return [{ type: 'text-delta', text }];
      if (obj.type === 'content') return [{ type: 'text-delta', text }];
      if (obj.type === 'done' || obj.type === 'complete' || obj.type === 'step_finish') return [{ type: 'status', state: 'completed' }];
      if (obj.type === 'error') return [{ type: 'error', message: obj.message || obj.part?.message || 'OpenCode error' }];
      return [];
    } catch {
      return [{ type: 'text-delta', text: line.trim() }];
    }
  }

  async detect(): Promise<DetectionResult | null> {
    try {
      const path = await whichBinary(this.binary);
      const version = await detectVersion(this.binary);
      return { binary: this.binary, version, path, tier: 2, protocol: 'json' };
    } catch { return null; }
  }
}

/**
 * Generic adapter — fallback for any CLI
 * Tier 3. Text passthrough.
 */
export class GenericAdapter implements AgentAdapter {
  readonly id = 'generic';
  readonly binary = '';
  readonly tier = 3 as const;
  readonly displayName = 'Generic CLI';
  readonly mode = 'oneshot' as const;
  private cliCommand: string;
  skills = [{ id: 'generic', name: 'CLI task', tags: ['code'] }];

  constructor(cliCommand?: string) { this.cliCommand = cliCommand || ''; }

  buildArgs(_task: AgentTask, _config: FangConfig): string[] { return []; }
  formatInput(task: AgentTask): string { return task.message + '\n'; }
  parseLine(line: string): AdapterEvent[] {
    if (!line.trim()) return [];
    return [{ type: 'text-delta', text: line.trim() }];
  }
  async detect(): Promise<DetectionResult | null> {
    if (!this.cliCommand) return null;
    try {
      const [cmd] = this.cliCommand.split(' ');
      const path = await whichBinary(cmd);
      const version = await detectVersion(cmd);
      return { binary: cmd, version, path, tier: 3, protocol: 'text' };
    } catch { return null; }
  }
}

// ─── Registry ──────────────────────────────────────────────────────────────

import { CursorAgentAdapter } from './cursor-adapter.ts';

export const ALL_ADAPTERS: AgentAdapter[] = [
  new PiAdapter(),
  new ClaudeAdapter(),
  new CursorAgentAdapter(),
  new OpenCodeAdapter(),
];

export function detectAdapter(cli: string): AgentAdapter {
  // Match binary name bounded by non-hyphen word boundaries or path separators.
  // e.g. "some-pi-wrapper" should NOT match "pi", but "pi" and "/usr/bin/pi" should.
  for (const adapter of ALL_ADAPTERS) {
    if (!adapter.binary) continue;
    // Allow path separators (/) and start/end of string as boundaries,
    // but NOT hyphens — they're part of command names.
    const re = new RegExp('(?:^|[/\\s])' + escapeRegex(adapter.binary) + '(?:$|[/\\s])');
    if (re.test(cli)) return adapter;
  }

  // Fallback: try CursorAgentAdapter for 'cursor-agent' or 'agent' with --print
  if (cli.includes('cursor-agent') || (cli.includes('agent') && cli.includes('--print'))) {
    return new CursorAgentAdapter();
  }

  return new GenericAdapter(cli);
}