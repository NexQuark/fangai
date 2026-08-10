/**
 * @fangai/client — A2A client for discovering and calling fang-wrapped agents
 */

import { randomUUID } from 'node:crypto';

export interface FangAgent {
  name: string;
  url: string;
  tier?: number;
  mode?: string;
  skills?: Array<{ id: string; name: string; tags: string[] }>;
}

export interface TaskResult {
  taskId: string;
  status: string;
  text?: string;
  error?: string;
}

export class FangClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getCard(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/.well-known/agent-card.json`);
    if (!res.ok) throw new Error(`Failed to get card: ${res.status}`);
    return res.json();
  }

  async send(message: string, opts?: { contextId?: string }): Promise<TaskResult> {
    return this.sendStream(message, opts);
  }

  async sendStream(message: string, opts?: { contextId?: string; onProgress?: (text: string) => void; timeout?: number }): Promise<TaskResult> {
    const timeoutMs = opts?.timeout ?? 300_000; // 5 min default
    const res = await fetch(`${this.baseUrl}/a2a/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: randomId(), method: 'message/stream',
        params: {
          message: {
            messageId: randomId(), role: 'user',
            parts: [{ kind: 'text', text: message }],
            ...(opts?.contextId ? { contextId: opts.contextId } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      throw new Error(`Failed to send task: ${res.status} ${res.statusText}`);
    }

    if (contentType.includes('application/json')) {
      const data = await res.json() as any;
      if (data?.error) return { taskId: '', status: 'failed', error: data.error.message };
      const result = data?.result;
      // v0.3 message response (legacy SDK compat for non-streaming clients)
      if (result?.kind === 'message') {
        const text = result.parts?.map((p: any) => p.text).join('') || '';
        return { taskId: '', status: 'completed', text };
      }
      // v1.0 task response: terminal statusUpdate carries the LLM reply
      // in status.message. Extract from there.
      if (result?.kind === 'task' && result.status) {
        const status = result.status;
        if (status.message?.parts) {
          const text = status.message.parts.map((p: any) => p.text).join('') || '';
          return { taskId: result.id || '', status: status.state || 'completed', text };
        }
        return { taskId: result.id || '', status: status.state || 'submitted' };
      }
      return { taskId: result?.id || '', status: result?.status?.state || 'submitted' };
    }

    if (!res.body) throw new Error('Streaming response body was empty');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let taskId = '';
    let finalText = '';
    let lastError: string | undefined;
    let finished = false;

    const processEvent = (raw: string) => {
      const payloadText = raw.split('\n').map(line => line.trimStart()).find(line => line.startsWith('data:'))?.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') return;

      let event: any;
      try {
        event = JSON.parse(payloadText);
      } catch {
        return;
      }

      const result = event?.result;
      if (result?.taskId) taskId = result.taskId;

      const status = result?.status;
      if (status?.state === 'failed') {
        const msg = status?.message?.parts?.map((p: any) => p.text).join('') || status?.message?.parts?.map((p: any) => p.content).join('') || status?.message?.text;
        lastError = msg || 'Task failed';
        finished = true;
        return;
      }

      const artifactText = result?.artifact?.parts?.find((p: any) => typeof p?.text === 'string')?.text;
      if (artifactText && typeof artifactText === 'string') {
        // Try parsing as structured JSON (Pi protocol)
        let inner: any;
        try {
          inner = JSON.parse(artifactText);
        } catch {
          // Plain text artifact — accumulate directly
          if (result?.append) finalText += artifactText;
          else finalText = artifactText;
          opts?.onProgress?.(artifactText);
          return;
        }

        const assistantEvent = inner?.assistantMessageEvent ?? inner;
        if (assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
          opts?.onProgress?.(assistantEvent.delta);
          finalText += assistantEvent.delta;
          return;
        }

        const msg = assistantEvent?.message ?? inner?.message ?? assistantEvent?.partial ?? inner?.partial;
        const content = msg?.content;
        if (Array.isArray(content)) {
          const finalParts = content.filter((part: any) =>
            typeof part?.text === 'string' && typeof part?.textSignature === 'string' && part.textSignature.includes('final_answer'),
          );
          const fallbackParts = content.filter((part: any) =>
            typeof part?.text === 'string' && part.type !== 'thinking',
          );
          const text = (finalParts.length ? finalParts : fallbackParts)
            .map((part: any) => part.text)
            .join('');
          if (text) finalText = text;
        }

        if (assistantEvent?.type === 'message_end' || assistantEvent?.type === 'turn_end') {
          finished = true;
        }
      }

      // Handle final message event (contains accumulated text for oneshot agents)
      if (result?.kind === 'message') {
        const msgText = result.parts?.map((p: any) => p.text).join('') || '';
        if (msgText) finalText = msgText;
        finished = true;
      }

      // Handle status-update with final flag. The terminal statusUpdate
      // carries the LLM reply in status.message.parts (text), or
      // status.message.text (fallback for some wire shapes).
      if (result?.kind === 'status-update' && result?.final) {
        const finalMsg = result.status?.message;
        if (finalMsg) {
          const msgText = finalMsg.parts?.map((p: any) => p.text).join('')
            || finalMsg.text
            || '';
          if (msgText) finalText = msgText;
        }
        finished = true;
      }
    };

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const chunk = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);
        processEvent(chunk);
        if (finished) break;
        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    try { await reader.cancel(); } catch {}
    if (lastError) return { taskId, status: 'failed', error: lastError };
    return { taskId, status: 'completed', text: finalText.trim() };
  }

  private async postJsonRpc(paths: string[], payload: any): Promise<any> {
    let lastError: Error | null = null;

    for (const path of paths) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const text = await res.text();
        if (!text.trim()) {
          lastError = new Error(`Empty response from ${path}`);
          continue;
        }

        try {
          return JSON.parse(text);
        } catch {
          lastError = new Error(`Unexpected non-JSON response from ${path}: ${text.slice(0, 120)}`);
        }
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Failed to call A2A endpoint');
  }

  async health(): Promise<{ ok: boolean; agent: string; mode: string }> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, agent: '', mode: '' };
    return { ok: true, ...(await res.json() as any) };
  }
}

function randomId(): string { return randomUUID(); }

const DEFAULT_DISCOVERY_PORTS = [3001, 3002, 3003, 3004, 3005, 4000, 8080];

/**
 * Discover running fang agents by probing known ports concurrently.
 * Override default ports via DISCOVERY_PORTS env var (comma-separated).
 */
export async function discoverAgents(ports?: number[]): Promise<FangAgent[]> {
  const portList = ports ?? (
    process.env.DISCOVERY_PORTS
      ? process.env.DISCOVERY_PORTS.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      : DEFAULT_DISCOVERY_PORTS
  );

  const results = await Promise.allSettled(
    portList.map(async (port) => {
      const client = new FangClient(`http://localhost:${port}`);
      const card = await client.getCard();
      return {
        name: card.name,
        url: card.url || `http://localhost:${port}`,
        mode: card.capabilities?.streaming ? 'streaming' : undefined,
        skills: card.skills,
      } as FangAgent;
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<FangAgent> => r.status === 'fulfilled')
    .map(r => r.value);
}