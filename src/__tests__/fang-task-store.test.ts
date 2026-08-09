import { describe, it, expect } from 'vitest';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Message, Task, TaskStatus } from '@a2a-js/sdk';
import { FangTaskStore } from '../fang-task-store.ts';

/**
 * Build a v1.0 Task fixture. v1.0 requires:
 *   - `TaskStatus.message` (Message | undefined) — set to undefined when the
 *     task has no message yet (the SDK treats undefined as "no message").
 *   - `TaskStatus.state` is the TaskState enum (TASK_STATE_*), not a
 *     short string literal.
 */
function makeTask(id: string, state: TaskState): Task {
  const now = new Date().toISOString();
  const status: TaskStatus = {
    state,
    message: undefined,
    timestamp: now,
  };
  return {
    id,
    contextId: `ctx-${id}`,
    status,
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

describe('FangTaskStore', () => {
  it('save and load upsert clone', async () => {
    const store = new FangTaskStore();
    const t = makeTask('a', TaskState.TASK_STATE_WORKING);
    await store.save(t);
    const loaded = await store.load('a');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('a');
    expect(loaded!.history).toEqual([]);
    // Mutate the loaded copy and confirm the store's copy is untouched
    // (this is what the clone-on-save contract guarantees).
    loaded!.history = [minimalMessage('m1', Role.ROLE_USER, 'x')];
    const again = await store.load('a');
    expect(again!.history).toEqual([]);
  });

  it('delete removes task', async () => {
    const store = new FangTaskStore();
    await store.save(makeTask('x', TaskState.TASK_STATE_WORKING));
    await store.delete('x');
    expect(await store.load('x')).toBeUndefined();
  });

  it('evicts terminal tasks preferentially beyond maxTasks', async () => {
    const store = new FangTaskStore({ maxTasks: 2 });
    await store.save(makeTask('t1', TaskState.TASK_STATE_COMPLETED));
    await store.save(makeTask('t2', TaskState.TASK_STATE_WORKING));
    await store.save(makeTask('t3', TaskState.TASK_STATE_WORKING));
    expect(await store.load('t1')).toBeUndefined();
    expect(await store.load('t2')).toBeDefined();
    expect(await store.load('t3')).toBeDefined();
  });

  it('cleanupStaleCompleted removes old terminal rows', async () => {
    const store2 = new FangTaskStore({
      completedRetentionMinutes: 0,
    });
    await store2.save(makeTask('old', TaskState.TASK_STATE_COMPLETED));

    interface Intern {
      entries: Map<string, { terminalSinceMs: number | null; task: Task }>;
    }
    const wrap = store2 as unknown as Intern;
    const entry = wrap.entries.get('old');
    expect(entry).toBeDefined();

    Object.assign(entry!, { terminalSinceMs: Date.now() - 10 * 60 * 1000 });

    store2.cleanupStaleCompleted();
    expect(await store2.load('old')).toBeUndefined();
  });
});

/**
 * Build a minimal v1.0 Message. The store doesn't inspect message
 * contents; this is just enough structure for the clone test.
 */
function minimalMessage(messageId: string, role: Role, text: string): Message {
  return {
    messageId,
    contextId: '',
    taskId: '',
    role,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}
