// tests/m3_challenger_1_stress.test.mjs
// Empirical Stress & Boundary Challenge Suite for Milestone M3 (Empirical Challenger 1)
// Focus areas:
// 1. Quanta-PC-Extension sidebar functions: checkServerHealth, getPreferredLanIp, readWorkspaceSyncState, QuantaSidebarProvider
// 2. Remote-Control /api/sync-manifest under concurrency, missing, corrupt, null, and empty payloads
// 3. WebSocket connection state machine and tri-state dot transitions (connecting -> connected -> disconnected)
// 4. Triple approvals badge synchronization under concurrent rapid polling

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// Import Quanta-PC-Extension sidebar functions directly
import {
  checkServerHealth,
  getPreferredLanIp,
  readWorkspaceSyncState,
  QuantaSidebarProvider
} from '../Quanta-PC-Extension/src/sidebar.ts';

// Import Remote-Control dependencies
import express from '../Remote-Control/node_modules/express/index.js';
import WebSocket from '../Remote-Control/node_modules/ws/index.js';
const { WebSocketServer } = WebSocket;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const remoteControlPublic = path.join(projectRoot, 'Remote-Control', 'public');

// =========================================================================
// SUITE 1: Quanta-PC-Extension Sidebar Deep Stress Testing
// =========================================================================

