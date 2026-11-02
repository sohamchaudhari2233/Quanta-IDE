/**
 * Quanta IDE End-to-End Test Harness & Opaque-Box Protocol Fixtures
 * 
 * Implements requirement-driven protocol specifications, cryptographic helpers,
 * and contract models for F-01 through F-25 without relying on internal modules.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// ============================================================================
// 1. Cryptographic & Auth Helpers (F-01, F-09, F-12, F-23)
// ============================================================================

/**
 * Generates RFC 7636 PKCE code_verifier and code_challenge (S256).
 */
export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/**
 * Validates RFC 7636 PKCE code_verifier against code_challenge.
 */
export function verifyPKCE(verifier, challenge, method = 'S256') {
  if (!verifier || !challenge || method !== 'S256') return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

/**
 * Constant-time password comparison using SHA-256 pre-hashing (F-09).
 */
export function verifyPasswordConstantTime(candidate, actual) {
  if (typeof candidate !== 'string' || typeof actual !== 'string') return false;
  if (candidate.length === 0 || actual.length === 0) return false;

  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(candidateHash, actualHash);
}

/**
 * Generates and verifies RFC 6238 TOTP (F-23).
 */
export function generateTOTP(secret, timeStepSec = 30) {
  const counter = Math.floor(Date.now() / 1000 / timeStepSec);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'utf-8')).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
  return code;
}

export function verifyTOTP(candidateCode, secret, allowedDriftSteps = 1, timeStepSec = 30) {
  if (!candidateCode || typeof candidateCode !== 'string' || candidateCode.length !== 6) return false;
  const currentStep = Math.floor(Date.now() / 1000 / timeStepSec);

  for (let drift = -allowedDriftSteps; drift <= allowedDriftSteps; drift++) {
    const counter = currentStep + drift;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'utf-8')).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
    if (code === candidateCode) return true;
  }
  return false;
}

// ============================================================================
// 2. Rate Limiter Model (F-10)
// ============================================================================

export class RateLimiterModel {
  constructor(options = {}) {
    this.maxFailures = options.maxFailures || 5;
    this.lockoutDurationMs = options.lockoutDurationMs || 15 * 60 * 1000; // 15 mins
    this.records = new Map();
  }

  isLockedOut(ip) {
    const record = this.records.get(ip);
    if (!record || !record.lockedUntil) return { locked: false, remainingMs: 0 };
    const remaining = record.lockedUntil - Date.now();
    if (remaining > 0) {
      return { locked: true, remainingMs: remaining };
    }
    // Lockout expired
    record.failures = 0;
    record.lockedUntil = null;
    return { locked: false, remainingMs: 0 };
  }

  recordFailure(ip) {
    let record = this.records.get(ip);
    if (!record) {
      record = { failures: 0, lockedUntil: null, lastAttempt: Date.now() };
      this.records.set(ip, record);
    }
    record.failures += 1;
    record.lastAttempt = Date.now();

    if (record.failures >= this.maxFailures) {
      record.lockedUntil = Date.now() + this.lockoutDurationMs;
      return { locked: true, remainingMs: this.lockoutDurationMs };
    }
    return { locked: false, remainingAttempts: this.maxFailures - record.failures };
  }

  recordSuccess(ip) {
    this.records.delete(ip);
  }
}

// ============================================================================
// 3. Shell Risk Classifier & Rule Engine Model (F-14)
// ============================================================================

const SAFE_PATTERNS = [
  /^ls(\s+.*)?$/,
  /^git\s+(status|diff|log|branch)(\s+.*)?$/,
  /^pwd$/,
  /^echo\s+.*$/,
  /^npm\s+test$/,
  /^cat\s+[^.][\w.-]*$/
];

