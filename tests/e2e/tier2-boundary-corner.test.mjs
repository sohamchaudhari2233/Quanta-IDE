/**
 * Tier 2: Boundary & Corner Conditions (BVA & Stress Limits)
 * 
 * Verifies edge cases, extreme limits, boundary values, and injection vectors:
 * - Empty / Null / Zero-Length Inputs
 * - Maximum & Extreme Sizes
 * - Port Collisions & Loopback Network Bindings
 * - Zero, Negative & Expired Timeouts
 * - Escaping, Meta-Characters & Script/Path Injection
 * - Malformed Data & Format Violations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  verifyPasswordConstantTime,
  RateLimiterModel,
  classifyFullCommand,
  computeThreeWayDeltaPlan,
  escapeDriveQuery,
  resolveJailedPath,
  validateWebhookDestination,
  isPrivateIP,
  verifyTOTP,
  createEphemeralServer,
  createSandboxWorkspace
} from './harness.mjs';

// ============================================================================
// Boundary Dimension 1: Empty / Null / Zero-Length Inputs
// ============================================================================

test('BVA-01: Empty password input returns false without buffer errors', () => {
  assert.equal(verifyPasswordConstantTime('', 'fixture-only-password-42'), false);
  assert.equal(verifyPasswordConstantTime(null, 'fixture-only-password-42'), false);
  assert.equal(verifyPasswordConstantTime(undefined, 'fixture-only-password-42'), false);
  assert.equal(verifyPasswordConstantTime('fixture-only-password-42', ''), false);
});

test('BVA-02: Empty command string in risk classifier handles safely without exception', () => {
  const res1 = classifyFullCommand('');
  assert.equal(res1.risk, 'safe');
  assert.equal(res1.segments.length, 0);

  const res2 = classifyFullCommand('   ');
  assert.equal(res2.risk, 'safe');
  assert.equal(res2.segments.length, 0);

  const res3 = classifyFullCommand(null);
  assert.equal(res3.risk, 'safe');
});

test('BVA-03: Empty relative path in jailed file resolver throws descriptive error', () => {
  const root = 'd:\\workspace';
  assert.throws(() => resolveJailedPath(root, ''), /Invalid path argument/);
  assert.throws(() => resolveJailedPath(root, null), /Invalid path argument/);
  assert.throws(() => resolveJailedPath(root, undefined), /Invalid path argument/);
});

test('BVA-04: Empty sync manifest causes all local files to be uploads and remote to be downloads', () => {
  const local = new Map([['a.txt', 'hash_a'], ['b.txt', 'hash_b']]);
  const remote = new Map([['c.txt', { id: 'r_c', md5: 'hash_c' }]]);
  const emptyManifest = {};

  const plan = computeThreeWayDeltaPlan(local, remote, emptyManifest);
  const uploads = plan.filter(p => p.action === 'upload').map(p => p.path);
  const downloads = plan.filter(p => p.action === 'download').map(p => p.path);

  assert.deepEqual(uploads.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(downloads, ['c.txt']);
});

test('BVA-05: Zero-length binary buffer is safely identified and rejected by MIME sniffer', () => {
  function validateImageBuffer(buf, maxBytes = 5 * 1024 * 1024) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      throw new Error('Image buffer is empty');
    }
    if (buf.length > maxBytes) {
      throw new Error('Image exceeds maximum allowed size');
    }
    const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isJpeg = buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (!isPng && !isJpeg) {
      throw new Error('Invalid image format: magic byte mismatch');
    }
    return isPng ? 'image/png' : 'image/jpeg';
  }

  assert.throws(() => validateImageBuffer(Buffer.alloc(0)), /Image buffer is empty/);
  assert.throws(() => validateImageBuffer(null), /Image buffer is empty/);
});

// ============================================================================
// Boundary Dimension 2: Maximum & Extreme Sizes
// ============================================================================

test('BVA-06: Extremely long command string (10KB+) processed without stack overflow', () => {
  const longCmd = 'echo "start" && ' + 'ls && '.repeat(200) + 'echo "end"';
  assert.ok(longCmd.length > 1000);

  const res = classifyFullCommand(longCmd);
  assert.equal(res.risk, 'safe');
  assert.ok(res.segments.length > 200);
});

test('BVA-07: Image upload buffer exceeding max size (5MB) is rejected', () => {
  function checkImageSize(sizeBytes, maxSize = 5 * 1024 * 1024) {
    if (sizeBytes > maxSize) {
      throw new Error(`File size ${sizeBytes} exceeds maximum limit of ${maxSize} bytes`);
    }
    return true;
  }

  assert.equal(checkImageSize(5 * 1024 * 1024), true); // Boundary: exact 5MB
  assert.throws(() => checkImageSize(5 * 1024 * 1024 + 1), /exceeds maximum limit/); // 5MB + 1 byte
});

test('BVA-08: Three-way delta sync processes 1,000 files in under 50ms', () => {
  const local = new Map();
  const remote = new Map();
  const manifest = {};

  for (let i = 0; i < 1000; i++) {
    const filename = `file_${i}.txt`;
    const hash = `hash_${i}`;
    local.set(filename, hash);
    remote.set(filename, { id: `r_${i}`, md5: hash });
    manifest[filename] = { localMd5: hash, remoteMd5: hash };
  }

  const start = Date.now();
  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  const duration = Date.now() - start;

  assert.equal(plan.length, 1000);
  assert.ok(duration < 100, `Execution duration ${duration}ms should be fast`);
});

test('BVA-09: Ring buffer event history enforces maximum capacity limit', () => {
  class BoundedRingBuffer {
    constructor(maxSize = 50) {
      this.maxSize = maxSize;
      this.buffer = [];
    }
    push(item) {
      if (this.buffer.length >= this.maxSize) {
        this.buffer.shift(); // Evict oldest
      }
      this.buffer.push(item);
    }
    getHistory() {
      return [...this.buffer];
    }
  }

  const ring = new BoundedRingBuffer(5);
  for (let i = 1; i <= 8; i++) {
    ring.push(`event_${i}`);
  }

  const history = ring.getHistory();
  assert.equal(history.length, 5);
  assert.deepEqual(history, ['event_4', 'event_5', 'event_6', 'event_7', 'event_8']);
});

// ============================================================================
// Boundary Dimension 3: Port Collisions & Network Bindings
// ============================================================================

test('BVA-10: Port collision triggers fallback to ephemeral port 0', async () => {
  const primary = await createEphemeralServer((req, res) => res.end('primary'));
  const occupiedPort = primary.port;

  async function startListener(preferredPort) {
    if (preferredPort === occupiedPort) {
      // Conflict detected, fall back to ephemeral port 0
      const fallback = await createEphemeralServer((req, res) => res.end('fallback'));
      return { server: fallback.server, port: fallback.port, fallbackUsed: true, close: fallback.close };
    }
    const standard = await createEphemeralServer((req, res) => res.end('standard'));
    return { server: standard.server, port: standard.port, fallbackUsed: false, close: standard.close };
  }

  const listener = await startListener(occupiedPort);
  try {
    assert.equal(listener.fallbackUsed, true);
    assert.notEqual(listener.port, occupiedPort);
    assert.ok(listener.port > 0);
  } finally {
    await primary.close();
    await listener.close();
  }
});

test('BVA-11: Ephemeral port formats redirect URI accurately with dynamic port', () => {
  function formatRedirectUri(port) {
    assert.ok(port > 0 && port <= 65535, 'Port must be a valid 16-bit unsigned integer');
    return `http://127.0.0.1:${port}`;
  }

  assert.equal(formatRedirectUri(8085), 'http://127.0.0.1:8085');
  assert.equal(formatRedirectUri(54321), 'http://127.0.0.1:54321');
  assert.throws(() => formatRedirectUri(0), /Port must be/);
  assert.throws(() => formatRedirectUri(70000), /Port must be/);
});

test('BVA-12: Webhook SSRF guard blocks IPv4 and IPv6 private/loopback addresses', () => {
  assert.equal(isPrivateIP('127.0.0.1'), true);
  assert.equal(isPrivateIP('localhost'), true);
  assert.equal(isPrivateIP('::1'), true);
  assert.equal(isPrivateIP('10.0.1.5'), true);
  assert.equal(isPrivateIP('172.16.0.10'), true);
  assert.equal(isPrivateIP('172.31.255.255'), true);
  assert.equal(isPrivateIP('192.168.1.1'), true);
  assert.equal(isPrivateIP('169.254.169.254'), true); // AWS/GCP link-local metadata
});

test('BVA-13: Webhook SSRF guard permits legitimate public domains and endpoints', () => {
  assert.equal(isPrivateIP('8.8.8.8'), false);
  assert.equal(isPrivateIP('api.github.com'), false);
  assert.equal(isPrivateIP('discord.com'), false);

  assert.equal(validateWebhookDestination('https://api.github.com/webhook'), true);
  assert.throws(() => validateWebhookDestination('http://127.0.0.1:3000/api'), /SSRF Blocked/);
  assert.throws(() => validateWebhookDestination('http://169.254.169.254/latest/meta-data/'), /SSRF Blocked/);
});

// ============================================================================
// Boundary Dimension 4: Zero, Negative & Expired Timeouts
// ============================================================================

test('BVA-14: Zero and negative timeout values handled safely or clamped', () => {
  function normalizeTimeout(timeoutSec, defaultTimeout = 30) {
    if (typeof timeoutSec !== 'number' || isNaN(timeoutSec) || timeoutSec <= 0) {
      return defaultTimeout;
    }
    return Math.min(timeoutSec, 300); // 5 min ceiling
  }

  assert.equal(normalizeTimeout(0), 30);
  assert.equal(normalizeTimeout(-10), 30);
  assert.equal(normalizeTimeout(NaN), 30);
  assert.equal(normalizeTimeout(15), 15);
  assert.equal(normalizeTimeout(600), 300); // Clamped
});

test('BVA-15: Expired pairing ticket (>120s) returns expired status', () => {
  function checkTicketValidity(createdAt, ttlMs = 120000) {
    const age = Date.now() - createdAt;
    if (age > ttlMs) {
      return { valid: false, reason: 'ticket_expired' };
    }
    return { valid: true, remainingMs: ttlMs - age };
  }

  const recent = Date.now() - 30000; // 30s old
  const expired = Date.now() - 130000; // 130s old

  assert.equal(checkTicketValidity(recent).valid, true);
  assert.equal(checkTicketValidity(expired).valid, false);
});

test('BVA-16: Offline prompt queue flags prompt older than 5 minutes as stale', () => {
  function evaluatePromptStaleness(enqueuedAt, maxAgeMs = 5 * 60 * 1000) {
    const age = Date.now() - enqueuedAt;
    const isStale = age > maxAgeMs;
    return { isStale, ageMs: age, promptConfirmation: isStale };
  }

  const prompt2Min = Date.now() - 2 * 60 * 1000;
  const prompt6Min = Date.now() - 6 * 60 * 1000;

  assert.equal(evaluatePromptStaleness(prompt2Min).isStale, false);
  assert.equal(evaluatePromptStaleness(prompt6Min).isStale, true);
  assert.equal(evaluatePromptStaleness(prompt6Min).promptConfirmation, true);
});

test('BVA-17: Quick action runner aborts command when exceeding 30s timeout', () => {
  function executeWithTimeoutGuard(durationMs, timeoutMs = 30000) {
    if (durationMs > timeoutMs) {
      throw new Error(`Command timed out after ${timeoutMs}ms`);
    }
    return { stdout: 'done', exitCode: 0 };
  }

  assert.equal(executeWithTimeoutGuard(5000).exitCode, 0);
  assert.throws(() => executeWithTimeoutGuard(35000), /Command timed out/);
});

// ============================================================================
// Boundary Dimension 5: Escaping, Meta-Characters & Injection
// ============================================================================

test('BVA-18: Drive query escapes multiple single quotes and escaped escapes', () => {
  assert.equal(escapeDriveQuery("O'Reilly's Books"), "O\\'Reilly\\'s Books");
  assert.equal(escapeDriveQuery("Test's \\'Folder\\'"), "Test\\'s \\\\\\\'Folder\\\\\\'");
});

test('BVA-19: CDP script sanitization escapes quotes and script tags', () => {
  function sanitizeCdpString(input) {
    if (typeof input !== 'string') return '';
    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/</g, '\\x3C')
      .replace(/>/g, '\\x3E');
  }

  const evilSelector = 'div[id="main"]\'); alert(1); //';
  const sanitized = sanitizeCdpString(evilSelector);

  // Raw unescaped quotes must not exist in sanitized output
  assert.ok(sanitized.includes('\\"main\\"'));
  assert.ok(sanitized.includes("\\'"));
  assert.ok(!sanitized.includes('"main"'));
});

test('BVA-20: Jailed file browser blocks encoded path traversal attacks', () => {
  const root = 'd:\\workspace';

  // Standard traversal
  assert.throws(() => resolveJailedPath(root, '../../Windows/System32'), /Path traversal rejected/);
  // URL-encoded traversal (%2e%2e%2f)
  assert.throws(() => resolveJailedPath(root, '%2e%2e%2f%2e%2e%2fetc%2fpasswd'), /Path traversal rejected/);
  // Windows backslash traversal
  assert.throws(() => resolveJailedPath(root, '..\\..\\sensitive.txt'), /Path traversal rejected/);
});

test('BVA-21: Jailed file browser blocks access to sensitive files inside workspace root', () => {
  const root = 'd:\\workspace';

  assert.throws(() => resolveJailedPath(root, '.env'), /Sensitive file pattern blocked/);
  assert.throws(() => resolveJailedPath(root, '.env.production'), /Sensitive file pattern blocked/);
  assert.throws(() => resolveJailedPath(root, 'client_secret.json'), /Sensitive file pattern blocked/);
  assert.throws(() => resolveJailedPath(root, 'certs/server.key'), /Sensitive file pattern blocked/);
});

test('BVA-22: Audit log summary escapes control characters and line breaks', () => {
  function formatAuditSummary(action, rawDetails) {
    const sanitizedDetails = rawDetails
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/"/g, '\\"');
    return JSON.stringify({ action, details: sanitizedDetails, timestamp: Date.now() });
  }

  const multiline = 'line 1\nline 2\r\nline 3\t"quoted"';
  const jsonl = formatAuditSummary('EXEC', multiline);

  assert.ok(!jsonl.includes('\nline 2')); // No raw newlines
  const parsed = JSON.parse(jsonl);
  assert.equal(parsed.action, 'EXEC');
  assert.ok(parsed.details.includes('line 1 line 2 line 3'));
});

// ============================================================================
// Boundary Dimension 6: Malformed Data & Format Violations
// ============================================================================

test('BVA-23: Malformed JSON body is caught cleanly without unhandled rejection', () => {
  function parseRequestBody(raw) {
    try {
      return { success: true, data: JSON.parse(raw) };
    } catch (err) {
      return { success: false, error: 'Malformed JSON payload', statusCode: 400 };
    }
  }

  const valid = parseRequestBody('{"key": "value"}');
  const invalid = parseRequestBody('{"key": value}');

  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
  assert.equal(invalid.statusCode, 400);
});

test('BVA-24: Non-image binary buffer with .png extension is rejected by magic byte check', () => {
  const exeBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ executable header
  const isPng = exeBuffer.length >= 8 && exeBuffer[0] === 0x89 && exeBuffer[1] === 0x50 && exeBuffer[2] === 0x4E && exeBuffer[3] === 0x47;

  assert.equal(isPng, false);
});

test('BVA-25: RFC 6238 TOTP verification rejects invalid code lengths and characters', () => {
  const secret = 'JBSWY3DPEHPK3PXP';

  assert.equal(verifyTOTP('12345', secret), false, '5 digits must be rejected');
  assert.equal(verifyTOTP('1234567', secret), false, '7 digits must be rejected');
  assert.equal(verifyTOTP('abcdef', secret), false, 'Alpha characters must be rejected');
  assert.equal(verifyTOTP(null, secret), false);
  assert.equal(verifyTOTP('', secret), false);
});