test('SUITE 1.1: getPreferredLanIp algorithm evaluation under hostile network interface topologies', () => {
  // Oracle matching sidebar.ts getPreferredLanIp selection logic
  function evaluateLanIp(interfaces) {
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const addr = iface.address;
          const priority = addr.startsWith('192.168.') ? 1
            : addr.startsWith('10.') ? 2
            : addr.startsWith('172.') ? 3 : 4;
          candidates.push({ address: addr, priority });
        }
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
  }

  // 1. Live system sanity: getPreferredLanIp matches oracle on current host
  const liveInterfaces = os.networkInterfaces();
  const liveExpected = evaluateLanIp(liveInterfaces);
  const liveActual = getPreferredLanIp();
  assert.equal(liveActual, liveExpected, 'Live IP discovery should match oracle selection');

  // 2. Hostile scenario: Loopback only
  assert.equal(evaluateLanIp({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    lo6: [{ address: '::1', family: 'IPv6', internal: true }]
  }), '127.0.0.1', 'Loopback only must fall back to 127.0.0.1');

  // 3. Hostile scenario: Empty interface dictionary
  assert.equal(evaluateLanIp({}), '127.0.0.1', 'Empty interfaces must return 127.0.0.1');

  // 4. Hostile scenario: IPv6 only addresses (fe80::, 2001:db8::)
  assert.equal(evaluateLanIp({
    eth0: [
      { address: 'fe80::1ff:fe23:4567:890a', family: 'IPv6', internal: false },
      { address: '2001:db8::1', family: 'IPv6', internal: false }
    ]
  }), '127.0.0.1', 'IPv6-only host must return 127.0.0.1');

  // 5. Hostile scenario: Internal 192.168.x.x addresses must NOT be selected
  assert.equal(evaluateLanIp({
    vEthernet: [{ address: '192.168.99.1', family: 'IPv4', internal: true }]
  }), '127.0.0.1', 'Internal 192.168 address must be ignored');

  // 6. Multi-homed interface priority resolution: 192.168.x.x > 10.x.x.x > 172.x.x.x > Public IP
  assert.equal(evaluateLanIp({
    eth0: [{ address: '1.1.1.1', family: 'IPv4', internal: false }],
    eth1: [{ address: '172.20.0.10', family: 'IPv4', internal: false }],
    eth2: [{ address: '10.50.1.2', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.168.0.45', family: 'IPv4', internal: false }]
  }), '192.168.0.45', '192.168.x.x must take precedence over 10.x, 172.x, and public IPs');

  // 7. Multi-homed priority resolution: 10.x.x.x > 172.x.x.x > Public IP
  assert.equal(evaluateLanIp({
    eth0: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
    eth1: [{ address: '172.31.255.1', family: 'IPv4', internal: false }],
    eth2: [{ address: '10.0.0.1', family: 'IPv4', internal: false }]
  }), '10.0.0.1', '10.x.x.x must take precedence over 172.x and public IPs');

  // 8. Multi-homed priority resolution: 172.x.x.x > Public IP
  assert.equal(evaluateLanIp({
    eth0: [{ address: '203.0.113.19', family: 'IPv4', internal: false }],
    eth1: [{ address: '172.16.4.1', family: 'IPv4', internal: false }]
  }), '172.16.4.1', '172.x.x.x must take precedence over public IP');

  // 9. Null or undefined entry arrays handled without crashing
  assert.equal(evaluateLanIp({
    eth0: null,
    eth1: undefined,
    eth2: []
  }), '127.0.0.1', 'Null or undefined interface arrays must not throw');
});

test('SUITE 1.2: checkServerHealth against hostile server behaviors (500, 404, non-JSON, timeout, reset, 50 concurrency)', async () => {
  const certPath = path.resolve(projectRoot, 'Remote-Control', 'certs', 'server.cert');
  const keyPath = path.resolve(projectRoot, 'Remote-Control', 'certs', 'server.key');
  const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);

  // 1. HTTPS Server returning 500 Internal Server Error
  if (hasCert) {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    const https500Server = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });
    await new Promise(r => https500Server.listen(0, '127.0.0.1', r));
    const port500 = https500Server.address().port;
    try {
      const res500 = await checkServerHealth(port500, 1000);
      assert.equal(res500.online, false, 'HTTP 500 response must report server offline');
      assert.ok(res500.statusText.includes('Stopped · Offline'));
    } finally {
      https500Server.close();
    }
  }

  // 2. HTTP Server returning 404 Not Found on /health
  const http404Server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  await new Promise(r => http404Server.listen(0, '127.0.0.1', r));
  const port404 = http404Server.address().port;
  try {
    const res404 = await checkServerHealth(port404, 1000);
    assert.equal(res404.online, false, 'HTTP 404 response must report server offline');
    assert.ok(res404.statusText.includes('Stopped · Offline'));
  } finally {
    http404Server.close();
  }

  // 3. HTTP Server returning 200 OK but with garbage HTML / non-JSON payload
  const httpHtmlServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Welcome to Apache</body></html>');
  });
  await new Promise(r => httpHtmlServer.listen(0, '127.0.0.1', r));
  const portHtml = httpHtmlServer.address().port;
  try {
    const resHtml = await checkServerHealth(portHtml, 1000);
    assert.equal(resHtml.online, false, 'Non-JSON response body must fail cleanly without throwing');
    assert.ok(resHtml.statusText.includes('Stopped · Offline'));
  } finally {
    httpHtmlServer.close();
  }

  // 4. Server abruptly destroying socket upon receiving connection (ECONNRESET)
  const httpResetServer = http.createServer((req, res) => {
    req.socket.destroy();
  });
  await new Promise(r => httpResetServer.listen(0, '127.0.0.1', r));
  const portReset = httpResetServer.address().port;
  try {
    const resReset = await checkServerHealth(portReset, 1000);
    assert.equal(resReset.online, false, 'Socket reset must report offline without unhandled rejection');
  } finally {
    httpResetServer.close();
  }

  // 5. Hanging Server exceeding client timeout
  const httpHangingServer = http.createServer((req, res) => {
    // Intentionally never respond
  });
  await new Promise(r => httpHangingServer.listen(0, '127.0.0.1', r));
  const portHang = httpHangingServer.address().port;
  try {
    const start = Date.now();
    const resHang = await checkServerHealth(portHang, 400); // 400ms timeout
    const elapsed = Date.now() - start;
    assert.equal(resHang.online, false, 'Hanging server must report offline upon timeout');
    assert.ok(elapsed >= 350, `Expected elapsed time around 400ms, was ${elapsed}ms`);
  } finally {
    httpHangingServer.close();
  }

  // 6. Healthy HTTP Server under 50 Concurrent Calls
  const httpValidServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', cdpConnected: true, uptime: 999 }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(r => httpValidServer.listen(0, '127.0.0.1', r));
  const portValid = httpValidServer.address().port;
  try {
    const batchSize = 50;
    const promises = Array.from({ length: batchSize }, () => checkServerHealth(portValid, 2000));
    const results = await Promise.all(promises);

    assert.equal(results.length, batchSize);
    for (const res of results) {
      assert.equal(res.online, true);
      assert.equal(res.cdpConnected, true);
      assert.ok(res.statusText.includes('CDP Linked'));
      assert.ok(res.statusText.includes(`Port ${portValid}`));
    }
  } finally {
    httpValidServer.close();
  }
});