const CAUTION_PATTERNS = [
  /^git\s+(checkout|commit|merge|fetch|pull)(\s+.*)?$/,
  /^mkdir(\s+.*)?$/,
  /^touch(\s+.*)?$/,
  /^npm\s+(run\s+[\w:-]+|install|update)$/
];

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--force)/i,
  /\bsudo\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /(?:\.env|\.ssh|id_rsa|id_ed25519|client_secret|\.pem|\.key)\b/i
];

export function decomposeCommand(cmdString) {
  if (!cmdString || typeof cmdString !== 'string') return [];
  // Split on compound operators: &&, ||, ;, |
  return cmdString
    .split(/&&|\|\||;|\|/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function classifyCommandSegment(segment) {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(segment)) return 'dangerous';
  }
  for (const pat of CAUTION_PATTERNS) {
    if (pat.test(segment)) return 'caution';
  }
  for (const pat of SAFE_PATTERNS) {
    if (pat.test(segment)) return 'safe';
  }
  return 'caution'; // Default fallback
}

export function classifyFullCommand(commandString) {
  const segments = decomposeCommand(commandString);
  if (segments.length === 0) return { risk: 'safe', segments: [], reasons: [] };

  const segmentRisks = segments.map(seg => ({ segment: seg, risk: classifyCommandSegment(seg) }));
  const hasDangerous = segmentRisks.some(s => s.risk === 'dangerous');
  const hasCaution = segmentRisks.some(s => s.risk === 'caution');

  const overallRisk = hasDangerous ? 'dangerous' : (hasCaution ? 'caution' : 'safe');
  return {
    risk: overallRisk,
    segments: segmentRisks,
    reasons: segmentRisks.filter(s => s.risk !== 'safe').map(s => `${s.risk}: ${s.segment}`)
  };
}

export class RuleEngineModel {
  constructor(rules = []) {
    this.rules = rules;
  }

  evaluate(actionType, commandString) {
    const classification = classifyFullCommand(commandString);

    // IMMUTABLE HARD FLOOR: Dangerous commands can NEVER be auto-approved
    if (classification.risk === 'dangerous') {
      return { autoApprove: false, risk: 'dangerous', reason: 'Hard floor: dangerous command requires human approval' };
    }

    // Check custom rules
    for (const rule of this.rules) {
      if (rule.enabled && rule.actionType === actionType) {
        const regex = new RegExp(rule.commandPattern);
        if (regex.test(commandString)) {
          return { autoApprove: rule.riskLevel !== 'dangerous', risk: classification.risk, ruleId: rule.id };
        }
      }
    }

    return { autoApprove: classification.risk === 'safe', risk: classification.risk };
  }
}

// ============================================================================
// 4. Three-Way Delta Sync Engine Model (F-02, F-04, F-05)
// ============================================================================

