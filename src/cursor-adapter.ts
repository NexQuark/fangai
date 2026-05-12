/**
 * Cursor Agent adapter — full-featured integration
 *
 * Two modes:
 * 1. CLI mode (oneshot) — wraps `cursor-agent` CLI with --print --output-format stream-json
 *    Supports: multi-turn via --continue/--resume, model selection, worktree isolation,
 *    streaming partial output, MCP servers, plan mode.
 * 2. SDK mode (persistent) — uses @cursor/sdk for stateful, long-running agents
 *    with full multi-turn conversations, tool streaming, thinking events.
 *
 * The stream-json format from cursor-agent outputs these event types:
 *   - { type: "system", subtype: "init", session_id, model, ... }
 *   - { type: "user", message: { role: "user", content: [...] } }
 *   - { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
 *   - { type: "tool_call", subtype: "started"|"completed", call_id, tool_call: { shellToolCall: { args, result } } }
 *   - { type: "result", subtype: "success"|"error", duration_ms, usage, session_id }
 *
 * NOT the Anthropic-style events (text_delta, content_block_delta) that the old adapter assumed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentTask, FangConfig, AdapterEvent, DetectionResult } from './core.ts';

const execFileAsync = promisify(execFile);

// ─── Session Management ────────────────────────────────────────────────────

/** One exchange kept for cold-start recap when server-side session TTL is exceeded. */
export interface CursorSessionTurn {
  user: string;
  assistant: string;
}

export interface CursorSession {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  workspace: string;
  model: string;
  turnCount: number;
  /** Last N completed turns (user + assistant text) for recap after --continue is unsafe. */
  turns: CursorSessionTurn[];
}

export interface CursorSessionStoreOptions {
  /**
   * Max age since `lastUsedAt` before we drop `lastSession`, skip `--continue`, and inject a recap.
   * `null` / omitted = no TTL (legacy behaviour).
   */
  sessionTtlMs?: number | null;
  /** Max completed turns to retain per session and to include in a cold recap. */
  recapMaxTurns?: number;
  /** Max chars per turn leg stored / echoed in recap (limits huge tool dumps). */
  recapMaxCharsPerLeg?: number;
}

/**
 * In-memory session store for multi-turn Cursor conversations.
 * Tracks session_ids from cursor-agent's --continue/--resume lifecycle.
 */
export class CursorSessionStore {
  private sessions = new Map<string, CursorSession>();
  private lastSessionId: string | null = null;
  private readonly sessionTtlMs: number | null;
  private readonly recapMaxTurns: number;
  private readonly recapMaxCharsPerLeg: number;
  /** Picked up on the next `formatInput` after TTL expiry of `lastSession`. */
  private coldRecapPending: string | null = null;

  constructor(opts: CursorSessionStoreOptions = {}) {
    this.sessionTtlMs = opts.sessionTtlMs === undefined ? null : opts.sessionTtlMs;
    this.recapMaxTurns = opts.recapMaxTurns ?? 8;
    this.recapMaxCharsPerLeg = opts.recapMaxCharsPerLeg ?? 8000;
  }

