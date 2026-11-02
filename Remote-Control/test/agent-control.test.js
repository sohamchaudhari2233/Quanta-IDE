import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandRisk, splitCommandSegments } from '../agent/riskClassifier.js';
import { RuleEngine } from '../agent/ruleEngine.js';
import { ApprovalManager } from '../agent/approvalManager.js';
import { TaskQueue } from '../agent/taskQueue.js';
import { EventBus } from '../core/eventBus.js';

test('RiskClassifier: accurately categorizes safe commands', () => {
    assert.equal(classifyCommandRisk('ls -la').risk, 'safe');
    assert.equal(classifyCommandRisk('git status').risk, 'safe');
    assert.equal(classifyCommandRisk('pwd').risk, 'safe');
    assert.equal(classifyCommandRisk('npm test').risk, 'safe');
    assert.equal(classifyCommandRisk('echo "hello world"').risk, 'safe');
});

test('RiskClassifier: accurately categorizes caution commands', () => {
    assert.equal(classifyCommandRisk('git checkout main').risk, 'caution');
    assert.equal(classifyCommandRisk('mkdir new_folder').risk, 'caution');
    assert.equal(classifyCommandRisk('npm run build').risk, 'caution');
});

test('RiskClassifier: flags dangerous commands and sensitive file access', () => {
    assert.equal(classifyCommandRisk('rm -rf node_modules').risk, 'dangerous');
    assert.equal(classifyCommandRisk('sudo apt update').risk, 'dangerous');
    assert.equal(classifyCommandRisk('git push --force origin main').risk, 'dangerous');
    assert.equal(classifyCommandRisk('cat .env').risk, 'dangerous');
    assert.equal(classifyCommandRisk('cp client_secret.json /tmp/').risk, 'dangerous');
});

test('RiskClassifier: compound commands escalate to highest risk segment', () => {
    // Safe + Dangerous -> Dangerous
    assert.equal(classifyCommandRisk('ls -la && rm -rf /tmp/test').risk, 'dangerous');
    // Safe + Caution -> Caution
    assert.equal(classifyCommandRisk('pwd; git checkout main').risk, 'caution');
});

test('RuleEngine: enforces strict hard floor preventing auto-approval of dangerous commands', () => {
    const rules = [
        {
            id: 'allow-rm',
            enabled: true,
            actionType: 'run_command',
            commandPattern: '^rm -rf .*',
            riskLevel: 'dangerous'
        },
        {
            id: 'allow-npm-test',
            enabled: true,
            actionType: 'run_command',
            commandPattern: '^npm test$',
            riskLevel: 'caution'
        }
    ];

    const engine = new RuleEngine(rules);

    // Hard floor violation check: rm -rf is dangerous, MUST NOT be auto-approved
    const rmDecision = engine.canAutoApprove('run_command', 'rm -rf build');
    assert.equal(rmDecision.autoApprove, false);
    assert.equal(rmDecision.risk, 'dangerous');
    assert.match(rmDecision.reason, /Hard floor/i);

    // Safe/caution command with matching rule CAN be auto-approved
    const testDecision = engine.canAutoApprove('run_command', 'npm test');
    assert.equal(testDecision.autoApprove, true);
});

test('ApprovalManager: handles deduplication, fingerprinting, and resolution lifecycle', () => {
    const manager = new ApprovalManager();

    const req1 = manager.requestApproval({
        action: 'run_command',
        command: 'npm run build',
        targetPath: 'package.json'
    });

    assert.ok(req1.id);
    assert.equal(req1.status, 'pending');

    // Deduplication test: identical fingerprint within window returns existing request
    const req2 = manager.requestApproval({
        action: 'run_command',
        command: 'npm run build',
        targetPath: 'package.json'
    });
    assert.equal(req2.id, req1.id);

    // Resolve approval
    const resolved = manager.resolve(req1.id, 'approve', { user: 'tester' });
    assert.equal(resolved.status, 'approved');
    assert.equal(manager.getPending().length, 0);

    // Cannot resolve twice
    assert.throws(() => manager.resolve(req1.id, 'reject'), /already resolved/i);
});

test('TaskQueue: processes tasks in priority order and enforces idempotency', () => {
    const queue = new TaskQueue();
    queue.clear();

    const t1 = queue.enqueue({ prompt: 'Task Normal', priority: 5, idempotencyKey: 'key-1' });
    const t2 = queue.enqueue({ prompt: 'Task Urgent', priority: 10, idempotencyKey: 'key-2' });

    // Idempotency check: duplicate key returns original task
    const t1Dupe = queue.enqueue({ prompt: 'Task Normal Again', priority: 5, idempotencyKey: 'key-1' });
    assert.equal(t1Dupe.id, t1.id);

    // Priority ordering check: highest priority dispatched first
    const next1 = queue.getNextTask();
    assert.equal(next1.id, t2.id);

    queue.startTask(next1.id);
    queue.completeTask(next1.id, { result: 'ok' });

    const next2 = queue.getNextTask();
    assert.equal(next2.id, t1.id);
});

test('EventBus: buffers history and broadcasts typed events', () => {
    const bus = new EventBus({ maxHistory: 10 });
    const received = [];

    bus.on('test:event', (data) => received.push(data));

    bus.emit('test:event', { msg: 'first' });
    bus.emit('test:event', { msg: 'second' });

    assert.equal(received.length, 2);
    assert.equal(received[0].payload.msg, 'first');

    const history = bus.getHistory(5);
    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'test:event');
});
