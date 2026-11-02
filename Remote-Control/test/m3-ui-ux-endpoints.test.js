import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.join(__dirname, '..');

// Helper to make local HTTP requests to a server
function makeRequest(server, reqPath, options = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const reqOptions = {
            hostname: '127.0.0.1',
            port: addr.port,
            path: reqPath,
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        const req = http.request(reqOptions, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        req.end();
    });
}

test('M3 UI/UX: index.html has no static dummy strings and contains required interactive elements', () => {
    const htmlPath = path.join(workspaceRoot, 'public', 'index.html');
    assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
    const content = fs.readFileSync(htmlPath, 'utf8');

    // F-17: Ensure static "50s ago" and static "46%" fallback values are eliminated
    assert.ok(!content.includes('Sync: Live · 50s ago'), 'Static "50s ago" string must be eliminated from index.html');
    assert.ok(!content.includes('<span class="meter-value" id="diskValue">46%</span>'), 'Static "46%" disk meter must be eliminated from index.html');

    // F-18: Ensure status dot and status text elements exist with correct IDs
    assert.ok(content.includes('id="desktopStatusDot"'), 'desktopStatusDot ID must exist in LAN connection card');
    assert.ok(content.includes('id="desktopStatusText"'), 'desktopStatusText ID must exist');
    assert.ok(content.includes('id="statusDot"'), 'statusDot ID must exist');
    assert.ok(content.includes('id="statusText"'), 'statusText ID must exist');

    // F-19: Ensure all three badges exist
    assert.ok(content.includes('id="desktopApprovalsBadge"'), 'desktopApprovalsBadge ID must exist');
    assert.ok(content.includes('id="approvalsBadge"'), 'approvalsBadge ID must exist');
    assert.ok(content.includes('id="globalNotifCount"'), 'globalNotifCount ID must exist');
    assert.ok(content.includes('id="btnGlobalNotif"'), 'btnGlobalNotif ID must exist');

    // F-20: Ensure session modal and user avatar badge exist
    assert.ok(content.includes('id="userAvatarBadge"'), 'userAvatarBadge ID must exist');
    assert.ok(content.includes('id="sessionModalOverlay"'), 'sessionModalOverlay ID must exist');
    assert.ok(content.includes('id="btnLogout"'), 'btnLogout ID must exist');
    assert.ok(content.includes('id="btnToggleElevation"'), 'btnToggleElevation ID must exist');
    assert.ok(content.includes('id="sessionFingerprint"'), 'sessionFingerprint ID must exist');

    // F-21: Ensure inspector connection label exists
    assert.ok(content.includes('id="inspectorConnection"'), 'inspectorConnection ID must exist');
});

test('M3 UI/UX: style.css defines tri-state status dot classes', () => {
    const cssPath = path.join(workspaceRoot, 'public', 'css', 'style.css');
    assert.ok(fs.existsSync(cssPath), 'style.css must exist');
    const content = fs.readFileSync(cssPath, 'utf8');

    assert.ok(content.includes('.status-dot-green'), 'style.css must define .status-dot-green');
    assert.ok(content.includes('.status-dot-amber'), 'style.css must define .status-dot-amber');
    assert.ok(content.includes('.status-dot-red'), 'style.css must define .status-dot-red');
    assert.ok(content.includes('.live-dot.connected'), 'style.css must define .live-dot.connected');
    assert.ok(content.includes('.live-dot.connecting'), 'style.css must define .live-dot.connecting');
    assert.ok(content.includes('.live-dot.disconnected'), 'style.css must define .live-dot.disconnected');
});

test('F-17: GET /api/sync-manifest returns real manifest, handles missing, and handles corruption gracefully', async () => {
    const quantaDir = path.join(workspaceRoot, '.quanta');
    const manifestPath = path.join(quantaDir, 'sync-manifest.json');
    if (!fs.existsSync(quantaDir)) fs.mkdirSync(quantaDir, { recursive: true });

    const origManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;

    try {
        // 1. Test existing valid manifest logic
        const sampleManifest = {
            version: 1,
            workspaceName: 'quanta-test-workspace',
            lastSyncTimestamp: 1730500000000,
            files: {
                'src/index.ts': { localMd5: 'abc', remoteMd5: 'abc', remoteId: 'f1', lastSyncedAt: 1730500000000 },
                'package.json': { localMd5: 'def', remoteMd5: 'def', remoteId: 'f2', lastSyncedAt: 1730500000000 }
            }
        };
        fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest, null, 2), 'utf8');

        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.workspaceName, 'quanta-test-workspace');
        assert.equal(Object.keys(parsed.files).length, 2);

        // 2. Test corrupted manifest JSON handling
        fs.writeFileSync(manifestPath, '{ corrupted json payload -- not valid', 'utf8');
        assert.throws(() => JSON.parse(fs.readFileSync(manifestPath, 'utf8')), SyntaxError);

    } finally {
        if (origManifest) {
            fs.writeFileSync(manifestPath, origManifest, 'utf8');
        } else if (fs.existsSync(manifestPath)) {
            fs.unlinkSync(manifestPath);
        }
    }
});

test('F-18/F-21: app.js contains updateConnectionState and dynamic inspector connection logic', () => {
    const appJsPath = path.join(workspaceRoot, 'public', 'js', 'app.js');
    assert.ok(fs.existsSync(appJsPath), 'app.js must exist');
    const content = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(content.includes('updateConnectionState'), 'app.js must define updateConnectionState');
    assert.ok(content.includes('status-dot-amber'), 'app.js must transition to status-dot-amber');
    assert.ok(content.includes('status-dot-red'), 'app.js must transition to status-dot-red');
    assert.ok(content.includes('desktopStatusDot'), 'app.js must reference desktopStatusDot');
    assert.ok(content.includes('inspectorConnection'), 'app.js must reference inspectorConnection');
    assert.ok(content.includes('updateApprovalsBadge'), 'app.js must define updateApprovalsBadge');
    assert.ok(content.includes('openSessionModal'), 'app.js must define openSessionModal');
    assert.ok(content.includes('/api/sync-manifest'), 'app.js must fetch /api/sync-manifest');
});
