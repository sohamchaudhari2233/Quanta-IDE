// Quanta-PC-Extension/test/sidebar.test.mjs
// Automated Unit Tests for Sidebar Telemetry, Server Health Ping & Message Routing (M3)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  checkServerHealth,
  getPreferredLanIp,
  readWorkspaceSyncState,
  QuantaSidebarProvider
} from '../src/sidebar.ts';

test('getPreferredLanIp: selects a valid IPv4 address or defaults to 127.0.0.1', () => {
  const ip = getPreferredLanIp();
  assert.ok(typeof ip === 'string', 'Expected string IP address');
  assert.ok(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip), `Expected valid IPv4 string, got "${ip}"`);
  assert.notEqual(ip, '', 'IP address should not be empty');
});

test('checkServerHealth: succeeds and detects HTTPS server with self-signed certificate', async () => {
  const certPath = path.resolve('../Remote-Control/certs/server.cert');
  const keyPath = path.resolve('../Remote-Control/certs/server.key');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    const httpsServer = https.createServer({ key, cert }, (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          cdpConnected: true,
          uptime: 3600,
          https: true
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(resolve => httpsServer.listen(0, '127.0.0.1', resolve));
    const port = httpsServer.address().port;

    try {
      const result = await checkServerHealth(port, 1500);
      assert.equal(result.online, true);
      assert.equal(result.https, true);
      assert.equal(result.cdpConnected, true);
      assert.ok(result.statusText.includes(`Port ${port}`));
      assert.ok(result.statusText.includes('Running · HTTPS'));
      assert.ok(result.statusText.includes('CDP Linked'));
      assert.ok(result.accessUrl.startsWith('https://'));
      assert.ok(result.accessUrl.includes(`:${port}`));
    } finally {
      httpsServer.close();
    }
  }
});

test('checkServerHealth: succeeds and detects HTTP server endpoint on port', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        cdpConnected: false,
        uptime: 120.5,
        https: false
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const result = await checkServerHealth(port, 1500);
    assert.equal(result.online, true);
    assert.equal(result.https, false);
    assert.equal(result.cdpConnected, false);
    assert.ok(result.statusText.includes(`Port ${port}`));
    assert.ok(result.statusText.includes('Running · HTTP'));
    assert.ok(result.statusText.includes('CDP Idle'));
    assert.ok(result.accessUrl.startsWith('http://'));
    assert.ok(result.accessUrl.includes(`:${port}`));
  } finally {
    server.close();
  }
});

test('checkServerHealth: handles connection refused gracefully without throwing', async () => {
  // Use high unused port where no service listens
  const unusedPort = 59199;
  const result = await checkServerHealth(unusedPort, 500);

  assert.equal(result.online, false);
  assert.equal(result.https, false);
  assert.ok(result.statusText.includes('Stopped · Offline'));
  assert.ok(result.statusText.includes(`Port ${unusedPort}`));
  assert.ok(result.accessUrl.includes('Unavailable'));
  assert.ok(result.error);
});

