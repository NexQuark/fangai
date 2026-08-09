/**
 * In-memory per-task event log — feeds /tasks/{id}/events SSE replay.
 *
 * Stores the raw ExecutionEventBus payloads in arrival order with a monotonic
 * per-task sequence number, so a reconnecting client can resume from where it
 * left off via either the standard `Last-Event-ID` header or `?from=<seq>`.
 *
 * Retention: bounded LRU by total event count (default 5000). When the cap is
 * hit, the oldest events are dropped — there is no replay beyond that point,
 * but the current task snapshot from FangTaskStore is still authoritative.
 */

import type { AgentExecutionEvent } from '@a2a-js/sdk/server';

/** Anything the ExecutionEventBus can publish (v1.0 wrapped envelope). */
export type TaskEventPayload = AgentExecutionEvent;

export interface TaskEventEntry {
  /** Monotonic per-task sequence number, starting at 1. */
  seq: number;
  /** Wall-clock timestamp when the event was published (ms). */
  ts: number;
  /** Raw A2A event payload. */
  event: TaskEventPayload;
}

export interface TaskEventStoreOptions {
  /** Max events kept across all tasks. Default 5000. */
  maxEvents?: number;
}

export class TaskEventStore {
  private readonly maxEvents: number;
  /** taskId → ordered seq → entry */
  private readonly eventsByTask = new Map<string, Map<number, TaskEventEntry>>();
  /** Insertion order for LRU eviction: oldest taskId first. */
  private readonly taskOrder: string[] = [];
  private readonly totalEvents = { n: 0 };
  /** Monotonic counter per task. */
  private readonly seqByTask = new Map<string, number>();

  constructor(options?: TaskEventStoreOptions) {
    const m = options?.maxEvents ?? 5000;
    this.maxEvents = m < 1 ? 1 : m;
  }

  /** Append one event for a task. Returns the assigned seq (>= 1). */
  append(taskId: string, event: TaskEventPayload): number {
    let seq = this.seqByTask.get(taskId) ?? 0;
    seq += 1;
    this.seqByTask.set(taskId, seq);

    let bucket = this.eventsByTask.get(taskId);
    if (!bucket) {
      bucket = new Map();
      this.eventsByTask.set(taskId, bucket);
      this.taskOrder.push(taskId);
    }
    bucket.set(seq, { seq, ts: Date.now(), event });
    this.totalEvents.n += 1;
    this.evictIfNeeded();
    return seq;
  }

  /** Read events for a task with seq > fromSeq. Empty fromSeq (= 0) returns from seq=1. */
  read(taskId: string, fromSeq = 0): TaskEventEntry[] {
    const bucket = this.eventsByTask.get(taskId);
    if (!bucket) return [];
    const out: TaskEventEntry[] = [];
    for (const [seq, entry] of bucket) {
      if (seq > fromSeq) out.push(entry);
    }
    return out;
  }

  /** Highest seq currently stored for a task, or 0 if none. */
  latestSeq(taskId: string): number {
    return this.seqByTask.get(taskId) ?? 0;
  }

  /** Drop all events for a task (e.g. on completion + retention sweep). */
  clear(taskId: string): void {
    const bucket = this.eventsByTask.get(taskId);
    if (!bucket) return;
    this.totalEvents.n -= bucket.size;
    this.eventsByTask.delete(taskId);
    this.seqByTask.delete(taskId);
    const idx = this.taskOrder.indexOf(taskId);
    if (idx >= 0) this.taskOrder.splice(idx, 1);
  }

  /** Drop oldest events until total ≤ maxEvents. */
  private evictIfNeeded(): void {
    while (this.totalEvents.n > this.maxEvents && this.taskOrder.length > 0) {
      const victim = this.taskOrder[0];
      const bucket = this.eventsByTask.get(victim);
      if (!bucket || bucket.size === 0) {
        this.taskOrder.shift();
        this.eventsByTask.delete(victim);
        this.seqByTask.delete(victim);
        continue;
      }
      // Drop the oldest event from the oldest task
      const oldestSeq = bucket.keys().next().value as number;
      bucket.delete(oldestSeq);
      this.totalEvents.n -= 1;
      if (bucket.size === 0) {
        this.taskOrder.shift();
        this.eventsByTask.delete(victim);
        this.seqByTask.delete(victim);
      }
    }
  }
}