/**
 * Quanta IDE Mobile Client Offline Prompt Queue
 * Stores prompts in IndexedDB during network loss and replays upon reconnection.
 * Authors: Akira-official & dark-yoddha
 */

class OfflinePromptQueue {
  constructor() {
    this.dbName = 'QuantaOfflineDB';
    this.storeName = 'queuedPrompts';
    this.db = null;
    this.memoryQueue = new Map();
    this.isReplaying = false;
    this.staleThresholdMs = 5 * 60 * 1000; // 5 minutes
    this.ready = this.initDB();
  }

  async initDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('[OfflineQueue] IndexedDB not supported in this environment');
        return resolve(false);
      }

      let req;
      try {
        req = window.indexedDB.open(this.dbName, 1);
      } catch {
        return resolve(false);
      }
      req.onblocked = () => resolve(false);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'idempotencyKey' });
          store.createIndex('queuedAt', 'queuedAt', { unique: false });
        }
      };

      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(true);
      };

      req.onerror = () => {
        console.warn('[OfflineQueue] Failed to open IndexedDB');
        resolve(false);
      };
    });
  }

  async enqueuePrompt(promptText) {
    await this.ready;
    const idempotencyKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const record = {
      idempotencyKey,
      prompt: promptText,
      queuedAt: Date.now(),
      status: 'pending'
    };

    if (!this.db) {
      this.memoryQueue.set(idempotencyKey, record);
      record.memoryOnly = true;
      return record;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(record);
        tx.oncomplete = () => resolve(record);
        tx.onabort = tx.onerror = (e) => reject(e.target.error || new Error('Queue storage failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async getPendingPrompts() {
    await this.ready;
    if (!this.db) return [...this.memoryQueue.values()];

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve([...this.memoryQueue.values(), ...(req.result || [])]);
        req.onerror = () => resolve([...this.memoryQueue.values()]);
      } catch (e) {
        resolve([...this.memoryQueue.values()]);
      }
    });
  }

  async removePrompt(idempotencyKey) {
    this.memoryQueue.delete(idempotencyKey);
    if (!this.db) return true;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(idempotencyKey);
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async clear() {
    await this.ready;
    this.memoryQueue.clear();
    if (!this.db) return true;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
      } catch { resolve(false); }
    });
  }

  /**
   * Replay all pending prompts through the provided sender callback.
   * @param {Function} sendCallback async function(record) => boolean
   */
  async replayPending(sendCallback) {
    if (this.isReplaying) return;
    this.isReplaying = true;

    try {
      const items = await this.getPendingPrompts();
      if (items.length === 0) {
        this.isReplaying = false;
        return;
      }

      // Sort chronological
      items.sort((a, b) => a.queuedAt - b.queuedAt);

      for (const item of items) {
        const ageMs = Date.now() - item.queuedAt;
        if (ageMs > this.staleThresholdMs) {
          const mins = Math.round(ageMs / 60000);
          const proceed = window.confirm(`This prompt was queued ${mins} minutes ago:\n\n"${item.prompt.slice(0, 100)}..."\n\nDo you still want to dispatch it to the agent?`);
          if (!proceed) {
            await this.removePrompt(item.idempotencyKey);
            continue;
          }
        }

        const success = await sendCallback(item);
        if (success) {
          await this.removePrompt(item.idempotencyKey);
        } else {
          // Break on network error, keep rest in queue
          break;
        }
      }
    } finally {
      this.isReplaying = false;
    }
  }
}

window.QuantaOfflineQueue = new OfflinePromptQueue();

