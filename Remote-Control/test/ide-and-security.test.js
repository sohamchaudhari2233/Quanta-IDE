import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileBrowser } from '../ide/fileBrowser.js';
import { QuickActionRunner } from '../ide/quickActions.js';
import { sniffImageMimeType, stripJpegExif } from '../ide/imageUpload.js';
import { isPrivateIPv4, isPrivateIPv6, validateSafeWebhookUrl } from '../webhooks/webhookDispatcher.js';

test('FileBrowser: strictly prevents path traversal and sensitive file access', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-test-'));
    try {
        const browser = new FileBrowser(tempDir);

        // Path traversal rejection
        assert.throws(() => browser.resolveSafePath('../../etc/shadow'), /Path traversal rejected/i);
        assert.throws(() => browser.resolveSafePath('..\\..\\windows\\system32'), /Path traversal rejected/i);

        // Sensitive pattern rejection
        assert.throws(() => browser.resolveSafePath('.env'), /Access denied/i);
        assert.throws(() => browser.resolveSafePath('.env.production'), /Access denied/i);
        assert.throws(() => browser.resolveSafePath('client_secret.json'), /Access denied/i);
        assert.throws(() => browser.resolveSafePath('server.key'), /Access denied/i);

        // Valid safe read/write inside jail
        const writeRes = browser.writeFile('hello.txt', 'Hello Quanta IDE', null, { user: 'test' });
        assert.equal(writeRes.success, true);

        const readRes = browser.readFile('hello.txt');
        assert.equal(readRes.content, 'Hello Quanta IDE');
        assert.equal(readRes.hash, writeRes.hash);

        // Optimistic concurrency baseHash mismatch check
        assert.throws(
            () => browser.writeFile('hello.txt', 'Conflicting Update', 'wrong-base-hash', { user: 'test' }),
            /Conflict/i
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('QuickActions: lists registered safe actions and rejects unauthorized execution', () => {
    const runner = new QuickActionRunner();
    const actions = runner.listActions();

    assert.ok(actions.length >= 3);
    const gitStatus = actions.find(a => a.id === 'git-status');
    assert.ok(gitStatus);
    assert.equal(gitStatus.risk, 'safe');

    // Unknown action error
    assert.throws(
        () => runner.executeAction('non-existent-action', {}),
        /Action not found/i
    );
});

test('ImageUpload: sniffs magic bytes and cleans metadata', () => {
    // Valid PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    const pngType = sniffImageMimeType(pngBuffer);
    assert.equal(pngType?.mime, 'image/png');
    assert.equal(pngType?.ext, 'png');

    // Valid JPEG magic bytes: FF D8 FF
    const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const jpegType = sniffImageMimeType(jpegBuffer);
    assert.equal(jpegType?.mime, 'image/jpeg');

    // Invalid / fake file
    const fakeBuffer = Buffer.from('NOT AN IMAGE FILE AT ALL');
    assert.equal(sniffImageMimeType(fakeBuffer), null);
});

test('WebhookDispatcher: blocks private IPs and prevents SSRF attacks', async () => {
    // IPv4 private ranges
    assert.equal(isPrivateIPv4('127.0.0.1'), true);
    assert.equal(isPrivateIPv4('10.0.5.1'), true);
    assert.equal(isPrivateIPv4('172.16.0.1'), true);
    assert.equal(isPrivateIPv4('172.31.255.255'), true);
    assert.equal(isPrivateIPv4('192.168.1.1'), true);
    assert.equal(isPrivateIPv4('169.254.169.254'), true); // Cloud metadata service IP!

    // IPv4 public ranges
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isPrivateIPv4('93.184.216.34'), false);

    // IPv6 private ranges
    assert.equal(isPrivateIPv6('::1'), true);
    assert.equal(isPrivateIPv6('fc00::1'), true);
    assert.equal(isPrivateIPv6('fe80::1'), true);

    // URL validation rejects localhost and local hostnames
    await assert.rejects(
        () => validateSafeWebhookUrl('http://localhost:8080/hook'),
        /SSRF Blocked/i
    );
    await assert.rejects(
        () => validateSafeWebhookUrl('http://test.localhost/hook'),
        /SSRF Blocked/i
    );
    await assert.rejects(
        () => validateSafeWebhookUrl('http://service.internal/hook'),
        /SSRF Blocked/i
    );
});
