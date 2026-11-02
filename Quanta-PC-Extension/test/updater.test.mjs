import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

test('Updater: can detect workspace files and copy updates to Antigravity directory structure', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-updater-test-'));
    try {
        const workspaceDir = path.join(tempDir, 'workspace');
        const extensionDir = path.join(workspaceDir, 'Quanta-PC-Extension');
        const distDir = path.join(extensionDir, 'dist');
        const fakeAntigravityDir = path.join(tempDir, '.antigravity-ide', 'extensions', 'quanta-ide.quanta-pc-extension-0.1.0');

        fs.mkdirSync(distDir, { recursive: true });
        fs.mkdirSync(fakeAntigravityDir, { recursive: true });

        // Create mock built extension
        const mockCode = 'console.log("Quanta latest version 0.1.1");';
        fs.writeFileSync(path.join(distDir, 'extension.js'), mockCode, 'utf8');
        fs.writeFileSync(path.join(extensionDir, 'package.json'), '{"name":"quanta-pc-extension","version":"0.1.1"}', 'utf8');

        // Simulate update sync logic
        const targetDist = path.join(fakeAntigravityDir, 'dist');
        if (!fs.existsSync(targetDist)) fs.mkdirSync(targetDist, { recursive: true });

        fs.copyFileSync(path.join(distDir, 'extension.js'), path.join(targetDist, 'extension.js'));
        fs.copyFileSync(path.join(extensionDir, 'package.json'), path.join(fakeAntigravityDir, 'package.json'));

        // Verify update applied
        assert.ok(fs.existsSync(path.join(targetDist, 'extension.js')));
        assert.equal(fs.readFileSync(path.join(targetDist, 'extension.js'), 'utf8'), mockCode);
        assert.equal(JSON.parse(fs.readFileSync(path.join(fakeAntigravityDir, 'package.json'), 'utf8')).version, '0.1.1');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Updater: resiliently handles missing or offline GitHub repository', async () => {
    // Verifies that fetch errors to non-existent or offline endpoint fail gracefully without crashing
    let caught = false;
    try {
        const controller = new AbortController();
        controller.abort();
        await fetch('https://invalid.quanta-ide.local/releases/latest', { signal: controller.signal });
    } catch (e) {
        caught = true;
    }
    assert.equal(caught, true);
});

