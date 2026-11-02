import crypto from 'crypto';
import { eventBus } from '../core/eventBus.js';
import { persistentStore } from '../core/store.js';
import { auditLogger } from '../security/auditLogger.js';

export class TaskQueue {
  constructor() {
    this.items = persistentStore.get('taskQueue') || [];
    this.isPaused = false;
    this.activeTask = null;
    this.failurePolicy = 'stop_queue'; // 'stop_queue' | 'skip' | 'retry_once'
  }

  clear() {
    this.items = [];
    this.activeTask = null;
    this.save();
  }

  save() {
    persistentStore.set('taskQueue', this.items);
  }

  enqueue(promptOrOpts, idempotencyKey = null, deviceId = 'unknown') {
    let prompt = '';
    let priority = 0;
    if (typeof promptOrOpts === 'object' && promptOrOpts !== null) {
      prompt = promptOrOpts.prompt;
      priority = promptOrOpts.priority || 0;
      idempotencyKey = promptOrOpts.idempotencyKey || idempotencyKey;
      deviceId = promptOrOpts.deviceId || (promptOrOpts.session?.user) || deviceId;
    } else {
      prompt = promptOrOpts;
    }

    if (typeof prompt !== 'string' || prompt.length > 100000) throw new Error('Prompt must be text under 100000 characters');
    if (!Number.isFinite(priority)) throw new Error('Priority must be a finite number');
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('Prompt cannot be empty');

    // Idempotency check: prevent duplicate submits on network reconnect
    if (idempotencyKey) {
      const existing = this.items.find(i => i.idempotencyKey === idempotencyKey);
      if (existing) return existing;
    }

    const item = {
      id: crypto.randomUUID(),
      prompt: trimmed,
      priority,
      idempotencyKey: idempotencyKey || crypto.randomUUID(),
      createdAt: Date.now(),
      status: 'queued',
      deviceId,
      durationMs: 0
    };

    this.items.push(item);
    this.save();

    eventBus.publish('task.queued', item);
    auditLogger.log({
      type: 'TASK_QUEUED',
      deviceId,
      summary: `Enqueued task: ${trimmed.substring(0, 60)}...`,
      details: { id: item.id }
    });

    return item;
  }

  getNextTask() {
    const queued = this.items.filter(i => i.status === 'queued');
    if (queued.length === 0) return null;
    queued.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return queued[0];
  }

  startTask(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;
    item.status = 'running';
    item.startedAt = Date.now();
    this.activeTask = item;
    this.save();
    return item;
  }

  completeTask(id, result = {}) {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;
    item.status = 'done';
    item.result = result;
    item.durationMs = Date.now() - (item.startedAt || item.createdAt);
    if (this.activeTask && this.activeTask.id === id) {
      this.activeTask = null;
    }
    this.save();
    return item;
  }

  getStatus() {
    const pending = this.items.filter(i => i.status === 'queued');
    pending.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return {
      activeTask: this.activeTask,
      activeCount: this.activeTask ? 1 : 0,
      pendingCount: pending.length,
      completedCount: this.items.filter(i => i.status === 'done').length,
      pending
    };
  }

  getItems() {
    return this.items;
  }

  cancel(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    if (item.status === 'running') {
      item.status = 'cancelled';
    } else {
      this.items = this.items.filter(i => i.id !== id);
    }
    this.save();
    return true;
  }

  reorder(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.items.length || toIndex < 0 || toIndex >= this.items.length) {
      return false;
    }
    const [moved] = this.items.splice(fromIndex, 1);
    this.items.splice(toIndex, 0, moved);
    this.save();
    return true;
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  /**
   * Dispatch the next task in the queue if agent is confirmed idle.
   */
  async processNext(isAgentIdle, sendPromptFn) {
    if (this.isPaused || !isAgentIdle || this.activeTask) return null;
    const nextItem = this.getNextTask();
    if (!nextItem) return null;

    nextItem.status = 'running';
    nextItem.startedAt = Date.now();
    this.activeTask = nextItem;
    this.save();

    eventBus.publish('task.started', nextItem);

    try {
      const result = await sendPromptFn(nextItem.prompt);
      if (result?.success === false || result?.ok === false) throw new Error(result.error || 'Task dispatch failed');
      if (nextItem.status === 'cancelled') return nextItem;
      nextItem.status = 'done';
      nextItem.durationMs = Date.now() - nextItem.startedAt;
      eventBus.publish('task.finished', nextItem);
    } catch (err) {
      nextItem.status = 'failed';
      nextItem.error = err.message;
      nextItem.durationMs = Date.now() - nextItem.startedAt;
      eventBus.publish('task.failed', nextItem);

      if (this.failurePolicy === 'stop_queue') {
        this.pause();
      }
    } finally {
      this.activeTask = null;
      this.save();
    }

    return nextItem;
  }
}

export const taskQueue = new TaskQueue();
