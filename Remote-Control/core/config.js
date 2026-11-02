/**
 * Quanta IDE Feature Flags & Server Configuration System
 * All defaults are strictly secure and defensive.
 */
export const CONFIG = {
  // Authentication & Security
  requireDevicePairing: process.env.REQUIRE_DEVICE_PAIRING === 'true',
  allowLanAutoTrust: process.env.ALLOW_LAN_AUTO_TRUST === 'true',
  enableTotp: process.env.ENABLE_TOTP === 'true',
  defaultTunnelMode: process.env.DEFAULT_TUNNEL_MODE || 'read-only',
  sessionLifetimeMs: parseInt(process.env.SESSION_LIFETIME_MS || '86400000', 10), // 24h
  idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS || '7200000', 10), // 2h
  elevationTimeoutMs: parseInt(process.env.ELEVATION_TIMEOUT_MS || '1800000', 10), // 30m

  // Rate Limiting
  maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '15', 10),
  trustProxyMode: process.env.TRUST_PROXY_MODE || 'auto',

  // Agent Control & Approvals
  autoApproveSafe: process.env.AUTO_APPROVE_SAFE === 'true',
  approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS || '0', 10), // 0 = never timeout
  maxTaskQueueSize: parseInt(process.env.MAX_TASK_QUEUE_SIZE || '10', 10),

  // Connectivity
  tunnelProvider: process.env.TUNNEL_PROVIDER || 'cloudflare',
  tunnelFallbackOrder: (process.env.TUNNEL_FALLBACK_ORDER || 'cloudflare,ngrok,pinggy')
    .split(',')
    .map(p => p.trim().toLowerCase()),

  // Integrations & Notifications
  enableWebhooks: process.env.ENABLE_WEBHOOKS === 'true',
  enableTelegram: process.env.ENABLE_TELEGRAM === 'true',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Storage & Snapshots
  storageProvider: process.env.STORAGE_PROVIDER || 'gdrive',
  maxSnapshotsRetained: parseInt(process.env.MAX_SNAPSHOTS_RETAINED || '50', 10)
};

export function isFeatureEnabled(featureName) {
  return !!CONFIG[featureName];
}