export function computeThreeWayDeltaPlan(localFiles, remoteFiles, manifestFiles) {
  const plan = [];
  const allPaths = new Set([
    ...localFiles.keys(),
    ...remoteFiles.keys(),
    ...Object.keys(manifestFiles || {})
  ]);

  for (const relPath of allPaths) {
    const localHash = localFiles.get(relPath);
    const remoteInfo = remoteFiles.get(relPath);
    const remoteHash = remoteInfo?.md5;
    const manifestItem = manifestFiles?.[relPath];

    const localExists = localHash !== undefined;
    const remoteExists = remoteHash !== undefined;
    const baseExists = manifestItem !== undefined;

    if (!baseExists) {
      if (localExists && remoteExists) {
        if (localHash === remoteHash) {
          plan.push({ path: relPath, action: 'noChange', localHash, remoteHash });
        } else {
          plan.push({ path: relPath, action: 'conflict', reason: 'both-added-different' });
        }
      } else if (localExists) {
        plan.push({ path: relPath, action: 'upload', localHash });
      } else if (remoteExists) {
        plan.push({ path: relPath, action: 'download', remoteId: remoteInfo.id, remoteHash });
      }
    } else {
      const baseHash = manifestItem.localMd5 || manifestItem.remoteMd5;
      const localChanged = localExists && localHash !== baseHash;
      const remoteChanged = remoteExists && remoteHash !== baseHash;

      if (!localExists && !remoteExists) {
        // Both deleted
        plan.push({ path: relPath, action: 'cleanManifest' });
      } else if (!localExists && remoteExists) {
        if (remoteChanged) {
          plan.push({ path: relPath, action: 'conflict', reason: 'local-deleted-remote-modified' });
        } else {
          plan.push({ path: relPath, action: 'deleteRemote', remoteId: remoteInfo.id });
        }
      } else if (localExists && !remoteExists) {
        if (localChanged) {
          plan.push({ path: relPath, action: 'conflict', reason: 'remote-deleted-local-modified' });
        } else {
          plan.push({ path: relPath, action: 'deleteLocal' });
        }
      } else {
        // Both exist
        if (!localChanged && !remoteChanged) {
          plan.push({ path: relPath, action: 'noChange' });
        } else if (localChanged && !remoteChanged) {
          plan.push({ path: relPath, action: 'upload', localHash });
        } else if (!localChanged && remoteChanged) {
          plan.push({ path: relPath, action: 'download', remoteId: remoteInfo.id, remoteHash });
        } else {
          // Both changed
          if (localHash === remoteHash) {
            plan.push({ path: relPath, action: 'noChange' });
          } else {
            plan.push({ path: relPath, action: 'conflict', reason: 'concurrent-modification', localHash, remoteHash });
          }
        }
      }
    }
  }

  return plan;
}

