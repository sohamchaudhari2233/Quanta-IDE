#!/usr/bin/env node
import './core/environment.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { verifyCdpSecurity } from './security/cdpCheck.js';
import { validatePasswordSecurity } from './security/sessionManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runDoctor() {
    console.log('\n======================================================');
    console.log('🩺  QUANTA IDE SYSTEM DIAGNOSTIC & SECURITY DOCTOR');
    console.log('======================================================\n');

    let passed = 0;
    let warnings = 0;
    let failed = 0;

    function report(status, label, details = '') {
        const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : '❌';
        console.log(`${icon} [${status}] ${label}`);
        if (details) console.log(`       ${details}`);
        if (status === 'PASS') passed++;
        if (status === 'WARN') warnings++;
        if (status === 'FAIL') failed++;
    }

    // 1. Node.js Runtime Check
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor >= 18) {
        report('PASS', `Node.js Runtime: v${process.versions.node} (>= 18.x supported)`);
    } else {
        report('FAIL', `Node.js Runtime: v${process.versions.node}`, 'Node 18.0.0 or higher is required.');
    }

    // 2. Root & Local .env Presence
    const rootEnv = path.join(__dirname, '..', '.env');
    const localEnv = path.join(__dirname, '.env');
    if (fs.existsSync(rootEnv) || fs.existsSync(localEnv)) {
        report('PASS', 'Environment Configuration (.env found)');
    } else {
        report('WARN', 'Environment Configuration (.env missing)', 'Copy .env.example to .env and configure secrets.');
    }

    // 3. Password Security Audit
    const appPassword = process.env.APP_PASSWORD || 'antigravity';
    const pwdCheck = validatePasswordSecurity(appPassword, true);
    if (pwdCheck.valid) {
        report('PASS', 'APP_PASSWORD Strength: Strong & Non-default');
    } else {
        report('FAIL', 'APP_PASSWORD Insecure', `${pwdCheck.reason}. Do not use default or weak passwords.`);
    }

    // 4. CDP Loopback Security & External Exposure Probe
    try {
        const cdpAudit = await verifyCdpSecurity(9000);
        if (cdpAudit.secure) {
            report('PASS', 'CDP Binding Security: Loopback Only (Port 9000 not exposed to LAN)');
        } else {
            report('FAIL', 'CDP Binding Security: Port 9000 Exposed to External Network!',
                `Accessible on: ${cdpAudit.exposedIps.join(', ')}. Add --remote-debugging-address=127.0.0.1`);
        }
    } catch (e) {
        report('WARN', 'CDP Port Audit', 'Unable to probe port 9000: ' + e.message);
    }

    // An unexposed port may also mean the IDE is not listening at all.
    try {
        const response = await fetch('http://127.0.0.1:9000/json/version', { signal: AbortSignal.timeout(2000) });
        const info = await response.json();
        if (!response.ok || !info.webSocketDebuggerUrl) throw new Error('No debugger endpoint');
        report('PASS', 'CDP Bridge: Reachable on loopback');
    } catch {
        report('WARN', 'CDP Bridge: Not connected', 'Launch Antigravity with --remote-debugging-address=127.0.0.1 --remote-debugging-port=9000.');
    }

    // 5. Antigravity Brain Directory Discovery
    const brainPaths = [
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain')
    ];
    const foundBrain = brainPaths.find(p => fs.existsSync(p));
    if (foundBrain) {
        report('PASS', `Antigravity Brain Directory: ${foundBrain}`);
    } else {
        report('WARN', 'Antigravity Brain Directory not located', 'Transcripts sync will activate once Antigravity creates a conversation.');
    }

    // 6. OAuth Loopback Port Test
    await new Promise((resolve) => {
        const testServer = http.createServer();
        testServer.listen(0, '127.0.0.1', () => {
            const port = testServer.address().port;
            testServer.close(() => {
                report('PASS', `OAuth Ephemeral Loopback Port Allocation: Port ${port} successfully bound`);
                resolve();
            });
        });
        testServer.on('error', (err) => {
            report('FAIL', 'OAuth Loopback Port Allocation', err.message);
            resolve();
        });
    });

    // 7. Log Write Permissions
    const logDir = path.join(__dirname, 'logs');
    try {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const testFile = path.join(logDir, '.doctor_perm_test');
        fs.writeFileSync(testFile, 'test', 'utf8');
        fs.unlinkSync(testFile);
        report('PASS', 'Log Directory Permissions: Writable');
    } catch (e) {
        report('FAIL', 'Log Directory Permissions', `Cannot write to ${logDir}: ${e.message}`);
    }

    console.log('\n------------------------------------------------------');
    console.log(`SUMMARY: ${passed} Passed, ${warnings} Warnings, ${failed} Failed`);
    console.log('------------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runDoctor();
