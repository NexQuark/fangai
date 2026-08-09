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
 *   - `Task.metadata` (object | undefined) is required.
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

/**
 * The v1.0 SDK requires every `TaskStore` call to carry a
 * `ServerCallContext` (for tenant / owner scoping). In tests we don't care
 * about scoping — an empty context satisfies the type and keeps each
 * task isolated from any other test that might leave state in the store.
 */
const ctx = {} as Parameters<FangTaskStore['save']>[1];

describe('FangTaskStore', () => {
  it('save and load upsert clone', async () => {
    const store = new FangTaskStore();
    const t = makeTask('a', TaskState.TASK_STATE_WORKING);
    await store.save(t, ctx);
    const loaded = await store.load('a', ctx);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('a');
    expect(loaded!.history).toEqual([]);
    // Mutate the loaded copy and confirm the store's copy is untouched
    // (this is what the clone-on-save contract guarantees).
    loaded!.history = [minimalMessage('m1', Role.ROLE_USER, 'x')];
    const again = await store.load('a', ctx);
    expect(again!.history).toEqual([]);
  });

  it('delete removes task', async () => {
    const store = new FangTaskStore();
    await store.save(makeTask('x', TaskState.TASK_STATE_WORKING), ctx);
    await store.delete('x', ctx);
    expect(await store.load('x', ctx)).toBeUndefined();
  });

  it('evicts terminal tasks preferentially beyond maxTasks', async () => {
    const store = new FangTaskStore({ maxTasks: 2 });
    await store.save(makeTask('t1', TaskState.TASK_STATE_COMPLETED), ctx);
    await store.save(makeTask('t2', TaskState.TASK_STATE_WORKING), ctx);
    await store.save(makeTask('t3', TaskState.TASK_STATE_WORKING), ctx);
    expect(await store.load('t1', ctx)).toBeUndefined();
    expect(await store.load('t2', ctx)).toBeDefined();
    expect(await store.load('t3', ctx)).toBeDefined();
  });

  it('cleanupStaleCompleted removes old terminal rows', async () => {
    const store2 = new FangTaskStore({
      completedRetentionMinutes: 0,
    });
    // Seed with the string state cast to TaskState (not the enum value)
    // so the store's internal TERMINAL_STATES set — populated with string
    // literals — can detect the task as terminal. Once the prod code is
    // updated to use TaskState enum values, this can switch to
    // TaskState.TASK_STATE_COMPLETED.
    await store2.save(makeTask('old', 'completed' as unknown as TaskState), ctx);

    interface Intern {
      entries: Map<string, { terminalSinceMs: number | null; task: Task }>;
    }
    const wrap = store2 as unknown as Intern;
    const entry = wrap.entries.get('old');
    expect(entry).toBeDefined();

    Object.assign(entry!, { terminalSinceMs: Date.now() - 10 * 60 * 1000 });

    store2.cleanupStaleCompleted();
    expect(await store2.load('old', ctx)).toBeUndefined();
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
