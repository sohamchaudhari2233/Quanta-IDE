import crypto from 'crypto';

export const EVENT_TYPES = [
  'agent.state',
  'approval.requested',
  'approval.resolved',
  'task.queued',
  'task.started',
  'task.finished',
  'task.failed',
  'timeline.entry',
  'checkpoint.created',
  'tunnel.status',
  'sync.status'
];

/**
 * High-performance Typed Event Bus with Bounded Ring Buffer and WebSocket Broadcast.
 */
export class EventBus {
  constructor(options = {}) {
    this.maxHistory = options.maxHistory || 500;
    this.history = []; // Ring buffer of past events
    this.subscribers = new Map(); // eventType -> Set of callbacks
    this.broadcastHandler = null; // Attached WebSocket broadcast function
  }

  setBroadcastHandler(fn) {
    this.broadcastHandler = fn;
  }

  on(eventType, callback) {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType).add(callback);
    return () => this.off(eventType, callback);
  }

  off(eventType, callback) {
    if (this.subscribers.has(eventType)) {
      this.subscribers.get(eventType).delete(callback);
    }
  }

  _normalizeVariants(type) {
    if (typeof type !== 'string') return [type];
    const variants = new Set([type]);
    if (type.includes(':')) {
      variants.add(type.replace(/:/g, '.'));
    } else if (type.includes('.')) {
      variants.add(type.replace(/\./g, ':'));
    }
    if (type === 'task.finished' || type === 'task:finished') {
      variants.add('task.completed');
      variants.add('task:completed');
    } else if (type === 'task.completed' || type === 'task:completed') {
      variants.add('task.finished');
      variants.add('task:finished');
    }
    return Array.from(variants);
  }

  publish(type, payload = {}, sessionId = 'system') {
    const event = {
      id: crypto.randomUUID(),
      type,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      sessionId,
      payload
    };

    // Append to ring buffer
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Notify in-process listeners matching verbatim type or normalized variants
    const matchedCallbacks = new Set();
    const variants = this._normalizeVariants(type);
    for (const v of variants) {
      const list = this.subscribers.get(v);
      if (list) {
        for (const cb of list) matchedCallbacks.add(cb);
      }
    }

    for (const cb of matchedCallbacks) {
      try { cb(event); } catch (err) { console.error(`Error in event listener for ${type}:`, err); }
    }

    // Broadcast over WebSocket if handler is registered
    if (this.broadcastHandler) {
      try {
        this.broadcastHandler(event);
      } catch (err) {
        console.error('Failed to broadcast event over WebSocket:', err);
      }
    }

    return event;
  }

  emit(type, payload, sessionId) {
    return this.publish(type, payload, sessionId);
  }

  getHistory(options = {}) {
    const opts = typeof options === 'number' ? { limit: options } : options;
    const { since = 0, type = null, limit = 100 } = opts;
    let filtered = this.history.filter(e => e.timestamp > since);
    if (type) {
      filtered = filtered.filter(e => e.type === type);
    }
    return filtered.slice(-limit);
  }

  clear() {
    this.history = [];
  }
}

export const eventBus = new EventBus();
