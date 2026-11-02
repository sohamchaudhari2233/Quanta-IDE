import crypto from 'crypto';
import dns from 'dns/promises';
import { eventBus } from '../core/eventBus.js';
import { auditLogger } from '../security/auditLogger.js';

/**
 * Checks whether an IPv4 string belongs to private or link-local ranges.
 */
export function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) return true;

  // 127.0.0.0/8 (Loopback)
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 (Private)
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 (Private)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (Link-local / AWS & GCP Metadata 169.254.169.254)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8
  if (parts[0] === 0) return true;

  return false;
}

/**
 * Checks whether an IPv6 string belongs to loopback or private ranges.
 */
export function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  // Unique local addresses (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // Link-local unicast (fe80::/10)
  if (normalized.startsWith('fe80')) return true;
  return false;
}

/**
 * Validates target URL against SSRF threats.
 */
export async function validateSafeWebhookUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    throw new Error('Invalid webhook URL format');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Webhook URL must use HTTP or HTTPS protocol');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`SSRF Blocked: Local hostnames forbidden (${hostname})`);
  }

  // Resolve DNS to verify destination IP address
  try {
    const lookup = await dns.lookup(hostname, { all: true });
    for (const entry of lookup) {
      if (entry.family === 4 && isPrivateIPv4(entry.address)) {
        throw new Error(`SSRF Blocked: Resolved to private IPv4 address (${entry.address})`);
      }
      if (entry.family === 6 && isPrivateIPv6(entry.address)) {
        throw new Error(`SSRF Blocked: Resolved to private IPv6 address (${entry.address})`);
      }
    }
  } catch (err) {
    if (err.message.includes('SSRF Blocked')) throw err;
    throw new Error(`DNS lookup failed for webhook host: ${hostname}`);
  }

  return parsed;
}

export class WebhookDispatcher {
  constructor(options = {}) {
    this.webhooks = options.webhooks || []; // array of { url, secret, events: ['*'] }
    this.timeoutMs = options.timeoutMs || 8000;
    this.initEventListeners();
  }

  addWebhook({ url, secret, events = ['*'] }) {
    this.webhooks.push({ url, secret, events });
  }

  initEventListeners() {
    eventBus.on('approval.requested', (data) => this.dispatch('approval:requested', data?.payload || data));
    eventBus.on('approval.resolved', (data) => this.dispatch('approval:resolved', data?.payload || data));
    eventBus.on('task.finished', (data) => this.dispatch('task:completed', data?.payload || data));
    eventBus.on('task.failed', (data) => this.dispatch('task:failed', data?.payload || data));
    eventBus.on('checkpoint.created', (data) => this.dispatch('checkpoint:created', data?.payload || data));
  }

  async dispatch(eventName, payload) {
    if (this.webhooks.length === 0) return;

    const payloadString = JSON.stringify({
      event: eventName,
      timestamp: new Date().toISOString(),
      data: payload
    });

    for (const webhook of this.webhooks) {
      const match = webhook.events.includes('*') || webhook.events.includes(eventName);
      if (!match) continue;

      this.sendSingleWebhook(webhook, eventName, payloadString).catch(err => {
        console.warn(`[Webhook] Dispatch error to ${webhook.url}:`, err.message);
      });
    }
  }

  async sendSingleWebhook(webhook, eventName, payloadString) {
    // 1. SSRF check
    await validateSafeWebhookUrl(webhook.url);

    // 2. Sign payload
    const signature = crypto
      .createHmac('sha256', webhook.secret || 'quanta_default_secret')
      .update(payloadString)
      .digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quanta-Event': eventName,
          'X-Quanta-Signature': `sha256=${signature}`,
          'User-Agent': 'Quanta-IDE-Webhook/1.0'
        },
        body: payloadString,
        signal: controller.signal
      });

      clearTimeout(timeout);
      auditLogger.log('WEBHOOK_DISPATCHED', {
        url: webhook.url,
        event: eventName,
        status: res.status
      });

      return res.ok;
    } catch (err) {
      clearTimeout(timeout);
      auditLogger.log('WEBHOOK_FAILED', {
        url: webhook.url,
        event: eventName,
        error: err.message
      });
      throw err;
    }
  }
}

export const webhookDispatcher = new WebhookDispatcher();