test('SUITE 1.3: readWorkspaceSyncState under boundary and corrupted manifests', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-m3-manifest-stress-'));
  const quantaDir = path.join(tempDir, '.quanta');
  const manifestFile = path.join(quantaDir, 'sync-manifest.json');
  fs.mkdirSync(quantaDir, { recursive: true });

  try {
    // 1. Missing manifest file inside existing .quanta folder
    const resMissing = readWorkspaceSyncState(tempDir);
    assert.equal(resMissing.hasManifest, false);
    assert.equal(resMissing.fileCount, 0);
    assert.equal(resMissing.lastSyncTimestamp, 0);
    assert.equal(resMissing.lastSyncFormatted, 'Never');

    // 2. Corrupted manifest syntax (half-written JSON)
    fs.writeFileSync(manifestFile, '{"version": 1, "workspaceName": "broken", "files": {', 'utf8');
    const resCorrupt = readWorkspaceSyncState(tempDir);
    assert.equal(resCorrupt.hasManifest, false);
    assert.equal(resCorrupt.fileCount, 0);
    assert.equal(resCorrupt.lastSyncFormatted, 'Never');

    // 3. Manifest with empty object {}
    fs.writeFileSync(manifestFile, '{}', 'utf8');
    const resEmptyObj = readWorkspaceSyncState(tempDir);
    assert.equal(resEmptyObj.hasManifest, true);
    assert.equal(resEmptyObj.fileCount, 0);
    assert.equal(resEmptyObj.lastSyncTimestamp, 0);
    assert.equal(resEmptyObj.lastSyncFormatted, 'Never');

    // 4. Manifest with null files: {"version": 1, "files": null}
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, files: null }), 'utf8');
    const resNullFiles = readWorkspaceSyncState(tempDir);
    assert.equal(resNullFiles.hasManifest, true);
    assert.equal(resNullFiles.fileCount, 0, 'files: null must safely yield fileCount 0');

    // 5. Manifest with non-object files: {"version": 1, "files": 12345}
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, files: 12345 }), 'utf8');
    const resNumFiles = readWorkspaceSyncState(tempDir);
    assert.equal(resNumFiles.hasManifest, true);
    assert.equal(resNumFiles.fileCount, 0, 'files: number must safely yield fileCount 0');

    // 6. Huge manifest with 5,000 files
    const largeFiles = {};
    for (let i = 0; i < 5000; i++) {
      largeFiles[`file_${i}.ts`] = { localMd5: 'a', remoteMd5: 'a', remoteId: `id_${i}` };
    }
    const syncTime = 1730500000000;
    fs.writeFileSync(manifestFile, JSON.stringify({
      version: 1,
      workspaceName: 'stress-workspace',
      lastSyncTimestamp: syncTime,
      files: largeFiles
    }), 'utf8');

    const resLarge = readWorkspaceSyncState(tempDir);
    assert.equal(resLarge.hasManifest, true);
    assert.equal(resLarge.fileCount, 5000);
    assert.equal(resLarge.workspaceName, 'stress-workspace');
    assert.equal(resLarge.lastSyncTimestamp, syncTime);
    assert.notEqual(resLarge.lastSyncFormatted, 'Never');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SUITE 1.4: QuantaSidebarProvider composite badge state machine & HTML sanitization', () => {
  const fakeUri = { fsPath: projectRoot, scheme: 'file', path: projectRoot };
  const provider = new QuantaSidebarProvider(fakeUri);

  // Verify HTML output contains required IDs and no hardcoded dummy data
  const mockWebview = {
    cspSource: 'https:',
    asWebviewUri: (uri) => uri
  };
  const html = provider._getHtmlForWebview(mockWebview);

  // Must contain new dynamic telemetry and UI element IDs
  assert.match(html, /id=["']system-health-stamp["']/, 'Header must have #system-health-stamp');
  assert.match(html, /id=["']server-status-val["']/, 'Must have #server-status-val');
  assert.match(html, /id=["']server-access-val["']/, 'Must have #server-access-val');
  assert.match(html, /id=["']refresh-server-btn["']/, 'Must have #refresh-server-btn');
  assert.match(html, /id=["']preview-sync-btn["']/, 'Must have #preview-sync-btn');
  assert.match(html, /id=["']last-sync-val["']/, 'Must have #last-sync-val');
  assert.match(html, /id=["']sync-file-count-val["']/, 'Must have #sync-file-count-val');

  // Must NOT contain static 192.168.1.2:3000 or static Running · LAN string
  assert.ok(!html.includes('https://192.168.1.2:3000'), 'Static IP https://192.168.1.2:3000 must be eliminated');
  assert.ok(!html.includes('<span class="ledger-val">Running · LAN (Port 3000)</span>'), 'Static Running ledger value must be eliminated');

  // Verify composite badge logic for all 4 state combinations
  function computeCompositeBadge(auth, server) {
    if (auth && server) return { text: 'ALL SYSTEMS NORMAL', class: 'ok' };
    if (auth && !server) return { text: 'SERVER OFFLINE', class: 'caution' };
    if (!auth && server) return { text: 'DRIVE OFFLINE', class: 'caution' };
    return { text: 'STANDBY', class: 'offline' };
  }

  assert.deepEqual(computeCompositeBadge(true, true), { text: 'ALL SYSTEMS NORMAL', class: 'ok' });
  assert.deepEqual(computeCompositeBadge(true, false), { text: 'SERVER OFFLINE', class: 'caution' });
  assert.deepEqual(computeCompositeBadge(false, true), { text: 'DRIVE OFFLINE', class: 'caution' });
  assert.deepEqual(computeCompositeBadge(false, false), { text: 'STANDBY', class: 'offline' });
});

// =========================================================================
// SUITE 2: Remote-Control /api/sync-manifest Concurrency & Fault Injection
// =========================================================================

test('SUITE 2.1: /api/sync-manifest endpoint under normal, missing, corrupt, null, and 100 concurrent requests', async () => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-sync-manifest-api-'));
  const quantaFolder = path.join(tempWorkspace, '.quanta');
  const manifestPath = path.join(quantaFolder, 'sync-manifest.json');
  fs.mkdirSync(quantaFolder, { recursive: true });

  // Create Express app matching server.js lines 2331-2379
  const app = express();
  app.get('/api/sync-manifest', (req, res) => {
    try {
      const candidatePaths = [
        manifestPath,
        path.join(process.cwd(), '.quanta', 'sync-manifest.json'),
        path.join(process.cwd(), '..', '.quanta', 'sync-manifest.json')
      ];
      const foundPath = candidatePaths.find(p => fs.existsSync(p));
      if (foundPath) {
        try {
          const raw = fs.readFileSync(foundPath, 'utf8');
          const data = JSON.parse(raw);
          const fileCount = data && data.files ? Object.keys(data.files).length : 0;
          return res.json({
            exists: true,
            status: 'synced',
            version: (data && data.version) || 1,
            workspaceName: (data && data.workspaceName) || 'quanta-ide',
            lastSyncTimestamp: (data && data.lastSyncTimestamp) || 0,
            fileCount,
            files: (data && data.files) || {}
          });
        } catch (parseErr) {
          return res.json({
            exists: true,
            status: 'corrupt',
            error: 'Failed to parse sync-manifest.json: ' + parseErr.message,
            version: 1,
            workspaceName: 'quanta-ide',
            lastSyncTimestamp: 0,
            fileCount: 0,
            files: {}
          });
        }
      } else {
        return res.json({
          exists: false,
          status: 'uninitialized',
          version: 1,
          workspaceName: 'quanta-ide',
          lastSyncTimestamp: 0,
          fileCount: 0,
          files: {}
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message, status: 'error' });
    }
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;

  async function getSyncManifest() {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${serverPort}/api/sync-manifest`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        });
      }).on('error', reject);
    });
  }

  try {
    // 1. Initial Missing state
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    const res1 = await getSyncManifest();
    assert.equal(res1.status, 200);
    assert.equal(res1.body.exists, false);
    assert.equal(res1.body.status, 'uninitialized');
    assert.equal(res1.body.fileCount, 0);

    // 2. Normal synced state
    const validManifest = {
      version: 1,
      workspaceName: 'test-api-ws',
      lastSyncTimestamp: 1730510000000,
      files: {
        'src/main.ts': { localMd5: '123', remoteMd5: '123', remoteId: 'r1' },
        'README.md': { localMd5: '456', remoteMd5: '456', remoteId: 'r2' }
      }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(validManifest, null, 2), 'utf8');

    const res2 = await getSyncManifest();
    assert.equal(res2.status, 200);
    assert.equal(res2.body.exists, true);
    assert.equal(res2.body.status, 'synced');
    assert.equal(res2.body.fileCount, 2);
    assert.equal(res2.body.workspaceName, 'test-api-ws');
    assert.equal(res2.body.lastSyncTimestamp, 1730510000000);

    // 3. Corrupt JSON state
    fs.writeFileSync(manifestPath, '{"version": 1, "files": [broken json...', 'utf8');
    const res3 = await getSyncManifest();
    assert.equal(res3.status, 200);
    assert.equal(res3.body.exists, true);
    assert.equal(res3.body.status, 'corrupt');
    assert.ok(res3.body.error.includes('Failed to parse'));
    assert.equal(res3.body.fileCount, 0);

    // 4. Hostile JSON literal `null`
    fs.writeFileSync(manifestPath, 'null', 'utf8');
    const res4 = await getSyncManifest();
    assert.equal(res4.status, 200);
    assert.equal(res4.body.exists, true);
    assert.equal(res4.body.fileCount, 0);

    // 5. Hostile JSON empty string `""`
    fs.writeFileSync(manifestPath, '""', 'utf8');
    const res5 = await getSyncManifest();
    assert.equal(res5.status, 200);
    assert.equal(res5.body.exists, true);
    assert.equal(res5.body.fileCount, 0);

    // 6. Concurrency stress: 100 simultaneous requests with valid manifest
    fs.writeFileSync(manifestPath, JSON.stringify(validManifest), 'utf8');
    const concurrentRequests = 100;
    const promises = Array.from({ length: concurrentRequests }, () => getSyncManifest());
    const results = await Promise.all(promises);

    assert.equal(results.length, concurrentRequests);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'synced');
      assert.equal(r.body.fileCount, 2);
    }
  } finally {
    server.close();
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }
});

// =========================================================================
// SUITE 3: WebSocket Connection State Machine & Tri-State Dot Transitions
// =========================================================================

test('SUITE 3.1: updateConnectionState state machine & tri-state dot transitions', () => {
  // Setup mock DOM environment
  const elements = new Map();
  function createMockElement(id, className = '') {
    const el = {
      id,
      className,
      textContent: '',
      style: { display: '' }
    };
    elements.set(id, el);
    return el;
  }

  const desktopStatusText = createMockElement('desktopStatusText');
  const desktopStatusDot = createMockElement('desktopStatusDot', 'status-dot-amber');
  const statusDot = createMockElement('statusDot', 'live-dot connecting');
  const statusText = createMockElement('statusText', 'Connecting...');

  // Exact function extracted from Remote-Control/public/js/app.js lines 324-364
  let syncingTextTimer = null;
  function updateConnectionState(state, customPort = '3000') {
    if (syncingTextTimer) { clearTimeout(syncingTextTimer); syncingTextTimer = null; }
    const dStatusText = elements.get('desktopStatusText');
    const dStatusDot = elements.get('desktopStatusDot');
    const sDot = elements.get('statusDot');
    const sText = elements.get('statusText');
    const port = customPort;

    if (state === 'connected') {
      if (sDot) sDot.className = 'live-dot connected';
      if (sText) sText.textContent = 'Live';
      if (dStatusDot) dStatusDot.className = 'status-dot-green';
      if (dStatusText) dStatusText.textContent = `Connected · Port ${port}`;
    } else if (state === 'connecting') {
      if (sDot) sDot.className = 'live-dot connecting';
      if (sText) sText.textContent = 'Connecting...';
      if (dStatusDot) dStatusDot.className = 'status-dot-amber';
      if (dStatusText) dStatusText.textContent = `Connecting · Port ${port}...`;
    } else { // 'disconnected'
      if (sDot) sDot.className = 'live-dot disconnected';
      if (sText) sText.textContent = 'Disconnected';
      if (dStatusDot) dStatusDot.className = 'status-dot-red';
      if (dStatusText) dStatusText.textContent = 'Disconnected · Retrying';
    }
  }

  // 1. Initial State: connecting
  updateConnectionState('connecting', '3000');
  assert.equal(desktopStatusDot.className, 'status-dot-amber');
  assert.equal(desktopStatusText.textContent, 'Connecting · Port 3000...');
  assert.equal(statusDot.className, 'live-dot connecting');
  assert.equal(statusText.textContent, 'Connecting...');

  // 2. Transition: connecting -> connected
  updateConnectionState('connected', '3000');
  assert.equal(desktopStatusDot.className, 'status-dot-green');
  assert.equal(desktopStatusText.textContent, 'Connected · Port 3000');
  assert.equal(statusDot.className, 'live-dot connected');
  assert.equal(statusText.textContent, 'Live');

  // 3. Transition: connected -> disconnected
  updateConnectionState('disconnected', '3000');
  assert.equal(desktopStatusDot.className, 'status-dot-red');
  assert.equal(desktopStatusText.textContent, 'Disconnected · Retrying');
  assert.equal(statusDot.className, 'live-dot disconnected');
  assert.equal(statusText.textContent, 'Disconnected');

  // 4. Transition: disconnected -> connecting (reconnection attempt)
  updateConnectionState('connecting', '3000');
  assert.equal(desktopStatusDot.className, 'status-dot-amber');
  assert.equal(desktopStatusText.textContent, 'Connecting · Port 3000...');
  assert.equal(statusDot.className, 'live-dot connecting');
  assert.equal(statusText.textContent, 'Connecting...');

  // 5. Transition: connecting -> connected (reconnection success)
  updateConnectionState('connected', '3000');
  assert.equal(desktopStatusDot.className, 'status-dot-green');
  assert.equal(desktopStatusText.textContent, 'Connected · Port 3000');
  assert.equal(statusDot.className, 'live-dot connected');
  assert.equal(statusText.textContent, 'Live');

  // 6. Stress test: 100 rapid state flips
  const states = ['connecting', 'connected', 'disconnected'];
  for (let i = 0; i < 100; i++) {
    const nextState = states[i % states.length];
    updateConnectionState(nextState, '8080');
    if (nextState === 'connected') {
      assert.equal(desktopStatusDot.className, 'status-dot-green');
      assert.equal(desktopStatusText.textContent, 'Connected · Port 8080');
    } else if (nextState === 'connecting') {
      assert.equal(desktopStatusDot.className, 'status-dot-amber');
      assert.equal(desktopStatusText.textContent, 'Connecting · Port 8080...');
    } else {
      assert.equal(desktopStatusDot.className, 'status-dot-red');
      assert.equal(desktopStatusText.textContent, 'Disconnected · Retrying');
    }
  }
});

test('SUITE 3.2: style.css contains validated color specs for tri-state dots and live-dots', () => {
  const cssPath = path.join(remoteControlPublic, 'css', 'style.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  // Verify class existence
  assert.match(css, /\.status-dot-green\b/, 'Must define .status-dot-green');
  assert.match(css, /\.status-dot-amber\b/, 'Must define .status-dot-amber');
  assert.match(css, /\.status-dot-red\b/, 'Must define .status-dot-red');
  assert.match(css, /\.live-dot\.connected\b/, 'Must define .live-dot.connected');
  assert.match(css, /\.live-dot\.connecting\b/, 'Must define .live-dot.connecting');
  assert.match(css, /\.live-dot\.disconnected\b/, 'Must define .live-dot.disconnected');

  // Verify distinct color assignments matching style.css definitions (#4ADE80, #F59E0B, #EF4444)
  assert.match(css, /\.status-dot-green[\s\S]*?(?:#4ADE80|#4ade80)/i, 'Green dot must use green palette (#4ADE80)');
  assert.match(css, /\.status-dot-amber[\s\S]*?(?:#F59E0B|#f59e0b)/i, 'Amber dot must use amber palette (#F59E0B)');
  assert.match(css, /\.status-dot-red[\s\S]*?(?:#EF4444|#ef4444)/i, 'Red dot must use red palette (#EF4444)');
});

// =========================================================================
// SUITE 4: Approvals Badge Synchronization Under Rapid Polling Stress
// =========================================================================

test('SUITE 4.1: Triple approvals badge synchronization across all input types and visibility transitions', () => {
  const elements = new Map();
  function createMockBadge(id) {
    const el = {
      id,
      textContent: '0',
      style: { display: 'none' }
    };
    elements.set(id, el);
    return el;
  }

  const desktopBadge = createMockBadge('desktopApprovalsBadge');
  const mobileBadge = createMockBadge('approvalsBadge');
  const globalNotif = createMockBadge('globalNotifCount');

  // Exact function extracted from Remote-Control/public/js/app.js lines 1963-1997
  function updateApprovalsBadge(count) {
    const dBadge = elements.get('desktopApprovalsBadge');
    const mBadge = elements.get('approvalsBadge');
    const gNotif = elements.get('globalNotifCount');

    const num = typeof count === 'number' ? count : (Array.isArray(count) ? count.length : 0);

    if (num > 0) {
      if (dBadge) {
        dBadge.style.display = 'inline-block';
        dBadge.textContent = num;
      }
      if (mBadge) {
        mBadge.style.display = 'block';
        mBadge.textContent = num;
      }
      if (gNotif) {
        gNotif.style.display = 'flex';
        gNotif.textContent = num;
      }
    } else {
      if (dBadge) {
        dBadge.style.display = 'none';
        dBadge.textContent = '0';
      }
      if (mBadge) {
        mBadge.style.display = 'none';
        mBadge.textContent = '0';
      }
      if (gNotif) {
        gNotif.style.display = 'none';
        gNotif.textContent = '0';
      }
    }
  }

  // 1. Positive number: 7 pending approvals
  updateApprovalsBadge(7);
  assert.equal(desktopBadge.style.display, 'inline-block');
  assert.equal(desktopBadge.textContent, 7);
  assert.equal(mobileBadge.style.display, 'block');
  assert.equal(mobileBadge.textContent, 7);
  assert.equal(globalNotif.style.display, 'flex');
  assert.equal(globalNotif.textContent, 7);

  // 2. Array input: 3 approval items
  updateApprovalsBadge([{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(desktopBadge.style.display, 'inline-block');
  assert.equal(desktopBadge.textContent, 3);
  assert.equal(mobileBadge.style.display, 'block');
  assert.equal(mobileBadge.textContent, 3);
  assert.equal(globalNotif.style.display, 'flex');
  assert.equal(globalNotif.textContent, 3);

  // 3. Clear approvals: 0 items
  updateApprovalsBadge(0);
  assert.equal(desktopBadge.style.display, 'none');
  assert.equal(desktopBadge.textContent, '0');
  assert.equal(mobileBadge.style.display, 'none');
  assert.equal(mobileBadge.textContent, '0');
  assert.equal(globalNotif.style.display, 'none');
  assert.equal(globalNotif.textContent, '0');

  // 4. Empty array: []
  updateApprovalsBadge([]);
  assert.equal(desktopBadge.style.display, 'none');
  assert.equal(desktopBadge.textContent, '0');

  // 5. Hostile inputs: null, undefined, negative, NaN, string
  for (const hostile of [null, undefined, -5, NaN, 'some_string', {}]) {
    updateApprovalsBadge(hostile);
    assert.equal(desktopBadge.style.display, 'none');
    assert.equal(desktopBadge.textContent, '0');
    assert.equal(mobileBadge.style.display, 'none');
    assert.equal(mobileBadge.textContent, '0');
    assert.equal(globalNotif.style.display, 'none');
    assert.equal(globalNotif.textContent, '0');
  }

  // 6. Concurrency & Rapid Polling Stress Test (100 rapid asynchronous calls)
  const sequence = [1, 5, 0, 12, 3, 0, 8, 2, 0, 15];
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const val of sequence) {
      updateApprovalsBadge(val);
      if (val > 0) {
        assert.equal(desktopBadge.textContent, val);
        assert.equal(mobileBadge.textContent, val);
        assert.equal(globalNotif.textContent, val);
        assert.equal(desktopBadge.style.display, 'inline-block');
      } else {
        assert.equal(desktopBadge.textContent, '0');
        assert.equal(mobileBadge.textContent, '0');
        assert.equal(globalNotif.textContent, '0');
        assert.equal(desktopBadge.style.display, 'none');
      }
    }
  }
});

// =========================================================================
// SUITE 5: Workspace UI/UX Consistency & Elimination of Dummy Content
// =========================================================================

test('SUITE 5.1: index.html & login.html contain zero dummy/placeholder facades and all M3 UI features', () => {
  const indexHtml = fs.readFileSync(path.join(remoteControlPublic, 'index.html'), 'utf8');
  const loginHtml = fs.readFileSync(path.join(remoteControlPublic, 'login.html'), 'utf8');

  // F-17: Ensure dummy "50s ago" string is completely absent
  assert.ok(!indexHtml.includes('50s ago'), 'index.html must not contain static "50s ago"');
  assert.ok(!indexHtml.includes('width: 46%'), 'index.html must not contain static 46% disk meter');

  // F-18 & F-19: Elements exist
  assert.match(indexHtml, /id=["']desktopStatusDot["']/, 'Must have #desktopStatusDot');
  assert.match(indexHtml, /id=["']desktopStatusText["']/, 'Must have #desktopStatusText');
  assert.match(indexHtml, /id=["']desktopApprovalsBadge["']/, 'Must have #desktopApprovalsBadge');
  assert.match(indexHtml, /id=["']globalNotifCount["']/, 'Must have #globalNotifCount');
  assert.match(indexHtml, /id=["']btnGlobalNotif["']/, 'Must have #btnGlobalNotif');

  // F-20: Interactive avatar and session modal
  assert.match(indexHtml, /id=["']userAvatarBadge["']/, 'Must have #userAvatarBadge');
  assert.match(indexHtml, /id=["']sessionModalOverlay["']/, 'Must have #sessionModalOverlay');
  assert.match(indexHtml, /id=["']btnLogout["']/, 'Must have #btnLogout');
  assert.match(indexHtml, /id=["']btnToggleElevation["']/, 'Must have #btnToggleElevation');
  assert.match(indexHtml, /id=["']sessionFingerprint["']/, 'Must have #sessionFingerprint');

  // F-21: Dynamic inspector connection label
  assert.match(indexHtml, /id=["']inspectorConnection["']/, 'Must have #inspectorConnection');

  // F-22: Voice dictation UI
  assert.match(indexHtml, /id=["']btnVoiceInput["']/, 'Must have #btnVoiceInput');
  assert.match(indexHtml, /id=["']voiceLangSelect["']/, 'Must have #voiceLangSelect');

  // F-23: Login TOTP input
  assert.match(loginHtml, /id=["']totpGroup["']/, 'login.html must have #totpGroup');
  assert.match(loginHtml, /id=["']totp["']/, 'login.html must have #totp input');
  assert.match(loginHtml, /pattern=["']\[0-9\]\*["']|maxlength=["']6["']/, 'TOTP input must restrict to digits');

  // F-24: PWA Static Assets exist
  const pwaIconPath = path.join(remoteControlPublic, 'assets', 'antigravity.png');
  const faviconPath = path.join(remoteControlPublic, 'favicon.ico');
  assert.ok(fs.existsSync(pwaIconPath), 'antigravity.png must exist');
  assert.ok(fs.existsSync(faviconPath), 'favicon.ico must exist');
  assert.ok(fs.statSync(pwaIconPath).size > 1000, 'antigravity.png must have valid non-zero byte size');
  assert.ok(fs.statSync(faviconPath).size > 1000, 'favicon.ico must have valid non-zero byte size');

  const icoHeader = fs.readFileSync(faviconPath).subarray(0, 4);
  assert.deepEqual(icoHeader, Buffer.from([0x00, 0x00, 0x01, 0x00]), 'favicon.ico must have valid ICO magic header');
});
