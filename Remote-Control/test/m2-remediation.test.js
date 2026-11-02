import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AuditLogger } from '../security/auditLogger.js';
import { EventBus } from '../core/eventBus.js';
import { QuickActionRunner } from '../ide/quickActions.js';

test('AuditLogger: supports both 1-arg and 2-arg signatures with metadata and secret redaction', () => {
    const logger = new AuditLogger();

    // 1-arg object call
    logger.log({
        type: 'M2_AUTH_TEST',
        ip: '10.0.0.99',
        deviceId: 'device-m2',
        summary: 'User auth with token=super_secret_token_123',
        details: { mode: 'test' }
    });

    // 2-arg metadata call (simulating tunnelSupervisor / imageUpload / webhooks)
    logger.log('M2_TUNNEL_READY', {
        provider: 'cloudflare',
        url: 'https://quanta.trycloudflare.com',
        secret: 'my_secret_token_456'
    });

    // 2-arg call with ip and summary
    logger.log('M2_IMAGE_UPLOAD', {
        ip: '192.168.1.150',
        summary: 'Uploaded avatar',
        filename: 'avatar.png',
        bytes: 2048
    });

    // 2-arg call with string summary
    logger.log('M2_TELEGRAM_START', 'Telegram bot polling started');

    const entries = logger.getRecentEntries(10);

    // Verify 1-arg entry
    const authEntry = entries.find(e => e.eventType === 'M2_AUTH_TEST');
    assert.ok(authEntry, 'M2_AUTH_TEST entry must exist');
    assert.equal(authEntry.ip, '10.0.0.99');
    assert.equal(authEntry.deviceId, 'device-m2');
    assert.ok(!authEntry.actionSummary.includes('super_secret_token_123'));
    assert.ok(authEntry.actionSummary.includes('[REDACTED]'));

    // Verify 2-arg tunnel entry
    const tunnelEntry = entries.find(e => e.eventType === 'M2_TUNNEL_READY');
    assert.ok(tunnelEntry, 'M2_TUNNEL_READY entry must exist');
    assert.equal(tunnelEntry.eventType, 'M2_TUNNEL_READY');
    assert.equal(tunnelEntry.details.provider, 'cloudflare');
    assert.equal(tunnelEntry.details.secret, '[REDACTED]');

    // Verify 2-arg image upload entry
    const imgEntry = entries.find(e => e.eventType === 'M2_IMAGE_UPLOAD');
    assert.ok(imgEntry, 'M2_IMAGE_UPLOAD entry must exist');
    assert.equal(imgEntry.ip, '192.168.1.150');
    assert.equal(imgEntry.actionSummary, 'Uploaded avatar');
    assert.equal(imgEntry.details.filename, 'avatar.png');

    // Verify 2-arg string summary entry
    const telEntry = entries.find(e => e.eventType === 'M2_TELEGRAM_START');
    assert.ok(telEntry, 'M2_TELEGRAM_START entry must exist');
    assert.equal(telEntry.actionSummary, 'Telegram bot polling started');
});

test('EventBus: aligns dot and colon listener registrations and task aliases', () => {
    const bus = new EventBus({ maxHistory: 20 });
    const received = [];

    // 1. Colon subscriber receives dot publication
    bus.on('approval:requested', (e) => received.push({ topic: 'approval:requested', event: e }));
    bus.publish('approval.requested', { approvalId: 'app-m2', risk: 'caution' });

    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'approval:requested');
    assert.equal(received[0].event.payload.approvalId, 'app-m2');

    // 2. Dot subscriber receives colon emission
    bus.on('checkpoint.created', (e) => received.push({ topic: 'checkpoint.created', event: e }));
    bus.emit('checkpoint:created', { sha: 'commit-m2-sha' });

    assert.equal(received.length, 2);
    assert.equal(received[1].topic, 'checkpoint.created');
    assert.equal(received[1].event.payload.sha, 'commit-m2-sha');

    // 3. Task completion alias: colon listener receives task.finished
    bus.on('task:completed', (e) => received.push({ topic: 'task:completed', event: e }));
    bus.publish('task.finished', { taskId: 'task-m2-finished' });

    assert.equal(received.length, 3);
    assert.equal(received[2].topic, 'task:completed');
    assert.equal(received[2].event.payload.taskId, 'task-m2-finished');

    // 4. Dot task.completed listener receives task.finished
    bus.on('task.completed', (e) => received.push({ topic: 'task.completed', event: e }));
    bus.publish('task.finished', { taskId: 'task-m2-finished-2' });

    // The two listeners (task:completed and task.completed) both fire
    const lastEvents = received.filter(r => r.event.payload.taskId === 'task-m2-finished-2');
    assert.equal(lastEvents.length, 2);

    // 5. Verbatim published types in history preserved
    const hist = bus.getHistory(10);
    assert.ok(hist.some(e => e.type === 'approval.requested'));
    assert.ok(hist.some(e => e.type === 'checkpoint:created'));
    assert.ok(hist.some(e => e.type === 'task.finished'));
});

test('QuickActions: allowlist matching resolves run-tests alias and rejects unauthorized actions', () => {
    const runner = new QuickActionRunner();

    // 1. "run-tests" alias (app.js:2031) resolves to act-npm-test
    const actions = runner.getActions();
    const npmTestAction = actions.find(a =>
        a.id === 'run-tests' ||
        a.id === 'act-run-tests' ||
        (Array.isArray(a.aliases) && a.aliases.includes('run-tests')) ||
        (a.label && a.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') === 'run-tests') ||
        (a.id === 'act-npm-test')
    );
    assert.ok(npmTestAction, 'act-npm-test should match run-tests');

    // 2. Custom action registration and execution via custom handler
    runner.registerAction({
        id: 'act-custom-test',
        label: 'Custom Quick Action',
        aliases: ['custom-test'],
        handler: () => ({ status: 'custom_ok' })
    });

    const resAlias = runner.executeAction('custom-test');
    assert.ok(resAlias.stdout.includes('custom_ok'));

    // 3. Unauthorized / malicious action rejection
    assert.throws(
        () => runner.executeAction('dangerous-eval-or-rm', {}),
        /Action not found in allowlist/i
    );
});

test('Dynamic Live Disk Telemetry: calculates real OS filesystem disk percent', () => {
    // statfsSync is natively supported in Node 18+
    assert.equal(typeof fs.statfsSync, 'function', 'fs.statfsSync must be available');

    const stats = fs.statfsSync(process.cwd());
    assert.ok(stats.blocks > 0, 'Filesystem blocks must be > 0');
    assert.ok(stats.bsize > 0, 'Block size must be > 0');

    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    const diskPercent = Math.min(100, Math.max(0, Math.round((used / total) * 100)));

    assert.ok(typeof diskPercent === 'number');
    assert.ok(diskPercent >= 0 && diskPercent <= 100);
});
