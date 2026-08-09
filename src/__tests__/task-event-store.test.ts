import { describe, it, expect } from 'vitest';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import { TaskEventStore } from '../task-event-store.ts';

/**
 * Minimal v1.0 Message fixture for the event store tests. The store doesn't
 * inspect message contents, so we only need enough structure to satisfy the
 * SDK's v1.0 type (required contextId, taskId, metadata, extensions,
 * referenceTaskIds) and the Part v1.0 shape (required filename, mediaType;
 * content as a discriminated { $case, value } union).
 */
function makeMsg(seq: number): Message {
  return {
    messageId: `m${seq}`,
    contextId: '',
    taskId: '',
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'text', value: `chunk ${seq}` },
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

/** Wrap a Message into the v1.0 AgentExecutionEvent discriminated envelope. */
function wrapMessage(seq: number): AgentExecutionEvent {
  return { kind: 'message', data: makeMsg(seq) };
}

describe('TaskEventStore', () => {
  it('appends with monotonic per-task seq', () => {
    const s = new TaskEventStore();
    expect(s.append('t1', wrapMessage(0))).toBe(1);
    expect(s.append('t1', wrapMessage(1))).toBe(2);
    expect(s.append('t2', wrapMessage(2))).toBe(1); // independent counter
    expect(s.append('t1', wrapMessage(3))).toBe(3);
  });

  it('reads from a sequence filter', () => {
    const s = new TaskEventStore();
    s.append('t1', wrapMessage(0));
    s.append('t1', wrapMessage(1));
    s.append('t1', wrapMessage(2));
    const all = s.read('t1');
    expect(all.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    const from2 = s.read('t1', 2);
    expect(from2.map((e: { seq: number }) => e.seq)).toEqual([3]);
    const fromHuge = s.read('t1', 9999);
    expect(fromHuge).toEqual([]);
  });

  it('returns empty for unknown task', () => {
    const s = new TaskEventStore();
    expect(s.read('missing')).toEqual([]);
    expect(s.latestSeq('missing')).toBe(0);
  });

  it('clears all events for a task', () => {
    const s = new TaskEventStore();
    s.append('t1', wrapMessage(0));
    s.append('t2', wrapMessage(1));
    s.clear('t1');
    expect(s.read('t1')).toEqual([]);
    expect(s.read('t2').length).toBe(1);
    expect(s.latestSeq('t1')).toBe(0);
  });

  it('evicts oldest task events beyond maxEvents cap', () => {
    const s = new TaskEventStore({ maxEvents: 3 });
    s.append('t1', wrapMessage(0)); // seq 1
    s.append('t1', wrapMessage(1)); // seq 2
    s.append('t2', wrapMessage(2)); // seq 1 (t2)
    s.append('t1', wrapMessage(3)); // seq 3 — total 4 > 3, evict t1 seq 1
    const t1 = s.read('t1');
    expect(t1.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    expect(s.latestSeq('t1')).toBe(3);
    const t2 = s.read('t2');
    expect(t2.map((e: { seq: number }) => e.seq)).toEqual([1]);
  });

  it('round-trips a statusUpdate event with full shape', () => {
    const s = new TaskEventStore();
    // v1.0 TaskStatusUpdateEvent: required taskId, contextId, status,
    // metadata. The v0.3 `final` boolean was dropped per
    // MIGRATION-fangai.md row #1 — terminal-ness is now derived from
    // `status.state in {completed, failed, canceled, rejected}`.
    const statusUpdateData: TaskStatusUpdateEvent = {
      taskId: 't1',
      contextId: 'c1',
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: '2026-08-09T00:00:00.000Z',
      },
      metadata: undefined,
    };
    const ev: AgentExecutionEvent = { kind: 'statusUpdate', data: statusUpdateData };
    const seq = s.append('t1', ev);
    const [entry] = s.read('t1');
    expect(entry.seq).toBe(seq);
    expect(entry.event).toBe(ev);
  });

  it('round-trips a task event with full shape', () => {
    const s = new TaskEventStore();
    const taskData: Task = {
      id: 't1',
      contextId: 'c1',
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: '2026-08-09T00:00:00.000Z',
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    const ev: AgentExecutionEvent = { kind: 'task', data: taskData };
    const seq = s.append('t1', ev);
    const [entry] = s.read('t1');
    expect(entry.seq).toBe(seq);
    expect(entry.event).toBe(ev);
  });

  it('round-trips an artifactUpdate event with full shape', () => {
    const s = new TaskEventStore();
    const artifactUpdateData: TaskArtifactUpdateEvent = {
      taskId: 't1',
      contextId: 'c1',
      artifact: {
        artifactId: 'a1',
        name: 'stdout',
        description: '',
        parts: [
          {
            content: { $case: 'text', value: 'hello' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
      },
      append: false,
      lastChunk: true,
      metadata: undefined,
    };
    const ev: AgentExecutionEvent = { kind: 'artifactUpdate', data: artifactUpdateData };
    const seq = s.append('t1', ev);
    const [entry] = s.read('t1');
    expect(entry.seq).toBe(seq);
    expect(entry.event).toBe(ev);
  });
});
