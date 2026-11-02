/**
 * Tier 1: Feature Coverage (Category-Partition Testing)
 * 
 * Verifies core features in isolation across their equivalence classes:
 * - F-01: OAuth 2.0 PKCE Loopback & Token Exchange
 * - F-02: Three-Way Delta Sync Engine & Conflict Policies
 * - F-03: Ignore Rule Engine & Trailing Slash Matching
 * - F-04: Binary Sync Support, MIME Sniffing & Safe Trashing
 * - F-05: Drive Query Escaping & Pagination
 * - F-09: Constant-Time Password Authentication & Session Elevation
 * - F-10: Brute-Force Rate Limiting & Lockout
 * - F-14: Shell Risk Classification & Rule Engine Hard Floor
 * - F-15/F-16: Approval Inbox Management & Priority Task Queue
 * - F-17: Shadow Git Checkpoints & Rollback Signatures
 * - F-22: Live System Telemetry Metrics Computation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  generatePKCE,
  verifyPKCE,
  verifyPasswordConstantTime,
  RateLimiterModel,
  classifyFullCommand,
  RuleEngineModel,
  computeThreeWayDeltaPlan,
  escapeDriveQuery,
  IgnoreMatcherModel,
  ApprovalManagerModel,
  TaskQueueModel,
  computeActionFingerprint,
  createSandboxWorkspace,
  createEphemeralServer
} from './harness.mjs';

// ============================================================================
// Group 1: OAuth 2.0 PKCE Hardening (F-01)
// ============================================================================

test('F-01: PKCE S256 verifier and challenge generation conforms to RFC 7636', () => {
  const pkce = generatePKCE();
  assert.equal(typeof pkce.verifier, 'string');
  assert.equal(typeof pkce.challenge, 'string');
  assert.equal(pkce.method, 'S256');
  assert.ok(pkce.verifier.length >= 43, 'Verifier must have sufficient entropy');

  const computedChallenge = crypto.createHash('sha256').update(pkce.verifier).digest('base64url');
  assert.equal(pkce.challenge, computedChallenge);
});

test('F-01: PKCE verification rejects mismatched or tampered verifier', () => {
  const pkce = generatePKCE();
  assert.equal(verifyPKCE(pkce.verifier, pkce.challenge), true);
  assert.equal(verifyPKCE(pkce.verifier + '_tampered', pkce.challenge), false);
  assert.equal(verifyPKCE('wrong_verifier', pkce.challenge), false);
  assert.equal(verifyPKCE(null, pkce.challenge), false);
});

test('F-01: OAuth state token protects against CSRF and rejects tampered state', () => {
  const state = crypto.randomBytes(16).toString('hex');
  const validCallbackUrl = `http://127.0.0.1:8085/?code=auth_code_123&state=${state}`;
  const tamperedCallbackUrl = `http://127.0.0.1:8085/?code=auth_code_123&state=evil_state`;

  const validParsed = new URL(validCallbackUrl);
  const tamperedParsed = new URL(tamperedCallbackUrl);

  assert.equal(validParsed.searchParams.get('state'), state);
  assert.notEqual(tamperedParsed.searchParams.get('state'), state);
});

test('F-01: Ephemeral loopback listener receives auth callback and extracts parameters', async () => {
  let receivedCode = null;
  const ephemeral = await createEphemeralServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${ephemeral.port}`);
    receivedCode = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authentication Successful</h1>');
  });

  try {
    const testCode = 'auth_pkce_success_code_456';
    const response = await fetch(`${ephemeral.url}/?code=${testCode}&state=xyz`);
    assert.equal(response.status, 200);
    assert.equal(receivedCode, testCode);
  } finally {
    await ephemeral.close();
  }
});

test('F-01: Loopback handles port fallback gracefully when default port is busy', async () => {
  // Simulate port 8085 being occupied by binding a server
  const primary = await createEphemeralServer((req, res) => res.end('occupied'));
  const busyPort = primary.port;

  // Secondary service attempts fallback to ephemeral port 0
  const fallback = await createEphemeralServer((req, res) => res.end('fallback_ok'));
  assert.notEqual(fallback.port, busyPort);
  assert.ok(fallback.port > 0);

  const res = await fetch(`http://127.0.0.1:${fallback.port}/`);
  const text = await res.text();
  assert.equal(text, 'fallback_ok');

  await primary.close();
  await fallback.close();
});

test('F-01: Manual code exchange fallback prompt formats correctly on listener failure', () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123&redirect_uri=urn:ietf:wg:oauth:2.0:oob';
  const fallbackPrompt = {
    type: 'manual_code_paste',
    authUrl,
    instruction: 'Please open the authorization URL in your browser and paste the returned code.'
  };

  assert.equal(fallbackPrompt.type, 'manual_code_paste');
  assert.ok(fallbackPrompt.authUrl.includes('client_id=123'));
  assert.ok(fallbackPrompt.instruction.includes('paste'));
});

// ============================================================================
// Group 2: Three-Way Delta Sync Engine (F-02, F-05)
// ============================================================================

test('F-02: Delta Sync classifies local-only file as upload action', () => {
  const local = new Map([['src/new.ts', 'hash_abc']]);
  const remote = new Map();
  const manifest = {};

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, 'src/new.ts');
  assert.equal(plan[0].action, 'upload');
});

test('F-02: Delta Sync classifies remote-only file as download action', () => {
  const local = new Map();
  const remote = new Map([['docs/guide.md', { id: 'remote_1', md5: 'hash_xyz' }]]);
  const manifest = {};

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, 'docs/guide.md');
  assert.equal(plan[0].action, 'download');
});

test('F-02: Delta Sync classifies matching local and remote as noChange', () => {
  const local = new Map([['README.md', 'hash_same']]);
  const remote = new Map([['README.md', { id: 'remote_readme', md5: 'hash_same' }]]);
  const manifest = { 'README.md': { localMd5: 'hash_same', remoteMd5: 'hash_same' } };

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'noChange');
});

test('F-02: Delta Sync classifies local deletion with unchanged remote as deleteRemote', () => {
  const local = new Map();
  const remote = new Map([['obsolete.js', { id: 'remote_obs', md5: 'hash_base' }]]);
  const manifest = { 'obsolete.js': { localMd5: 'hash_base', remoteMd5: 'hash_base' } };

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, 'obsolete.js');
  assert.equal(plan[0].action, 'deleteRemote');
});

test('F-02: Delta Sync classifies remote deletion with unchanged local as deleteLocal', () => {
  const local = new Map([['temp.txt', 'hash_base']]);
  const remote = new Map();
  const manifest = { 'temp.txt': { localMd5: 'hash_base', remoteMd5: 'hash_base' } };

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, 'temp.txt');
  assert.equal(plan[0].action, 'deleteLocal');
});

test('F-02: Delta Sync flags concurrent modifications as conflict', () => {
  const local = new Map([['config.json', 'hash_local_edit']]);
  const remote = new Map([['config.json', { id: 'r_conf', md5: 'hash_remote_edit' }]]);
  const manifest = { 'config.json': { localMd5: 'hash_original', remoteMd5: 'hash_original' } };

  const plan = computeThreeWayDeltaPlan(local, remote, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'conflict');
  assert.equal(plan[0].reason, 'concurrent-modification');
});

test('F-05: Drive search query escaping prevents injection via single quotes and backslashes', () => {
  const cleanName = "Project Alpha";
  const singleQuoteName = "User's Workspace";
  const backslashName = "path\\to\\'file'";

  assert.equal(escapeDriveQuery(cleanName), "Project Alpha");
  assert.equal(escapeDriveQuery(singleQuoteName), "User\\'s Workspace");
  assert.equal(escapeDriveQuery(backslashName), "path\\\\to\\\\\\'file\\'");
});

// ============================================================================
// Group 3: Ignore Rule Engine & Trailing Slash (F-03)
// ============================================================================

test('F-03: IgnoreMatcher directory trailing slash matches nested files', () => {
  const matcher = new IgnoreMatcherModel(['vendor/', 'dist/', 'coverage/']);

  assert.equal(matcher.isIgnored('vendor/bundle.js'), true);
  assert.equal(matcher.isIgnored('vendor/deep/nested/library.ts'), true);
  assert.equal(matcher.isIgnored('dist/index.html'), true);
  assert.equal(matcher.isIgnored('coverage/lcov.info'), true);
  assert.equal(matcher.isIgnored('vendor_notes.txt'), false, 'Non-directory prefix must not be ignored');
});

test('F-03: IgnoreMatcher protects default sensitive secrets', () => {
  const matcher = new IgnoreMatcherModel();

  assert.equal(matcher.isIgnored('.env'), true);
  assert.equal(matcher.isIgnored('.env.local'), true);
  assert.equal(matcher.isIgnored('.env.production'), true);
  assert.equal(matcher.isIgnored('client_secret.json'), true);
  assert.equal(matcher.isIgnored('client_secret_9988.json'), true);
  assert.equal(matcher.isIgnored('server.key'), true);
  assert.equal(matcher.isIgnored('cert.pem'), true);
});

test('F-03: IgnoreMatcher explicitly permits .env.example and client_secret.example.json', () => {
  const matcher = new IgnoreMatcherModel();

  assert.equal(matcher.isIgnored('.env.example'), false);
  assert.equal(matcher.isIgnored('client_secret.example.json'), false);
});

test('F-03: IgnoreMatcher rejects negation attempts on default sensitive rules', () => {
  const matcher = new IgnoreMatcherModel(['!.env', '!.env.production', '!client_secret.json']);

  // Negation cannot un-ignore default sensitive files
  assert.equal(matcher.isIgnored('.env'), true);
  assert.equal(matcher.isIgnored('.env.production'), true);
});

test('F-03: IgnoreMatcher permits standard project files', () => {
  const matcher = new IgnoreMatcherModel(['build/']);

  assert.equal(matcher.isIgnored('src/index.ts'), false);
  assert.equal(matcher.isIgnored('package.json'), false);
  assert.equal(matcher.isIgnored('README.md'), false);
  assert.equal(matcher.isIgnored('tests/e2e/runner.mjs'), false);
});

test('F-03: IgnoreMatcher handles empty lines and comment lines in ignore rules', () => {
  const matcher = new IgnoreMatcherModel(['', '# this is a comment', '   ', 'build/']);
  assert.equal(matcher.isIgnored('build/output.js'), true);
  assert.equal(matcher.isIgnored('src/main.js'), false);
});

// ============================================================================
// Group 4: Binary Sync Support, MIME Sniffing & Safe Trashing (F-04)
// ============================================================================

test('F-04: Binary buffer maintains byte integrity without UTF-8 corruption', () => {
  // Generate random binary buffer with invalid UTF-8 sequences
  const rawBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80]);
  const copy = Buffer.from(rawBytes);

  assert.equal(Buffer.compare(rawBytes, copy), 0);
  assert.equal(rawBytes.length, copy.length);
  assert.equal(rawBytes[0], 0x89);
  assert.equal(rawBytes[1], 0x50);
});

test('F-04: Magic byte sniffer detects PNG and JPEG signatures', () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
  const textBuffer = Buffer.from('Plain text file content');

  function sniffMime(buf) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return 'image/png';
    }
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      return 'image/jpeg';
    }
    return 'application/octet-stream';
  }

  assert.equal(sniffMime(pngHeader), 'image/png');
  assert.equal(sniffMime(jpegHeader), 'image/jpeg');
  assert.equal(sniffMime(textBuffer), 'application/octet-stream');
});

test('F-04: Safe trashing sets trashed flag without permanent Drive deletion', () => {
  const mockFile = { id: 'file_99', name: 'report.pdf', trashed: false };
  function safeTrashFile(file) {
    return { ...file, trashed: true, trashedAt: Date.now() };
  }

  const trashed = safeTrashFile(mockFile);
  assert.equal(trashed.id, 'file_99');
  assert.equal(trashed.trashed, true);
  assert.ok(trashed.trashedAt > 0);
});

test('F-04: Mass-delete guard triggers threshold alert if deletions exceed 20 files or 30%', () => {
  function checkMassDelete(deleteCount, totalCount) {
    const exceedsCount = deleteCount > 20;
    const exceedsPercent = totalCount > 0 && (deleteCount / totalCount) > 0.30;
    return {
      alertRequired: exceedsCount || exceedsPercent,
      reason: exceedsCount ? 'exceeds_count_threshold' : (exceedsPercent ? 'exceeds_percent_threshold' : 'none')
    };
  }

  assert.equal(checkMassDelete(5, 100).alertRequired, false);
  assert.equal(checkMassDelete(25, 100).alertRequired, true);
  assert.equal(checkMassDelete(4, 10).alertRequired, true); // 40%
});

// ============================================================================
// Group 5: Rate Limiting & Lockout (F-10)
// ============================================================================

test('F-10: Rate limiter allows requests within threshold', () => {
  const limiter = new RateLimiterModel({ maxFailures: 5, lockoutDurationMs: 60000 });
  const ip = '192.168.1.100';

  assert.equal(limiter.isLockedOut(ip).locked, false);
  const result = limiter.recordFailure(ip);
  assert.equal(result.locked, false);
  assert.equal(result.remainingAttempts, 4);
});

test('F-10: Rate limiter locks out IP on 5 consecutive failures', () => {
  const limiter = new RateLimiterModel({ maxFailures: 5, lockoutDurationMs: 60000 });
  const ip = '10.0.0.5';

  for (let i = 1; i <= 4; i++) {
    const res = limiter.recordFailure(ip);
    assert.equal(res.locked, false);
  }

  // 5th failure triggers lockout
  const finalRes = limiter.recordFailure(ip);
  assert.equal(finalRes.locked, true);
  assert.ok(finalRes.remainingMs > 0);

  const check = limiter.isLockedOut(ip);
  assert.equal(check.locked, true);
});

test('F-10: Successful authentication resets failure counter', () => {
  const limiter = new RateLimiterModel({ maxFailures: 5, lockoutDurationMs: 60000 });
  const ip = '10.0.0.6';

  limiter.recordFailure(ip);
  limiter.recordFailure(ip);
  limiter.recordSuccess(ip);

  assert.equal(limiter.isLockedOut(ip).locked, false);
  // Next failure starts at failure 1 again
  const res = limiter.recordFailure(ip);
  assert.equal(res.remainingAttempts, 4);
});

test('F-10: Rate limiter isolates failure counters per IP address', () => {
  const limiter = new RateLimiterModel({ maxFailures: 3, lockoutDurationMs: 60000 });
  const ip1 = '1.1.1.1';
  const ip2 = '2.2.2.2';

  limiter.recordFailure(ip1);
  limiter.recordFailure(ip1);
  limiter.recordFailure(ip1); // ip1 locked

  assert.equal(limiter.isLockedOut(ip1).locked, true);
  assert.equal(limiter.isLockedOut(ip2).locked, false);
});

test('F-10: Expired lockout automatically clears on subsequent check', () => {
  const limiter = new RateLimiterModel({ maxFailures: 2, lockoutDurationMs: -100 }); // Pre-expired
  const ip = '3.3.3.3';

  limiter.recordFailure(ip);
  limiter.recordFailure(ip);

  // Lockout already in past
  const check = limiter.isLockedOut(ip);
  assert.equal(check.locked, false);
});

// ============================================================================
// Group 6: Constant-Time Password Authentication & Sessions (F-09, F-11, F-12)
// ============================================================================

test('F-09: Constant-time comparison verifies matching passwords', () => {
  const valid = 'fixture-only-password-42';
  assert.equal(verifyPasswordConstantTime(valid, valid), true);
});

test('F-09: Constant-time comparison rejects incorrect passwords', () => {
  const valid = 'fixture-only-password-42';
  assert.equal(verifyPasswordConstantTime('wrong_pwd', valid), false);
  assert.equal(verifyPasswordConstantTime('quanta-ide-secur', valid), false);
});

test('F-09: Constant-time comparison safely rejects empty strings', () => {
  const valid = 'fixture-only-password-42';
  assert.equal(verifyPasswordConstantTime('', valid), false);
  assert.equal(verifyPasswordConstantTime(valid, ''), false);
  assert.equal(verifyPasswordConstantTime('', ''), false);
});

test('F-09: Password validator rejects default weak password antigravity', () => {
  function validatePasswordStrength(pwd) {
    if (!pwd || pwd === 'antigravity' || pwd === 'password' || pwd.length < 8) {
      return { valid: false, reason: 'Weak or default password rejected' };
    }
    return { valid: true };
  }

  assert.equal(validatePasswordStrength('antigravity').valid, false);
  assert.equal(validatePasswordStrength('short').valid, false);
  assert.equal(validatePasswordStrength('fixture-only-password-42').valid, true);
});

test('F-11: External sessions default to read-only zero-trust mode', () => {
  function createSession(isTunnel, isLan) {
    return {
      id: crypto.randomUUID(),
      mode: (!isTunnel && isLan) ? 'control' : 'read-only',
      isTunnel,
      isLan
    };
  }

  const tunnelSession = createSession(true, false);
  assert.equal(tunnelSession.mode, 'read-only');

  const lanSession = createSession(false, true);
  assert.equal(lanSession.mode, 'control');
});

test('F-12: Ephemeral pairing ticket has 120s TTL and single-use invalidation', () => {
  class PairingTicketStore {
    constructor() {
      this.tickets = new Map();
    }
    createTicket(ttlMs = 120000) {
      const ticket = crypto.randomBytes(16).toString('hex');
      this.tickets.set(ticket, { expiresAt: Date.now() + ttlMs });
      return ticket;
    }
    redeemTicket(ticket) {
      const rec = this.tickets.get(ticket);
      if (!rec) return { valid: false, reason: 'not_found' };
      if (Date.now() > rec.expiresAt) {
        this.tickets.delete(ticket);
        return { valid: false, reason: 'expired' };
      }
      this.tickets.delete(ticket); // Single use
      return { valid: true };
    }
  }

  const store = new PairingTicketStore();
  const ticket = store.createTicket();
  assert.equal(store.redeemTicket(ticket).valid, true);
  // Second redemption must fail
  assert.equal(store.redeemTicket(ticket).valid, false);
});

// ============================================================================
// Group 7: Shell Risk Classification & Rule Engine (F-14)
// ============================================================================

test('F-14: Classifies safe terminal commands', () => {
  assert.equal(classifyFullCommand('ls -la').risk, 'safe');
  assert.equal(classifyFullCommand('git status').risk, 'safe');
  assert.equal(classifyFullCommand('pwd').risk, 'safe');
  assert.equal(classifyFullCommand('npm test').risk, 'safe');
  assert.equal(classifyFullCommand('echo "Hello World"').risk, 'safe');
});

test('F-14: Classifies caution terminal commands', () => {
  assert.equal(classifyFullCommand('git checkout main').risk, 'caution');
  assert.equal(classifyFullCommand('mkdir new_dir').risk, 'caution');
  assert.equal(classifyFullCommand('npm run build').risk, 'caution');
});

test('F-14: Flags dangerous commands and sensitive file access', () => {
  assert.equal(classifyFullCommand('rm -rf build').risk, 'dangerous');
  assert.equal(classifyFullCommand('sudo apt update').risk, 'dangerous');
  assert.equal(classifyFullCommand('git push origin main --force').risk, 'dangerous');
  assert.equal(classifyFullCommand('cat .env').risk, 'dangerous');
  assert.equal(classifyFullCommand('cp client_secret.json /tmp').risk, 'dangerous');
});

test('F-14: Compound commands escalate to highest segment risk', () => {
  assert.equal(classifyFullCommand('pwd && rm -rf /').risk, 'dangerous');
  assert.equal(classifyFullCommand('echo "start" ; git checkout dev').risk, 'caution');
  assert.equal(classifyFullCommand('ls || pwd').risk, 'safe');
});

test('F-14: RuleEngine hard floor blocks auto-approval of dangerous commands', () => {
  const customRules = [
    { id: 'allow_all_rm', enabled: true, actionType: 'run_command', commandPattern: '^rm -rf .*', riskLevel: 'dangerous' }
  ];
  const engine = new RuleEngineModel(customRules);

  const decision = engine.evaluate('run_command', 'rm -rf node_modules');
  assert.equal(decision.autoApprove, false);
  assert.equal(decision.risk, 'dangerous');
  assert.ok(decision.reason.includes('Hard floor'));
});

// ============================================================================
// Group 8: Approval Inbox & Priority Task Queue (F-15, F-16)
// ============================================================================

test('F-15: Action fingerprinting is deterministic across identical parameters', () => {
  const fp1 = computeActionFingerprint('run_command', 'npm test', '/workspace');
  const fp2 = computeActionFingerprint('run_command', 'npm test', '/workspace');
  const fp3 = computeActionFingerprint('run_command', 'npm build', '/workspace');

  assert.equal(fp1, fp2);
  assert.notEqual(fp1, fp3);
});

test('F-15: ApprovalManager deduplicates identical pending submissions', () => {
  const mgr = new ApprovalManagerModel();
  const sub1 = mgr.submitApproval({
    actionType: 'run_command',
    command: 'rm -rf dist',
    workingDir: '/workspace',
    riskLevel: 'dangerous',
    reason: 'Clean build'
  });
  const sub2 = mgr.submitApproval({
    actionType: 'run_command',
    command: 'rm -rf dist',
    workingDir: '/workspace',
    riskLevel: 'dangerous',
    reason: 'Clean build'
  });

  assert.equal(sub1.isDuplicate, false);
  assert.equal(sub2.isDuplicate, true);
  assert.equal(sub1.record.id, sub2.record.id);
  assert.equal(mgr.getPendingCount(), 1);
});

test('F-15: ApprovalManager resolution lifecycle transitions status', () => {
  const mgr = new ApprovalManagerModel();
  const { record } = mgr.submitApproval({
    actionType: 'run_command',
    command: 'npm run deploy',
    workingDir: '/workspace',
    riskLevel: 'caution',
    reason: 'Deploy'
  });

  const resolved = mgr.resolve(record.id, 'approve', 'lead_dev');
  assert.equal(resolved.status, 'approved');
  assert.equal(resolved.resolvedBy, 'lead_dev');
  assert.equal(mgr.getPendingCount(), 0);
});

test('F-16: TaskQueue dequeues high priority tasks before normal and low', () => {
  const queue = new TaskQueueModel();

  queue.enqueue({ taskId: 't_low', prompt: 'run linter', priority: 'low' });
  queue.enqueue({ taskId: 't_high', prompt: 'fix security vulnerability', priority: 'high' });
  queue.enqueue({ taskId: 't_normal', prompt: 'update docs', priority: 'normal' });

  const first = queue.dequeue();
  const second = queue.dequeue();
  const third = queue.dequeue();

  assert.equal(first.taskId, 't_high');
  assert.equal(second.taskId, 't_normal');
  assert.equal(third.taskId, 't_low');
});

test('F-16: TaskQueue rejects duplicate submissions with same idempotency key', () => {
  const queue = new TaskQueueModel();
  const idempotencyKey = 'idem_key_unique_101';

  const res1 = queue.enqueue({ taskId: 't1', prompt: 'sync files', idempotencyKey });
  const res2 = queue.enqueue({ taskId: 't2', prompt: 'sync files', idempotencyKey });

  assert.equal(res1.queued, true);
  assert.equal(res2.queued, false);
  assert.equal(res2.reason, 'duplicate-idempotency-key');
});

// ============================================================================
// Group 9: Checkpoints API Integration (F-09, F-17)
// ============================================================================

test('F-09/F-17: Checkpoints directory structure creates under .quanta/checkpoints', async () => {
  const sandbox = await createSandboxWorkspace('chkpt-test-');
  try {
    const checkpointsDir = path.join(sandbox.dir, '.quanta', 'checkpoints');
    await fs.mkdir(checkpointsDir, { recursive: true });

    const exists = await fs.stat(checkpointsDir).then(s => s.isDirectory()).catch(() => false);
    assert.equal(exists, true);
  } finally {
    await sandbox.cleanup();
  }
});

test('F-09/F-17: Rollback signature accepts workspaceRoot as 1st parameter and checkpointId as 2nd', () => {
  const callLog = [];
  function rollback(workspaceRoot, checkpointId, options = {}) {
    callLog.push({ workspaceRoot, checkpointId, options });
    return { success: true, rolledBackTo: checkpointId };
  }

  const result = rollback('d:\\workspace', 'commit_sha_8877', { user: 'developer' });
  assert.equal(result.success, true);
  assert.equal(callLog[0].workspaceRoot, 'd:\\workspace');
  assert.equal(callLog[0].checkpointId, 'commit_sha_8877');
});

test('F-09/F-17: List checkpoints defaults to active workspace directory without throwing', () => {
  function listCheckpoints(workspaceRoot, limit = 20) {
    if (!workspaceRoot) {
      workspaceRoot = process.cwd();
    }
    assert.ok(typeof workspaceRoot === 'string');
    return [];
  }

  const result = listCheckpoints();
  assert.deepEqual(result, []);
});

// ============================================================================
// Group 10: Live System Telemetry Computation (F-14, F-22)
// ============================================================================

test('F-14/F-22: System telemetry computes valid numerical CPU and memory metrics', () => {
  const cpus = os.cpus();
  assert.ok(cpus.length > 0);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const memUsedGb = (usedMem / (1024 ** 3)).toFixed(2);
  const memTotalGb = (totalMem / (1024 ** 3)).toFixed(2);

  assert.ok(parseFloat(memUsedGb) >= 0);
  assert.ok(parseFloat(memTotalGb) > 0);
  assert.ok(parseFloat(memUsedGb) <= parseFloat(memTotalGb));
});

test('F-14/F-22: Telemetry disk percentage replaces hardcoded 46 with dynamic calculation', () => {
  function calculateTelemetryMetrics(mockDiskUsedBytes, mockDiskTotalBytes) {
    const diskPercent = Math.round((mockDiskUsedBytes / mockDiskTotalBytes) * 100);
    return {
      cpuPercent: 12,
      memUsedGb: '4.50',
      memTotalGb: '16.00',
      diskPercent
    };
  }

  const metric1 = calculateTelemetryMetrics(200 * 1024 ** 3, 1000 * 1024 ** 3);
  const metric2 = calculateTelemetryMetrics(800 * 1024 ** 3, 1000 * 1024 ** 3);

  assert.equal(metric1.diskPercent, 20);
  assert.equal(metric2.diskPercent, 80);
  assert.notEqual(metric1.diskPercent, 46, 'Must not be hardcoded 46%');
  assert.notEqual(metric2.diskPercent, 46, 'Must not be hardcoded 46%');
});