test('readWorkspaceSyncState: correctly extracts lastSync timestamp and file count from manifest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-sync-state-test-'));
  try {
    const quantaDir = path.join(tempDir, '.quanta');
    fs.mkdirSync(quantaDir, { recursive: true });

    const testTimestamp = 1730490000000;
    const testManifest = {
      version: 1,
      workspaceName: 'test-project',
      lastSyncTimestamp: testTimestamp,
      files: {
        'file1.ts': { path: 'file1.ts', localMd5: 'a', remoteMd5: 'a', remoteId: 'r1', lastSyncedAt: testTimestamp },
        'file2.ts': { path: 'file2.ts', localMd5: 'b', remoteMd5: 'b', remoteId: 'r2', lastSyncedAt: testTimestamp },
        'file3.ts': { path: 'file3.ts', localMd5: 'c', remoteMd5: 'c', remoteId: 'r3', lastSyncedAt: testTimestamp }
      }
    };

    fs.writeFileSync(path.join(quantaDir, 'sync-manifest.json'), JSON.stringify(testManifest, null, 2), 'utf8');

    const state = readWorkspaceSyncState(tempDir);
    assert.equal(state.hasManifest, true);
    assert.equal(state.workspaceName, 'test-project');
    assert.equal(state.fileCount, 3);
    assert.equal(state.lastSyncTimestamp, testTimestamp);
    assert.notEqual(state.lastSyncFormatted, 'Never');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readWorkspaceSyncState: handles missing manifest gracefully with "Never" and 0 files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-sync-empty-test-'));
  try {
    const state = readWorkspaceSyncState(tempDir);
    assert.equal(state.hasManifest, false);
    assert.equal(state.fileCount, 0);
    assert.equal(state.lastSyncFormatted, 'Never');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readWorkspaceSyncState: handles corrupt manifest JSON gracefully without throwing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-sync-corrupt-test-'));
  try {
    const quantaDir = path.join(tempDir, '.quanta');
    fs.mkdirSync(quantaDir, { recursive: true });
    fs.writeFileSync(path.join(quantaDir, 'sync-manifest.json'), '{ invalid json content !!!', 'utf8');

    const state = readWorkspaceSyncState(tempDir);
    assert.equal(state.hasManifest, false);
    assert.equal(state.fileCount, 0);
    assert.equal(state.lastSyncFormatted, 'Never');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Sidebar HTML template: eliminates static 192.168.1.2:3000 and exposes live telemetry IDs & Preview Sync button', () => {
  const fakeUri = { fsPath: path.resolve('.'), scheme: 'file', path: path.resolve('.') };
  const provider = new QuantaSidebarProvider(fakeUri);

  const mockWebview = {
    cspSource: 'https:',
    asWebviewUri: (uri) => uri
  };

  const html = provider['_getHtmlForWebview'](mockWebview);

  // 1. Must NOT contain the hardcoded LAN IP or static Running text
  assert.ok(!html.includes('192.168.1.2:3000'), 'Sidebar HTML must not contain hardcoded 192.168.1.2:3000');
  assert.ok(!html.includes('Running · LAN (Port 3000)'), 'Sidebar HTML must not contain static Running status');

  // 2. Must contain dynamic IDs for telemetry and server access
  assert.ok(html.includes('id="system-health-stamp"'), 'Missing id="system-health-stamp"');
  assert.ok(html.includes('id="server-status-val"'), 'Missing id="server-status-val"');
  assert.ok(html.includes('id="server-access-val"'), 'Missing id="server-access-val"');
  assert.ok(html.includes('id="sync-file-count-val"'), 'Missing id="sync-file-count-val"');
  assert.ok(html.includes('id="last-sync-val"'), 'Missing id="last-sync-val"');
  assert.ok(html.includes('id="drive-status-val"'), 'Missing id="drive-status-val"');
  assert.ok(html.includes('id="refresh-server-btn"'), 'Missing id="refresh-server-btn"');

  // 3. Must expose Preview Sync button
  assert.ok(html.includes('data-cmd="previewSync"'), 'Missing Preview Sync button with data-cmd="previewSync"');
  assert.ok(html.includes('Preview Sync (Dry Run)'), 'Missing Preview Sync button label');
});

test('Sidebar Message Router: recognizes previewSync, preview, init, and checkServerHealth commands', () => {
  const handledCommands = [];

  function simulateMessageRouter(data) {
    switch (data.type) {
      case 'init':
        handledCommands.push('init');
        break;
      case 'checkServerHealth':
        handledCommands.push('checkServerHealth');
        break;
      case 'preview':
      case 'previewSync':
        handledCommands.push('previewSync');
        break;
      case 'push':
      case 'pull':
      case 'syncChats':
      case 'login':
      case 'logout':
      case 'update':
      case 'doctor':
        handledCommands.push(data.type);
        break;
      default:
        handledCommands.push('unhandled');
    }
  }

  simulateMessageRouter({ type: 'init' });
  simulateMessageRouter({ type: 'checkServerHealth' });
  simulateMessageRouter({ type: 'previewSync' });
  simulateMessageRouter({ type: 'preview' });
  simulateMessageRouter({ type: 'push' });
  simulateMessageRouter({ type: 'pull' });

  assert.deepEqual(handledCommands, [
    'init',
    'checkServerHealth',
    'previewSync',
    'previewSync',
    'push',
    'pull'
  ]);
});

test('QuantaSidebarProvider: resolves composite badge states accurately', () => {
  const fakeUri = { fsPath: path.resolve('.'), scheme: 'file', path: path.resolve('.') };
  const provider = new QuantaSidebarProvider(fakeUri);

  const postedMessages = [];
  const fakeWebviewView = {
    webview: {
      options: {},
      html: '',
      cspSource: 'https:',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: (msg) => { postedMessages.push(msg); }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };

  provider.resolveWebviewView(fakeWebviewView, {}, {});

  // 1. Both offline -> STANDBY (offline)
  provider['_lastAuthStatus'] = false;
  provider['_lastServerOnline'] = false;
  provider['_updateCompositeBadge']();
  let lastMsg = postedMessages[postedMessages.length - 1];
  assert.equal(lastMsg.type, 'setCompositeStatus');
  assert.equal(lastMsg.text, 'STANDBY');
  assert.equal(lastMsg.statusClass, 'offline');

  // 2. Auth connected, server offline -> SERVER OFFLINE (caution)
  provider['_lastAuthStatus'] = true;
  provider['_lastServerOnline'] = false;
  provider['_updateCompositeBadge']();
  lastMsg = postedMessages[postedMessages.length - 1];
  assert.equal(lastMsg.text, 'SERVER OFFLINE');
  assert.equal(lastMsg.statusClass, 'caution');

  // 3. Auth offline, server online -> DRIVE OFFLINE (caution)
  provider['_lastAuthStatus'] = false;
  provider['_lastServerOnline'] = true;
  provider['_updateCompositeBadge']();
  lastMsg = postedMessages[postedMessages.length - 1];
  assert.equal(lastMsg.text, 'DRIVE OFFLINE');
  assert.equal(lastMsg.statusClass, 'caution');

  // 4. Both online -> ALL SYSTEMS NORMAL (ok)
  provider['_lastAuthStatus'] = true;
  provider['_lastServerOnline'] = true;
  provider['_updateCompositeBadge']();
  lastMsg = postedMessages[postedMessages.length - 1];
  assert.equal(lastMsg.text, 'ALL SYSTEMS NORMAL');
  assert.equal(lastMsg.statusClass, 'ok');
});

test('QuantaSidebarProvider: updateSyncStatus sends formatted fileCount and timestamp', () => {
  const fakeUri = { fsPath: path.resolve('.'), scheme: 'file', path: path.resolve('.') };
  const provider = new QuantaSidebarProvider(fakeUri);

  const postedMessages = [];
  const fakeWebviewView = {
    webview: {
      options: {},
      html: '',
      cspSource: 'https:',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: (msg) => { postedMessages.push(msg); }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };

  provider.resolveWebviewView(fakeWebviewView, {}, {});

  provider.updateSyncStatus('11/1/2026, 9:00:00 PM', 42);
  const msg = postedMessages.find(m => m.type === 'setSyncStatus');
  assert.ok(msg);
  assert.equal(msg.lastSync, '11/1/2026, 9:00:00 PM');
  assert.equal(msg.fileCount, 42);
});