export function escapeDriveQuery(queryValue) {
  if (typeof queryValue !== 'string') return '';
  return queryValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================================================
// 5. Ignore Rule Matcher Model (F-03)
// ============================================================================

export class IgnoreMatcherModel {
  constructor(customRules = []) {
    this.defaultRules = [
      '.env',
      '.env.*',
      'client_secret*.json',
      '*.pem',
      '*.key',
      'node_modules/**',
      '.git/**',
      '.quanta/**'
    ];
    this.customRules = customRules;
  }

  isIgnored(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const normalized = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const filename = path.basename(normalized);

    // Whitelisted examples
    if (filename === '.env.example' || filename === 'client_secret.example.json') {
      return false;
    }

    // Default sensitive pattern checks
    if (filename.startsWith('.env')) return true;
    if (filename.startsWith('client_secret') && filename.endsWith('.json')) return true;
    if (filename.endsWith('.pem') || filename.endsWith('.key')) return true;
    if (normalized.startsWith('node_modules/') || normalized === 'node_modules') return true;
    if (normalized.startsWith('.git/') || normalized === '.git') return true;
    if (normalized.startsWith('.quanta/') || normalized === '.quanta') return true;

    // Custom rules evaluation
    for (const rawRule of this.customRules) {
      const rule = rawRule.trim();
      if (!rule || rule.startsWith('#')) continue;

      // Cannot negate default sensitive patterns
      if (rule.startsWith('!') && rule.includes('.env')) {
        continue; // Negation rejected
      }

      // Trailing slash rule: e.g. "vendor/" matches all files in vendor/
      if (rule.endsWith('/')) {
        const dirPrefix = rule.slice(0, -1);
        if (normalized === dirPrefix || normalized.startsWith(dirPrefix + '/')) {
          return true;
        }
      }

      if (normalized === rule || normalized.startsWith(rule + '/')) {
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// 6. Approval Manager & Task Queue Models (F-15, F-16)
// ============================================================================

export function computeActionFingerprint(actionType, command, workingDir) {
  return crypto
    .createHash('sha256')
    .update(`${actionType}|${command || ''}|${workingDir || ''}`)
    .digest('hex');
}

export class ApprovalManagerModel {
  constructor() {
    this.pending = new Map();
    this.history = [];
  }

  submitApproval({ actionType, command, workingDir, riskLevel, reason }) {
    const fingerprint = computeActionFingerprint(actionType, command, workingDir);
    if (this.pending.has(fingerprint)) {
      return { record: this.pending.get(fingerprint), isDuplicate: true };
    }

    const id = `appr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const record = {
      id,
      fingerprint,
      actionType,
      command,
      workingDir,
      riskLevel,
      reason,
      status: 'pending',
      createdAt: Date.now()
    };
    this.pending.set(fingerprint, record);
    return { record, isDuplicate: false };
  }

  resolve(approvalId, decision, reviewer = 'admin') {
    for (const [fp, record] of this.pending.entries()) {
      if (record.id === approvalId) {
        if (record.status !== 'pending') {
          throw new Error(`Approval ${approvalId} is already resolved as ${record.status}`);
        }
        record.status = decision === 'approve' ? 'approved' : 'rejected';
        record.resolvedBy = reviewer;
        record.resolvedAt = Date.now();
        this.pending.delete(fp);
        this.history.push(record);
        return record;
      }
    }
    throw new Error(`Approval ${approvalId} not found`);
  }

  getPendingCount() {
    return this.pending.size;
  }
}

export class TaskQueueModel {
  constructor() {
    this.queue = [];
    this.seenIdempotencyKeys = new Set();
  }

  enqueue({ taskId, prompt, priority = 'normal', idempotencyKey }) {
    if (idempotencyKey && this.seenIdempotencyKeys.has(idempotencyKey)) {
      return { queued: false, reason: 'duplicate-idempotency-key' };
    }
    if (idempotencyKey) {
      this.seenIdempotencyKeys.add(idempotencyKey);
    }

    const priorityWeight = { high: 3, normal: 2, low: 1 }[priority] || 2;
    const item = {
      taskId: taskId || `task_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      prompt,
      priority,
      priorityWeight,
      enqueuedAt: Date.now()
    };

    this.queue.push(item);
    // Sort descending by priority weight, then ascending by enqueuedAt
    this.queue.sort((a, b) => b.priorityWeight - a.priorityWeight || a.enqueuedAt - b.enqueuedAt);

    return { queued: true, item };
  }

  dequeue() {
    return this.queue.shift() || null;
  }
}

// ============================================================================
// 7. Jailed File Browser & SSRF Guard (F-18, F-21)
// ============================================================================

export function resolveJailedPath(workspaceRoot, relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Invalid path argument');
  }

  // Detect URL-encoded traversals
  const decoded = decodeURIComponent(relativePath);
  const rootResolved = path.resolve(workspaceRoot);
  const resolved = path.resolve(rootResolved, decoded);

  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error(`Path traversal rejected: Attempt to access outside workspace root: ${relativePath}`);
  }

  const filename = path.basename(resolved);
  if (filename.startsWith('.env') || filename === 'client_secret.json' || filename.endsWith('.pem') || filename.endsWith('.key')) {
    throw new Error(`Access denied: Sensitive file pattern blocked: ${filename}`);
  }

  return resolved;
}

export function isPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') return true;

  // IPv4 range checks
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 127) return true; // Loopback
    if (parts[0] === 10) return true;  // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 Link-local
  }
  return false;
}

export function validateWebhookDestination(targetUrl) {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid protocol: ${parsed.protocol}`);
  }
  if (isPrivateIP(parsed.hostname)) {
    throw new Error(`SSRF Blocked: Destination ${parsed.hostname} is a restricted private/loopback address`);
  }
  return true;
}

// ============================================================================
// 8. Ephemeral Test Server & Sandbox Workspace Helpers
// ============================================================================

export async function createSandboxWorkspace(prefix = 'quanta-e2e-') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir: tempDir,
    async cleanup() {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors on busy files
      }
    }
  };
}

export function createEphemeralServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        async close() {
          return new Promise(res => server.close(res));
        }
      });
    });
    server.on('error', reject);
  });
}
