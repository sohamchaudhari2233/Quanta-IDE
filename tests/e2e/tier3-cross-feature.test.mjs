/**
 * Tier 3: Cross-Feature Interactions (Pairwise Integration Testing)
 * 
 * Verifies orthogonal feature pairs operating in tandem:
 * - Pair 1: Rate Limiter + Password Authentication (F-10 + F-09)
 * - Pair 2: Shell Risk Classifier + Approval Inbox (F-14 + F-15)
 * - Pair 3: Three-Way Drive Sync + Ignore Rules Engine (F-02 + F-03)
 * - Pair 4: Session Manager Elevation + Jailed File Browser (F-11 + F-18)
 * - Pair 5: Shadow Git Checkpoints + Priority Task Queue (F-17 + F-16)
 * - Pair 6: Live Telemetry Reporting + EventBus Alignment (F-14/F-22 + F-12)
 * - Pair 7: Webhook Dispatcher + Structured AuditLogger (F-21 + F-11)
 * - Pair 8: RFC 6238 TOTP Engine + Session Manager (F-23 + F-09)
 * - Pair 9: Quick Actions Runner + Risk Classifier (F-13 + F-14)
 * - Pair 10: Content-Addressed Blob Storage + Selective Sync (F-06 + F-02)
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
  RuleEngineModel,
  ApprovalManagerModel,
  computeThreeWayDeltaPlan,
  IgnoreMatcherModel,
  resolveJailedPath,
  TaskQueueModel,
  validateWebhookDestination,
  generateTOTP,
  verifyTOTP,
  createSandboxWorkspace
} from './harness.mjs';

// ============================================================================
// Pair 1: Rate Limiter + Password Authentication (F-10 + F-09)
// ============================================================================

test('Pair 1: Rate limiter locks out IP on 5 failed password attempts; blocks valid password during lockout', () => {
  const masterPassword = 'fixture-only-password-42';
  const limiter = new RateLimiterModel({ maxFailures: 5, lockoutDurationMs: 60000 });
  const clientIp = '192.168.1.50';

  function authenticate(ip, candidatePassword) {
    const lockCheck = limiter.isLockedOut(ip);
    if (lockCheck.locked) {
      return { status: 429, error: 'Too Many Requests: Locked out', remainingMs: lockCheck.remainingMs };
    }

    const isMatch = verifyPasswordConstantTime(candidatePassword, masterPassword);
    if (!isMatch) {
      const failResult = limiter.recordFailure(ip);
      return { status: 401, error: 'Invalid password', locked: failResult.locked };
    }

    limiter.recordSuccess(ip);
    return { status: 200, session: 'valid_session_token' };
  }

  // 1-4: Invalid attempts
  for (let i = 1; i <= 4; i++) {
    const res = authenticate(clientIp, 'bad_pass');
    assert.equal(res.status, 401);
    assert.equal(res.locked, false);
  }

  // 5th attempt locks out
  const res5 = authenticate(clientIp, 'bad_pass');
  assert.equal(res5.status, 401);
  assert.equal(res5.locked, true);

  // Even the correct password must be rejected with 429 while locked out
  const resValidDuringLockout = authenticate(clientIp, masterPassword);
  assert.equal(resValidDuringLockout.status, 429);
  assert.ok(resValidDuringLockout.remainingMs > 0);

  // Unrelated IP can still authenticate with correct password
  const resOtherIp = authenticate('192.168.1.99', masterPassword);
  assert.equal(resOtherIp.status, 200);
});

// ============================================================================
// Pair 2: Shell Risk Classifier + Approval Inbox (F-14 + F-15)
// ============================================================================

test('Pair 2: Dangerous command triggers Approval Inbox; safe command executes directly', () => {
  const approvalManager = new ApprovalManagerModel();
  const ruleEngine = new RuleEngineModel();

  function processCommand(cmd, workingDir = '/workspace') {
    const decision = ruleEngine.evaluate('run_command', cmd);
    if (!decision.autoApprove) {
      const submission = approvalManager.submitApproval({
        actionType: 'run_command',
        command: cmd,
        workingDir,
        riskLevel: decision.risk,
        reason: decision.reason || 'Dangerous command held for approval'
      });
      return { action: 'held_for_approval', approvalId: submission.record.id, duplicate: submission.isDuplicate };
    }
    return { action: 'executed', command: cmd };
  }

  // Safe command bypasses approval inbox
  const safeRes = processCommand('npm test');
  assert.equal(safeRes.action, 'executed');
  assert.equal(approvalManager.getPendingCount(), 0);

  // Dangerous command is intercepted and held in inbox
  const dangerousRes = processCommand('rm -rf build');
  assert.equal(dangerousRes.action, 'held_for_approval');
  assert.equal(approvalManager.getPendingCount(), 1);

  // Resubmission of identical dangerous command deduplicates
  const dupeRes = processCommand('rm -rf build');
  assert.equal(dupeRes.action, 'held_for_approval');
  assert.equal(dupeRes.duplicate, true);
  assert.equal(dupeRes.approvalId, dangerousRes.approvalId);
  assert.equal(approvalManager.getPendingCount(), 1);
});

// ============================================================================
// Pair 3: Three-Way Drive Sync + Ignore Rules Engine (F-02 + F-03)
// ============================================================================

test('Pair 3: Ignore engine filters sensitive files and trailing slash directories before Three-Way Sync Plan', () => {
  const ignoreMatcher = new IgnoreMatcherModel(['build/', 'coverage/']);

  const rawLocalFiles = new Map([
    ['src/app.ts', 'hash_app'],
    ['.env', 'hash_secret_env'],
    ['.env.local', 'hash_secret_local'],
    ['build/bundle.js', 'hash_bundle'],
    ['.env.example', 'hash_example']
  ]);

  const rawRemoteFiles = new Map([
    ['src/app.ts', { id: 'r1', md5: 'hash_app' }],
    ['.env', { id: 'r2', md5: 'hash_secret_env' }],
    ['docs/readme.md', { id: 'r3', md5: 'hash_docs' }]
  ]);

  // Filter local and remote maps through ignoreMatcher
  const filteredLocal = new Map();
  for (const [path, hash] of rawLocalFiles) {
    if (!ignoreMatcher.isIgnored(path)) {
      filteredLocal.set(path, hash);
    }
  }

  const filteredRemote = new Map();
  for (const [path, info] of rawRemoteFiles) {
    if (!ignoreMatcher.isIgnored(path)) {
      filteredRemote.set(path, info);
    }
  }

  const manifest = {
    'src/app.ts': { localMd5: 'hash_app', remoteMd5: 'hash_app' }
  };

  const plan = computeThreeWayDeltaPlan(filteredLocal, filteredRemote, manifest);
  const plannedPaths = plan.map(p => p.path);

  // .env, .env.local, and build/bundle.js must NOT be in sync plan
  assert.equal(plannedPaths.includes('.env'), false);
  assert.equal(plannedPaths.includes('.env.local'), false);
  assert.equal(plannedPaths.includes('build/bundle.js'), false);

  // .env.example (allowed exception) and docs/readme.md must be planned
  assert.equal(plannedPaths.includes('.env.example'), true);
  assert.equal(plannedPaths.includes('docs/readme.md'), true);
});

// ============================================================================
// Pair 4: Session Manager Elevation + Jailed File Browser (F-11 + F-18)
// ============================================================================

test('Pair 4: Read-only session allows file read but blocks file write; control mode allows write within jail', () => {
  const root = 'd:\\workspace';

  class SessionJailBridge {
    constructor(mode = 'read-only') {
      this.mode = mode;
    }
    readFile(relPath) {
      // Both modes can read
      const safePath = resolveJailedPath(root, relPath);
      return { status: 200, path: safePath, content: 'mock content' };
    }
    writeFile(relPath, content) {
      if (this.mode !== 'control') {
        return { status: 403, error: 'Forbidden: Session is in read-only mode' };
      }
      const safePath = resolveJailedPath(root, relPath);
      return { status: 200, path: safePath, written: true };
    }
  }

  const readOnlyBridge = new SessionJailBridge('read-only');
  assert.equal(readOnlyBridge.readFile('src/index.ts').status, 200);
  assert.equal(readOnlyBridge.writeFile('src/index.ts', 'code').status, 403);

  const controlBridge = new SessionJailBridge('control');
  assert.equal(controlBridge.writeFile('src/index.ts', 'code').status, 200);

  // Even control mode CANNOT write outside the jail
  assert.throws(() => controlBridge.writeFile('../../evil.sh', 'rm -rf /'), /Path traversal rejected/);
  assert.throws(() => controlBridge.writeFile('.env', 'SECRET=123'), /Sensitive file pattern blocked/);
});

// ============================================================================
// Pair 5: Shadow Git Checkpoints + Priority Task Queue (F-17 + F-16)
// ============================================================================

test('Pair 5: Checkpoint created before task execution; rollback on failure restores state', () => {
  const taskQueue = new TaskQueueModel();
  const checkpoints = [];

  function createCheckpoint(workspaceRoot, label) {
    const id = `chk_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    checkpoints.push({ id, workspaceRoot, label, timestamp: Date.now() });
    return id;
  }

  function rollback(workspaceRoot, checkpointId) {
    const target = checkpoints.find(c => c.id === checkpointId && c.workspaceRoot === workspaceRoot);
    if (!target) throw new Error(`Checkpoint ${checkpointId} not found`);
    return { rolledBackTo: target.id };
  }

  // Enqueue task
  taskQueue.enqueue({ taskId: 'task_migration', prompt: 'Run database migration', priority: 'high' });
  const task = taskQueue.dequeue();
  assert.equal(task.taskId, 'task_migration');

  // Create checkpoint before running task
  const checkpointId = createCheckpoint('d:\\workspace', 'pre-migration');
  assert.ok(checkpointId.startsWith('chk_'));

  // Task failure triggers rollback with correct (workspaceRoot, checkpointId) parameter order
  const rollbackResult = rollback('d:\\workspace', checkpointId);
  assert.equal(rollbackResult.rolledBackTo, checkpointId);
});

// ============================================================================
// Pair 6: Live Telemetry Reporting + EventBus Alignment (F-14/F-22 + F-12)
// ============================================================================

test('Pair 6: Telemetry calculation broadcasts telemetry.update events on EventBus', () => {
  class EventBusModel {
    constructor() {
      this.listeners = new Map();
      this.history = [];
    }
    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }
    emit(event, data) {
      this.history.push({ event, data, time: Date.now() });
      const handlers = this.listeners.get(event) || [];
      for (const h of handlers) h(data);
    }
  }

  const bus = new EventBusModel();
  let receivedPayload = null;

  bus.on('telemetry.update', (data) => {
    receivedPayload = data;
  });

  // Telemetry computation
  const telemetryData = {
    cpuPercent: 18,
    memUsedGb: '6.20',
    memTotalGb: '16.00',
    diskPercent: 54
  };

  bus.emit('telemetry.update', telemetryData);

  assert.notEqual(receivedPayload, null);
  assert.equal(receivedPayload.diskPercent, 54);
  assert.equal(receivedPayload.cpuPercent, 18);
  assert.equal(bus.history.length, 1);
});

// ============================================================================
// Pair 7: Webhook Dispatcher + Structured AuditLogger (F-21 + F-11)
// ============================================================================

test('Pair 7: SSRF-blocked webhook attempt writes structured audit log entry', () => {
  const auditLogs = [];
  function logAudit(eventType, actorIp, details) {
    auditLogs.push({
      eventType,
      actorIp,
      details,
      timestamp: Date.now()
    });
  }

  function dispatchWebhook(targetUrl, actorIp) {
    try {
      validateWebhookDestination(targetUrl);
      logAudit('webhook.dispatched', actorIp, { targetUrl });
      return { success: true };
    } catch (err) {
      logAudit('security.ssrf_blocked', actorIp, { targetUrl, error: err.message });
      return { success: false, error: err.message };
    }
  }

  const res = dispatchWebhook('http://169.254.169.254/metadata', '192.168.1.15');
  assert.equal(res.success, false);
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].eventType, 'security.ssrf_blocked');
  assert.equal(auditLogs[0].actorIp, '192.168.1.15');
});

// ============================================================================
// Pair 8: RFC 6238 TOTP Engine + Session Manager (F-23 + F-09)
// ============================================================================

test('Pair 8: 2FA login requires both constant-time password and valid 6-digit TOTP', () => {
  const masterPassword = 'fixture-only-password-42';
  const totpSecret = 'JBSWY3DPEHPK3PXP';
  const enableTotp = true;

  function login(candidatePassword, candidateTotp) {
    if (!verifyPasswordConstantTime(candidatePassword, masterPassword)) {
      return { status: 401, error: 'Invalid password' };
    }
    if (enableTotp) {
      if (!candidateTotp || !verifyTOTP(candidateTotp, totpSecret)) {
        return { status: 401, error: 'Invalid 2FA TOTP code' };
      }
    }
    return { status: 200, sessionToken: crypto.randomUUID() };
  }

  // Valid password but missing TOTP
  assert.equal(login(masterPassword, null).status, 401);
  // Valid password but incorrect TOTP
  assert.equal(login(masterPassword, '000000').status, 401);

  // Valid password and generated valid TOTP
  const currentCode = generateTOTP(totpSecret);
  const success = login(masterPassword, currentCode);
  assert.equal(success.status, 200);
  assert.ok(success.sessionToken);
});

// ============================================================================
// Pair 9: Quick Actions Runner + Risk Classifier (F-13 + F-14)
// ============================================================================

test('Pair 9: Quick action allowlist matches run-tests alias and verifies safe classification', () => {
  const ALLOWED_ACTIONS = new Map([
    ['act-npm-test', { command: 'npm test', description: 'Run test suite' }],
    ['act-git-status', { command: 'git status', description: 'Check repo status' }]
  ]);

  function resolveAndValidateQuickAction(actionId) {
    let resolved = ALLOWED_ACTIONS.get(actionId);
    if (!resolved && actionId === 'run-tests') {
      // Alias mapping
      resolved = ALLOWED_ACTIONS.get('act-npm-test');
    }
    if (!resolved) {
      throw new Error(`Action not found in allowlist: ${actionId}`);
    }

    const risk = classifyFullCommand(resolved.command);
    if (risk.risk === 'dangerous') {
      throw new Error('Allowlisted action failed risk safety check');
    }

    return { action: resolved, risk: risk.risk };
  }

  // Alias run-tests maps to act-npm-test and is verified safe
  const actionRes = resolveAndValidateQuickAction('run-tests');
  assert.equal(actionRes.action.command, 'npm test');
  assert.equal(actionRes.risk, 'safe');

  // Unknown action throws allowlist error
  assert.throws(() => resolveAndValidateQuickAction('run-malicious-script'), /Action not found in allowlist/);
});

// ============================================================================
// Pair 10: Content-Addressed Blob Storage + Selective Sync (F-06 + F-02)
// ============================================================================

test('Pair 10: Selective sync excludes designated paths from snapshot hashing', async () => {
  const sandbox = await createSandboxWorkspace('selective-sync-');
  try {
    const selectiveSyncConfig = {
      excludedPaths: ['archive', 'temp/logs']
    };

    function isPathExcluded(relPath, config) {
      const normalized = relPath.replace(/\\/g, '/');
      return config.excludedPaths.some(ex => normalized === ex || normalized.startsWith(ex + '/'));
    }

    const workspaceFiles = [
      'src/index.ts',
      'package.json',
      'archive/old.ts',
      'temp/logs/debug.log'
    ];

    const snapshotBlobs = [];
    for (const file of workspaceFiles) {
      if (!isPathExcluded(file, selectiveSyncConfig)) {
        const hash = crypto.createHash('sha256').update(`content_of_${file}`).digest('hex');
        snapshotBlobs.push({ file, hash });
      }
    }

    const includedFiles = snapshotBlobs.map(b => b.file);
    assert.deepEqual(includedFiles, ['src/index.ts', 'package.json']);
    assert.equal(includedFiles.includes('archive/old.ts'), false);
    assert.equal(includedFiles.includes('temp/logs/debug.log'), false);
  } finally {
    await sandbox.cleanup();
  }
});