  /** Register a new session from cursor-agent output */
  register(sessionId: string, workspace: string, model: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = new Date();
      existing.turnCount++;
    } else {
      this.sessions.set(sessionId, {
        id: sessionId,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        workspace,
        model,
        turnCount: 1,
        turns: [],
      });
    }
    this.lastSessionId = sessionId;
  }

  /**
   * If the current `lastSession` is older than `sessionTtlMs`, remove it from the store,
   * queue a cold recap for the next prompt, and clear `lastSession` so the next spawn is fresh.
   */
  expireLastSessionIfStale(nowMs: number = Date.now()): void {
    if (this.sessionTtlMs === null || this.lastSessionId === null) return;
    const s = this.sessions.get(this.lastSessionId);
    if (!s) {
      this.lastSessionId = null;
      return;
    }
    if (nowMs - s.lastUsedAt.getTime() <= this.sessionTtlMs) return;

    const recap = this.buildRecapBlock(s.turns);
    if (recap) this.coldRecapPending = recap;

    this.sessions.delete(this.lastSessionId);
    this.lastSessionId = null;
  }

  /**
   * Pop the cold recap block (from TTL expiry) once, for the next user message.
   */
  consumeColdRecap(): string | null {
    const r = this.coldRecapPending;
    this.coldRecapPending = null;
    return r;
  }

  /** Append a completed turn after a successful `result` event. */
  recordCompletedTurn(sessionId: string | null, user: string, assistant: string): void {
    if (!sessionId) return;
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.turns.push({
      user: this.truncateLeg(user),
      assistant: this.truncateLeg(assistant.trim()),
    });
    while (s.turns.length > this.recapMaxTurns) s.turns.shift();
  }

  /** Get the last active session ID for --continue */
  get lastSession(): string | null {
    return this.lastSessionId;
  }

  /** Get a specific session by ID */
  get(sessionId: string): CursorSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** List all sessions */
  list(): CursorSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime()
    );
  }

  /** Clear all sessions */
  clear(): void {
    this.sessions.clear();
    this.lastSessionId = null;
    this.coldRecapPending = null;
  }

  private truncateLeg(text: string): string {
    const t = text.trim();
    if (t.length <= this.recapMaxCharsPerLeg) return t;
    return `${t.slice(0, this.recapMaxCharsPerLeg)}\n…[truncated]`;
  }

  private buildRecapBlock(turns: CursorSessionTurn[]): string | null {
    if (!turns.length) return null;
    const lines: string[] = [
      '[Fang: Prior Cursor server session likely expired or this is a cold reconnect. Continuity recap — background only; answer the new user message after the separator.]',
      '',
      '### Earlier turns (recap)',
    ];
    const slice = turns.slice(-this.recapMaxTurns);
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i]!;
      lines.push(`${i + 1}. **User:** ${t.user}`);
      lines.push(`   **Assistant:** ${t.assistant}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    return lines.join('\n');
  }
}

// ─── CLI Mode Adapter ──────────────────────────────────────────────────────

export interface CursorAdapterOptions {
  /** Binary name (default: 'cursor-agent') */
  binary?: string;
  /** Default model (default: 'composer-2-fast') */
  defaultModel?: string;
  /** Enable streaming partial output deltas (default: true) */
  streamPartial?: boolean;
  /** Auto-approve all tool calls (default: true for headless) */
  yolo?: boolean;
  /** Trust workspace without prompting (default: true for headless) */
  trust?: boolean;
  /** Max session turns before auto-reset (default: 50) */
  maxSessionTurns?: number;
  /** Use git worktrees for isolation (default: false) */
  useWorktrees?: boolean;
  /** Additional MCP servers to attach */
  mcpServers?: string[];
  /** Session store (shared across adapter instances for multi-chat) */
  sessionStore?: CursorSessionStore;
  /**
   * When set (and no custom `sessionStore`), builds a store with TTL + recap.
   * Ignored if `sessionStore` is provided — configure the store yourself in that case.
   */
  sessionTtlMs?: number | null;
  recapMaxTurns?: number;
  recapMaxCharsPerLeg?: number;
}

/**
 * CursorAgentAdapter — CLI mode, oneshot per task with multi-turn session continuity.
 *
 * How multi-turn works:
 * 1. First task: cursor-agent --print --output-format stream-json --yolo --trust "task"
 *    → captures session_id from the system init event
 * 2. Follow-up task: cursor-agent --print --output-format stream-json --continue "task"
 *    → same session_id, maintains context
 * 3. New conversation: cursor-agent --print --output-format stream-json "task"
 *    → new session_id
 *
 * Each Fang task is a separate cursor-agent process, but sessions persist server-side
 * at Cursor. The adapter tracks session_ids to route follow-ups via --continue.
 *
 * If `sessionTtlMs` is set on the store, stale server sessions are abandoned (no `--continue`)
 * and a short recap of the last N turns is injected into the next prompt so cold starts keep
 * continuity without relying on Cursor holding the session forever.
 */
export class CursorAgentAdapter implements AgentAdapter {
  readonly id = 'cursor-agent';
  readonly tier = 1 as const;
  readonly displayName = 'Cursor Agent';
  readonly mode = 'oneshot' as const;

  readonly binary: string;
  readonly defaultModel: string;
  readonly streamPartial: boolean;
  readonly yolo: boolean;
  readonly trust: boolean;
  readonly maxSessionTurns: number;
  readonly useWorktrees: boolean;
  readonly mcpServers: string[];
  readonly sessionStore: CursorSessionStore;

  /** Accumulated assistant-visible output for the current task (recap storage). */
  private taskUserForRecap = '';
  private taskAssistantForRecap = '';

  skills = [
    { id: 'code', name: 'Code generation & editing', tags: ['typescript', 'python', 'react', 'go', 'rust'] },
    { id: 'reasoning', name: 'Complex reasoning', tags: ['reasoning', 'architecture', 'debugging', 'design'] },
    { id: 'plan', name: 'Planning & analysis', tags: ['plan', 'review', 'refactor', 'audit'] },
    { id: 'debug', name: 'Debug & fix', tags: ['debug', 'error', 'fix', 'stack-trace'] },
    { id: 'multi-file', name: 'Multi-file refactoring', tags: ['refactor', 'rename', 'extract', 'move'] },
    { id: 'test', name: 'Test writing & fixing', tags: ['test', 'jest', 'vitest', 'pytest'] },
  ];

  constructor(opts: CursorAdapterOptions = {}) {
    this.binary = opts.binary ?? 'cursor-agent';
    this.defaultModel = opts.defaultModel ?? 'gpt-5.3-codex';
    this.streamPartial = opts.streamPartial ?? true;
    this.yolo = opts.yolo ?? true;
    this.trust = opts.trust ?? true;
    this.maxSessionTurns = opts.maxSessionTurns ?? 50;
    this.useWorktrees = opts.useWorktrees ?? false;
    this.mcpServers = opts.mcpServers ?? [];
    this.sessionStore = opts.sessionStore ?? new CursorSessionStore({
      sessionTtlMs: opts.sessionTtlMs,
      recapMaxTurns: opts.recapMaxTurns,
      recapMaxCharsPerLeg: opts.recapMaxCharsPerLeg,
    });
  }

  buildArgs(task: AgentTask, config: FangConfig): string[] {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
    ];

    // Streaming partial output (text deltas per token)
    if (this.streamPartial) {
      args.push('--stream-partial-output');
    }

    // Headless flags
    if (this.yolo) args.push('--yolo');
    if (this.trust) args.push('--trust');

    // Model selection: from task metadata > config > default
    const model = (task.context?.metadata?.model as string)
      ?? config.agentFlags?.find((_, i, arr) => arr[i - 1] === '--model')
      ?? this.defaultModel;
    args.push('--model', model);

    // Workspace: from task context > config
    const workspace = task.context?.workdir ?? config.workdir;
    if (workspace) {
      args.push('--workspace', workspace);
    }

    this.sessionStore.expireLastSessionIfStale();

    // Session continuity: continue last session or resume specific one
    const resumeSession = task.context?.metadata?.resumeSession as string | undefined;
    const continueLast = task.context?.metadata?.continueLast as boolean | undefined;
    const newChat = task.context?.metadata?.newChat as boolean | undefined;

    if (resumeSession) {
      args.push('--resume', resumeSession);
    } else if (continueLast && this.sessionStore.lastSession) {
      args.push('--continue');
    } else if (!newChat && this.sessionStore.lastSession) {
      // Default: continue if we have a session and user didn't opt out
      const session = this.sessionStore.get(this.sessionStore.lastSession);
      if (session && session.turnCount < this.maxSessionTurns) {
        args.push('--continue');
      }
      // If session hit max turns, start fresh (no --continue)
    }

    // Plan mode (read-only)
    if (task.context?.metadata?.planMode) {
      args.push('--plan');
    }

    // Worktree isolation
    if (this.useWorktrees && task.context?.metadata?.isolated !== false) {
      const worktreeName = task.context?.metadata?.worktreeName as string | undefined;
      if (worktreeName) {
        args.push('--worktree', worktreeName);
      } else {
        args.push('--worktree');
      }
    }

    // MCP servers
    for (const mcp of this.mcpServers) {
      args.push('--approve-mcps');
      // MCP servers configured in ~/.cursor/mcp.json or project .cursor/mcp.json
    }

    return args;
  }

  formatInput(task: AgentTask): string {
    // The prompt is passed as the first positional argument to cursor-agent,
    // NOT via stdin. But since Fang pipes via stdin, we return the message.
    // cursor-agent --print reads stdin as the prompt when no positional args given.
    this.taskAssistantForRecap = '';
    this.taskUserForRecap = task.message;
    const newChat = task.context?.metadata?.newChat === true;
    let recap: string | null = null;
    if (newChat) {
      this.sessionStore.consumeColdRecap();
    } else {
      recap = this.sessionStore.consumeColdRecap();
    }
    const body = `${task.message}\n`;
    return recap ? `${recap}${body}` : body;
  }

  parseLine(line: string): AdapterEvent[] {
    if (!line.trim()) return [];

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // Non-JSON output — treat as raw text (cursor-agent startup messages, etc.)
      return [{ type: 'text-delta', text: line.trimEnd() }];
    }

    switch (obj.type) {
      // ── System init ─────────────────────────────────────────────────
      case 'system': {
        // Capture session_id for multi-turn continuity
        if (obj.session_id) {
          this.sessionStore.register(
            obj.session_id,
            obj.cwd ?? '',
            obj.model ?? ''
          );
        }
        return []; // Don't emit system events to A2A clients
      }

      // ── User echo ───────────────────────────────────────────────────
      case 'user':
        return []; // Don't echo user messages back

      // ── Assistant text ──────────────────────────────────────────────
      case 'assistant': {
        // When streaming partials, each token delta has timestamp_ms.
        // The final consolidated event (no timestamp_ms) is a duplicate.
        // Skip it to prevent doubled text.
        // When NOT streaming, there are no partials — every assistant event
        // is the actual response. Emit it.
        if (this.streamPartial && !obj.timestamp_ms) return [];
        const content = obj.message?.content;
        if (!Array.isArray(content)) return [];

        const events: AdapterEvent[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text-delta', text: block.text });
            this.taskAssistantForRecap += block.text;
          }
          // Thinking blocks could be here too in some models
          if (block.type === 'thinking' && block.thinking) {
            events.push({ type: 'thinking', text: block.thinking });
          }
        }
        return events;
      }

      // ── Tool calls ──────────────────────────────────────────────────
      case 'tool_call': {
        const callData = obj.tool_call;

        if (obj.subtype === 'started') {
          // Extract tool name from the nested structure
          const toolName = this.extractToolName(callData);
          const description = this.extractToolDescription(callData);
          return [{
            type: 'tool-call',
            tool: toolName,
            input: { description, command: this.extractCommand(callData) },
          }];
        }

        if (obj.subtype === 'completed') {
          const result = this.extractToolResult(callData);
          const isError = !result.success;

          // Emit the tool output as text delta (the actual command output)
          const events: AdapterEvent[] = [];
          const stdout = result.stdout?.trim();
          if (stdout) {
            events.push({ type: 'text-delta', text: stdout });
            this.taskAssistantForRecap += stdout;
          }
          events.push({
            type: 'tool-result',
            tool: this.extractToolName(callData),
            output: stdout || (result.stderr?.trim() || 'done'),
            isError,
          });
          return events;
        }

        return [];
      }

      // ── Result (completion) ─────────────────────────────────────────
      case 'result': {
        if (obj.subtype === 'error' || obj.is_error) {
          this.resetRecapTaskState();
          return [{ type: 'error', message: obj.result || 'Cursor agent error' }];
        }

        const events: AdapterEvent[] = [];

        // Emit the final result text if present (may duplicate streamed text)
        // Only emit if it contains new info not already streamed
        const resultText = obj.result;
        if (resultText && typeof resultText === 'string' && resultText.trim()) {
          // Result text is typically a summary — we already streamed the full output
          // Don't re-emit to avoid duplication
        }

        this.sessionStore.recordCompletedTurn(
          this.sessionStore.lastSession,
          this.taskUserForRecap,
          this.taskAssistantForRecap,
        );
        this.resetRecapTaskState();

        events.push({ type: 'status', state: 'completed' });
        return events;
      }

      // ── Status updates ──────────────────────────────────────────────
      case 'status':
        return [{ type: 'status', state: 'working' }];

      // ── Errors ──────────────────────────────────────────────────────
      case 'error': {
        this.resetRecapTaskState();
        return [{ type: 'error', message: String(obj.message || obj.error || 'Unknown cursor error') }];
      }

      // ── Fallback ────────────────────────────────────────────────────
      default: {
        // Try to extract text from unknown event shapes
        if (obj.text) return [{ type: 'text-delta', text: obj.text }];
        if (obj.result?.text) return [{ type: 'text-delta', text: obj.result.text }];
        return [];
      }
    }
  }

  async detect(): Promise<DetectionResult | null> {
    try {
      const { stdout } = await execFileAsync('which', [this.binary], { timeout: 5000 });
      const path = stdout.trim();

      // Get version
      let version = 'unknown';
      try {
        const { stdout: vOut } = await execFileAsync(this.binary, ['--version'], { timeout: 5000 });
        const match = vOut.match(/(\d+\.\d+\.\d+(?:[-+.\w]*)?)/);
        version = match ? match[1] : vOut.trim();
      } catch {}

      return { binary: this.binary, version, path, tier: 1, protocol: 'stream-json' };
    } catch {
      // Fallback: check common paths
      try {
        const { stdout } = await execFileAsync('which', ['agent'], { timeout: 5000 });
        if (stdout.includes('cursor-agent') || stdout.includes('agent')) {
          return { binary: 'agent', version: 'unknown', path: stdout.trim(), tier: 1, protocol: 'stream-json' };
        }
      } catch {}
      return null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private resetRecapTaskState(): void {
    this.taskUserForRecap = '';
    this.taskAssistantForRecap = '';
  }

  private extractToolName(callData: any): string {
    if (!callData) return 'tool';
    // Cursor-agent uses different property names per tool type
    if (callData.shellToolCall) return 'shell';
    if (callData.editToolCall) return 'edit_file';
    if (callData.fileReadToolCall) return 'read_file';
    if (callData.fileWriteToolCall) return 'write_file';
    if (callData.fileEditToolCall) return 'edit_file';
    if (callData.searchToolCall) return 'search';
    if (callData.mcpToolCall) return 'mcp';
    if (callData.globToolCall) return 'glob';
    if (callData.lsToolCall) return 'ls';
    if (callData.grepToolCall) return 'grep';
    return 'tool';
  }

  private extractToolDescription(callData: any): string {
    if (!callData) return '';
    // Shell tool
    if (callData.shellToolCall?.args?.description) return callData.shellToolCall.args.description;
    if (callData.shellToolCall?.args?.command) return callData.shellToolCall.args.command;
    // Edit tool
    if (callData.editToolCall?.args?.path) return `Edit: ${callData.editToolCall.args.path}`;
    // Read tool
    if (callData.fileReadToolCall?.args?.path) return `Read: ${callData.fileReadToolCall.args.path}`;
    return '';
  }

  private extractCommand(callData: any): string {
    if (!callData) return '';
    return callData.shellToolCall?.args?.command
      ?? callData.editToolCall?.args?.path
      ?? callData.fileReadToolCall?.args?.path
      ?? '';
  }

  private extractToolResult(callData: any): { success: boolean; stdout: string; stderr: string } {
    if (!callData) return { success: true, stdout: '', stderr: '' };

    // Shell tool result
    const shellResult = callData.shellToolCall?.result;
    if (shellResult) {
      if (shellResult.success) {
        return {
          success: true,
          stdout: shellResult.success.stdout ?? '',
          stderr: shellResult.success.stderr ?? '',
        };
      }
      if (shellResult.error) {
        return {
          success: false,
          stdout: shellResult.error.stdout ?? '',
          stderr: shellResult.error.stderr ?? shellResult.error.message ?? '',
        };
      }
    }

    // Edit tool result
    const editResult = callData.editToolCall?.result;
    if (editResult) {
      if (editResult.success) {
        return {
          success: true,
          stdout: editResult.success.message ?? `Wrote ${editResult.success.linesAdded ?? '?'} lines`,
          stderr: '',
        };
      }
      if (editResult.error) {
        return { success: false, stdout: '', stderr: editResult.error.message ?? 'Edit failed' };
      }
    }

    return { success: true, stdout: 'done', stderr: '' };
  }
}
