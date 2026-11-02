import { eventBus } from '../core/eventBus.js';
import { auditLogger } from '../security/auditLogger.js';

export class TelegramBotService {
  constructor(options = {}) {
    this.token = options.token || process.env.TELEGRAM_BOT_TOKEN || '';
    this.defaultChatId = options.chatId || process.env.TELEGRAM_CHAT_ID || '';
    this.allowedUsers = (options.allowedUsers || process.env.TELEGRAM_ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.enabled = (options.enabled !== undefined)
      ? options.enabled
      : (process.env.QUANTA_TELEGRAM_ENABLED === 'true' && !!this.token);

    this.polling = false;
    this.lastUpdateId = 0;
    this.pollAbortController = null;
    this.approvalManager = null;
    this.taskQueue = null;

    this.initEventListeners();
  }

  setManagers({ approvalManager, taskQueue }) {
    this.approvalManager = approvalManager;
    this.taskQueue = taskQueue;
  }

  initEventListeners() {
    eventBus.on('approval.requested', (event) => {
      if (!this.enabled || !this.defaultChatId) return;
      const approval = event?.payload || event;
      const riskBadge = approval.risk === 'dangerous' ? '🔴 DANGEROUS' : (approval.risk === 'caution' ? '🟡 CAUTION' : '🟢 SAFE');
      const text = `🚨 *Approval Request [${approval.id}]*\n` +
        `Risk: ${riskBadge}\n` +
        `Action: \`${approval.action}\`\n` +
        (approval.command ? `Command: \`${approval.command}\`\n` : '') +
        `Target: \`${approval.targetPath || 'workspace'}\`\n\n` +
        `Reply:\n/approve_${approval.id}\n/reject_${approval.id}`;
      this.sendMessage(this.defaultChatId, text);
    });

    eventBus.on('task.finished', (event) => {
      if (!this.enabled || !this.defaultChatId) return;
      const task = event?.payload || event;
      this.sendMessage(this.defaultChatId, `✅ *Task Completed [${task.id}]*\nPrompt: ${task.prompt?.slice(0, 80)}...`);
    });

    eventBus.on('task.failed', (event) => {
      if (!this.enabled || !this.defaultChatId) return;
      const data = event?.payload || event;
      const task = data?.task || data;
      const error = data?.error || task?.error || 'Execution failed';
      this.sendMessage(this.defaultChatId, `❌ *Task Failed [${task.id}]*\nError: ${error}`);
    });
  }

  async start() {
    if (!this.enabled) return;
    if (!this.token) {
      console.warn('[Telegram] Cannot start: TELEGRAM_BOT_TOKEN missing');
      return;
    }

    this.polling = true;
    this.pollLoop();
    console.log('[Telegram] Bot polling started');
    auditLogger.log('TELEGRAM_START', { enabled: true });
  }

  stop() {
    this.polling = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
  }

  async pollLoop() {
    let failureCount = 0;
    while (this.polling) {
      try {
        this.pollAbortController = new AbortController();
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=20`;
        const res = await fetch(url, { signal: this.pollAbortController.signal });
        if (!res.ok) {
          throw new Error(`Telegram API responded ${res.status}`);
        }
        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          failureCount = 0;
          for (const update of data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.handleUpdate(update);
          }
        }
      } catch (err) {
        if (!this.polling) break;
        failureCount++;
        const backoff = Math.min(30000, 2000 * Math.pow(1.5, failureCount));
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  async handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const userId = String(msg.from?.id);
    const chatId = msg.chat?.id;

    // Strict whitelist check: reject unless user is in allowedUsers
    if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId)) {
      await this.sendMessage(chatId, '⛔ Unauthorized user ID. Access denied.');
      auditLogger.log('TELEGRAM_UNAUTHORIZED', { userId, chatId, text: msg.text });
      return;
    }

    const text = msg.text.trim();

    if (text === '/start' || text === '/help') {
      await this.sendMessage(chatId,
        '⚡ *Quanta IDE Telegram Gateway*\n\n' +
        '/status - View system & bridge status\n' +
        '/approvals - List pending approvals\n' +
        '/approve_<id> - Approve action\n' +
        '/reject_<id> - Reject action\n' +
        '/queue - List task queue status'
      );
    } else if (text === '/status') {
      const pendingCount = this.approvalManager ? this.approvalManager.getPending().length : 0;
      const queueStatus = this.taskQueue ? this.taskQueue.getStatus() : { count: 0 };
      await this.sendMessage(chatId,
        `💻 *Quanta IDE Status*\n` +
        `• Pending Approvals: ${pendingCount}\n` +
        `• Task Queue: ${queueStatus.pendingCount || 0} pending, ${queueStatus.activeCount || 0} active\n` +
        `• Bridge: Online`
      );
    } else if (text === '/approvals') {
      if (!this.approvalManager) {
        await this.sendMessage(chatId, 'Approval manager not attached.');
        return;
      }
      const pending = this.approvalManager.getPending();
      if (pending.length === 0) {
        await this.sendMessage(chatId, 'No pending approvals.');
        return;
      }
      let reply = '📋 *Pending Approvals:*\n';
      for (const a of pending) {
        reply += `\n• \`[${a.id}]\` ${a.action} (${a.risk})\n  cmd: \`${a.command || a.targetPath || 'n/a'}\`\n  /approve_${a.id} | /reject_${a.id}\n`;
      }
      await this.sendMessage(chatId, reply);
    } else if (text.startsWith('/approve_')) {
      const id = text.replace('/approve_', '').trim();
      if (this.approvalManager) {
        try {
          const res = this.approvalManager.resolve(id, 'approve', { user: `telegram:${userId}` });
          await this.sendMessage(chatId, `✅ Approved [${id}]: ${res.action}`);
        } catch (e) {
          await this.sendMessage(chatId, `❌ Error: ${e.message}`);
        }
      }
    } else if (text.startsWith('/reject_')) {
      const id = text.replace('/reject_', '').trim();
      if (this.approvalManager) {
        try {
          const res = this.approvalManager.resolve(id, 'reject', { user: `telegram:${userId}` });
          await this.sendMessage(chatId, `🛑 Rejected [${id}]`);
        } catch (e) {
          await this.sendMessage(chatId, `❌ Error: ${e.message}`);
        }
      }
    } else if (text === '/queue') {
      if (!this.taskQueue) {
        await this.sendMessage(chatId, 'Task queue not attached.');
        return;
      }
      const status = this.taskQueue.getStatus();
      await this.sendMessage(chatId, `📊 *Task Queue Status*\nActive: ${status.activeCount}\nPending: ${status.pendingCount}\nCompleted: ${status.completedCount}`);
    }
  }

  async sendMessage(chatId, text) {
    if (!this.token) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown'
        })
      });
    } catch (err) {
      console.error('[Telegram] Failed to send message:', err.message);
    }
  }
}

export const telegramBot = new TelegramBotService();

