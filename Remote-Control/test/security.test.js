import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RateLimiter, getClientIp } from '../security/rateLimiter.js';
import {
    timingSafeEqualString,
    validatePasswordSecurity,
    TotpEngine,
    SessionManager
} from '../security/sessionManager.js';
import { AuditLogger } from '../security/auditLogger.js';

test('RateLimiter: locks out IP after repeated failures', () => {
    const limiter = new RateLimiter({ maxAttempts: 3, lockoutDurationMs: 1000, windowMs: 2000 });
    const ip = '192.168.1.100';

    assert.equal(limiter.isLocked(ip), false);

    const f1 = limiter.recordFailure(ip);
    assert.equal(f1.locked, false);
    assert.equal(f1.attemptsRemaining, 2);

    const f2 = limiter.recordFailure(ip);
    assert.equal(f2.locked, false);
    assert.equal(f2.attemptsRemaining, 1);

    const f3 = limiter.recordFailure(ip);
    assert.equal(f3.locked, true);
    assert.equal(limiter.isLocked(ip), true);

    // After reset/success
    limiter.recordSuccess(ip);
    assert.equal(limiter.isLocked(ip), false);
});

test('Constant-Time Password Comparison and Strength Validation', () => {
    assert.equal(timingSafeEqualString('CorrectSecretPassword', 'CorrectSecretPassword'), true);
    assert.equal(timingSafeEqualString('CorrectSecretPassword', 'WrongPassword'), false);
    assert.equal(timingSafeEqualString('', 'anything'), false);

    // Reject weak & default passwords
    assert.equal(validatePasswordSecurity('antigravity', true).valid, false);
    assert.equal(validatePasswordSecurity('your-secure-password', true).valid, false);
    assert.equal(validatePasswordSecurity('short', true).valid, false);

    // Accept strong password
    assert.equal(validatePasswordSecurity('MySuperSecurePassword2026!', true).valid, true);
});

test('TOTP Engine: RFC 6238 token generation and verification', () => {
    const secret = TotpEngine.generateSecret(20);
    assert.ok(secret.length >= 16);

    const token = TotpEngine.generateToken(secret);
    assert.equal(token.length, 6);
    assert.ok(/^\d{6}$/.test(token));

    assert.equal(TotpEngine.verifyToken(token, secret), true);
    assert.equal(TotpEngine.verifyToken('000000', secret), false);
});

test('SessionManager: enforces read-only default for tunnels and handles elevation', () => {
    const sm = new SessionManager({
        absoluteLifetimeMs: 1000,
        idleTimeoutMs: 500,
        elevationTimeoutMs: 200
    });

    // 1. External/Tunnel session defaults to read-only
    const tunnelSession = sm.createSession({
        ip: '203.0.113.1',
        userAgent: 'Mozilla/5.0 Mobile',
        isLocal: false,
        isTunnel: true
    });

    assert.equal(tunnelSession.mode, 'read-only');

    // 2. Elevate session to control
    const elevated = sm.elevateSession(tunnelSession.id, 100);
    assert.equal(elevated, true);
    assert.equal(sm.getSession(tunnelSession.id).mode, 'control');

    // 3. Local session defaults to control
    const localSession = sm.createSession({
        ip: '127.0.0.1',
        userAgent: 'Desktop Browser',
        isLocal: true,
        isTunnel: false
    });
    assert.equal(localSession.mode, 'control');

    // 4. Logout / Destroy session
    sm.destroySession(tunnelSession.id);
    assert.equal(sm.getSession(tunnelSession.id), null);
});

test('AuditLogger: writes structured JSONL and redacts secrets', () => {
    const logger = new AuditLogger();
    logger.log({
        type: 'AUTH_TEST',
        ip: '10.0.0.5',
        deviceId: 'device-123',
        summary: 'User login with token=secret_token_123456 and AIzaSyD3x9qY4LzP1mK8jR2wN7vT5bX0aC9eF1g'
    });

    const entries = logger.getRecentEntries(5);
    const testEntry = entries.find(e => e.eventType === 'AUTH_TEST');

    assert.ok(testEntry, 'Audit log entry should exist');
    assert.ok(!testEntry.actionSummary.includes('secret_token_123456'));
    assert.ok(!testEntry.actionSummary.includes('AIzaSyD3x9qY4LzP1mK8jR2wN7vT5bX0aC9eF1g'));
    assert.ok(testEntry.actionSummary.includes('[REDACTED_SECRET]') || testEntry.actionSummary.includes('[REDACTED]'));
});

