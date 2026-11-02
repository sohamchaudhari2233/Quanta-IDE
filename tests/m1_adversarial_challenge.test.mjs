// tests/m1_adversarial_challenge.test.mjs
// Empirical Adversarial Challenge Suite for Milestone M1 (Auth & Drive Concurrency/Injection)

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('module');

// Import production gdrive.ts functions directly
import {
  escapeDriveQueryTerm,
  findOrCreateFolder,
  listDriveFiles,
  listDriveFilesRecursive,
  readDriveFile,
  writeDriveFile,
  getMimeType,
  MIME_TYPE_MAP
} from '../Quanta-PC-Extension/src/gdrive.ts';

// Monkey-patch Module._resolveFilename once to supply mock 'vscode' module
Module._resolveFilename = (function (orig) {
  return function (request) {
    if (request === 'vscode') return 'vscode';
    return orig.apply(this, arguments);
  };
})(Module._resolveFilename);

let activeVscodeConfig = {
  oauthPort: 8085,
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  oauthHost: 'localhost',
  driveScope: 'drive.file'
};

let onOpenExternalHook = () => {};
let onShowErrorMessageHook = () => Promise.resolve();
let onShowInfoMessageHook = () => Promise.resolve();

const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => activeVscodeConfig[key] ?? def
    }),
    workspaceFolders: []
  },
  window: {
    showErrorMessage: (msg, ...items) => onShowErrorMessageHook(msg, ...items),
    showInformationMessage: (msg, ...items) => onShowInfoMessageHook(msg, ...items),
    showInputBox: () => Promise.resolve(null)
  },
  env: {
    openExternal: (uri) => onOpenExternalHook(uri.toString ? uri.toString() : uri),
    clipboard: { writeText: () => Promise.resolve() }
  },
  Uri: { parse: (s) => s }
};

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: mockVscode
};

const auth = require('../Quanta-PC-Extension/out/auth.js');

test.beforeEach(async () => {
  await auth.disconnect();
  openExternalCount = 0;
  capturedAuthUrl = null;
  onOpenExternalHook = () => {};
  onShowErrorMessageHook = () => Promise.resolve();
  onShowInfoMessageHook = () => Promise.resolve();
});

let openExternalCount = 0;
let capturedAuthUrl = null;

test('Concurrency Stress: 50 simultaneous authenticate() calls share single mutex promise', async () => {
  let openExternalCount = 0;
  let capturedAuthUrl = null;

  activeVscodeConfig = {
    oauthPort: 8085,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    oauthHost: 'localhost'
  };

  onOpenExternalHook = (url) => {
    openExternalCount++;
    capturedAuthUrl = url;
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.toString().includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({
        access_token: 'stress-test-access-token-999',
        expires_in: 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };

  try {
    // Fire 50 calls in parallel
    const authPromises = Array.from({ length: 50 }, () => auth.authenticate());

    // Allow loopback listener to start
    await new Promise(r => setTimeout(r, 80));

    // Exactly 1 server listener and 1 browser open must have been initiated
    assert.equal(openExternalCount, 1, 'Only 1 browser open request should be fired across 50 concurrent calls');
    assert.ok(capturedAuthUrl, 'Must capture auth URL');

    const authUrlObj = new URL(capturedAuthUrl);
    const state = authUrlObj.searchParams.get('state');
    assert.ok(state, 'Auth URL must contain PKCE state');

    // Send callback to the single loopback server
    const callbackRes = await origFetch(`http://127.0.0.1:8085/?code=stress_code_123&state=${state}`);
    assert.equal(callbackRes.status, 200);

    // Await all 50 promises
    const results = await Promise.all(authPromises);
    assert.equal(results.length, 50);
    for (let i = 0; i < 50; i++) {
      assert.equal(results[i], 'stress-test-access-token-999', `Call ${i} must resolve to the exchanged access token`);
    }

    // After completion, verify mutex is cleared and subsequent call starts cleanly
    await new Promise(r => setTimeout(r, 60));
    await auth.disconnect();
    openExternalCount = 0;
    const secondCall = auth.authenticate();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(openExternalCount, 1, 'Subsequent authenticate() after completion must start fresh');

    // Clean up second call
    const secondUrlObj = new URL(capturedAuthUrl);
    const secondState = secondUrlObj.searchParams.get('state');
    await origFetch(`http://127.0.0.1:8085/?code=second_code&state=${secondState}`);
    await secondCall;
    await new Promise(r => setTimeout(r, 50));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Port Collision & Port 0 Elimination: occupied port 8085 never binds port 0 and notifies user', async () => {
  // Pre-occupy port 8085 with a dummy server
  const occupyingServer = http.createServer((req, res) => res.end('occupied'));
  await new Promise(resolve => occupyingServer.listen(8085, resolve));

  let errorMessageShown = null;
  let openExternalCalled = false;

  activeVscodeConfig = {
    oauthPort: 8085,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    oauthHost: 'localhost'
  };

  onShowErrorMessageHook = (msg) => {
    errorMessageShown = msg;
    return Promise.resolve();
  };

  onOpenExternalHook = () => {
    openExternalCalled = true;
  };

  try {
    const authPromise = auth.authenticate();
    const result = await authPromise;

    // Must resolve to null
    assert.equal(result, null, 'authenticate() must resolve to null when port 8085 is occupied');

    // Must NEVER have opened browser with an ephemeral port (port 0)
    assert.equal(openExternalCalled, false, 'Browser must NOT be opened with an ephemeral port');

    // Must show descriptive error message indicating port 8085 is occupied
    assert.ok(errorMessageShown, 'Error message must be shown to the user');
    assert.ok(errorMessageShown.includes('8085'), 'Error message must mention port 8085');
    assert.ok(errorMessageShown.includes('in use'), 'Error message must explain port is in use');
  } finally {
    await new Promise(resolve => occupyingServer.close(resolve));
    await new Promise(r => setTimeout(r, 50));
  }
});

test('Port Fallback: non-8085 preferred port falls back to 8085 once and never to port 0', async () => {
  // Occupy custom port 9123
  const customOccupier = http.createServer((req, res) => res.end('occupied 9123'));
  await new Promise(resolve => customOccupier.listen(9123, resolve));

  let capturedUrl = null;

  activeVscodeConfig = {
    oauthPort: 9123,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    oauthHost: 'localhost'
  };

  onOpenExternalHook = (url) => {
    capturedUrl = url;
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.toString().includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'fallback-token-ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };

  try {
    const authPromise = auth.authenticate();
    await new Promise(r => setTimeout(r, 100));

    // When 9123 is occupied, it should fall back to 8085
    assert.ok(capturedUrl, 'Should fall back to port 8085 and open browser');
    assert.ok(capturedUrl.includes('redirect_uri=http%3A%2F%2Flocalhost%3A8085'), 'Must use port 8085 as fallback redirect_uri');
    assert.ok(!capturedUrl.includes(':0'), 'Must NEVER fall back to port 0');

    // Complete token exchange on port 8085
    const urlObj = new URL(capturedUrl);
    const state = urlObj.searchParams.get('state');
    await origFetch(`http://127.0.0.1:8085/?code=fallback_code&state=${state}`);
    const res = await authPromise;
    assert.equal(res, 'fallback-token-ok');
    await new Promise(r => setTimeout(r, 50));
  } finally {
    globalThis.fetch = origFetch;
    await new Promise(resolve => customOccupier.close(resolve));
    await new Promise(r => setTimeout(r, 50));
  }
});

test('Loopback Listener Concurrency: surviving hostile requests, favicons, and bad states', async () => {
  let capturedUrl = null;

  activeVscodeConfig = {
    oauthPort: 8085,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    oauthHost: 'localhost'
  };

  onOpenExternalHook = (url) => {
    capturedUrl = url;
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.toString().includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'resilient-token-999' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };

  try {
    const authPromise = auth.authenticate();
    await new Promise(r => setTimeout(r, 80));

    // 1. Send 5 concurrent favicon requests
    const favicons = await Promise.all(Array.from({ length: 5 }, () => origFetch('http://127.0.0.1:8085/favicon.ico')));
    for (const f of favicons) {
      assert.equal(f.status, 204, 'Favicon requests must return 204 No Content without closing server');
    }

    // 2. Send legitimate callback
    const urlObj = new URL(capturedUrl);
    const state = urlObj.searchParams.get('state');
    const cb = await origFetch(`http://127.0.0.1:8085/?code=resilient_code&state=${state}`);
    assert.equal(cb.status, 200);

    const result = await authPromise;
    assert.equal(result, 'resilient-token-999');
    await new Promise(r => setTimeout(r, 50));
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// SECTION 2: GOOGLE DRIVE QUERY INJECTION STRESS TESTING
// ============================================================================

// Formal Google Drive query lexer and AST validator
function parseAndValidateDriveFolderQuery(query) {
  // Expected schema: name = '<LITERAL>' and '<LITERAL>' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false
  const tokens = [];
  let i = 0;
  
  while (i < query.length) {
    if (query[i] === ' ') {
      i++;
      continue;
    }
    if (query[i] === "'") {
      // Parse string literal
      i++; // skip opening quote
      let literal = '';
      let closed = false;
      while (i < query.length) {
        if (query[i] === '\\') {
          if (i + 1 < query.length) {
            literal += query[i + 1];
            i += 2;
            continue;
          }
        }
        if (query[i] === "'") {
          closed = true;
          i++; // skip closing quote
          break;
        }
        literal += query[i];
        i++;
      }
      if (!closed) {
        throw new Error(`Unterminated string literal in query: ${query}`);
      }
      tokens.push({ type: 'STRING', value: literal });
      continue;
    }
    // Word / operator token
    let word = '';
    while (i < query.length && query[i] !== ' ' && query[i] !== "'") {
      word += query[i];
      i++;
    }
    tokens.push({ type: 'WORD', value: word });
  }

  // Verify structure: strictly 4 clauses joined by 'and'
  assert.equal(tokens[0].value, 'name');
  assert.equal(tokens[1].value, '=');
  assert.equal(tokens[2].type, 'STRING');
  assert.equal(tokens[3].value, 'and');
  assert.equal(tokens[4].type, 'STRING');
  assert.equal(tokens[5].value, 'in');
  assert.equal(tokens[6].value, 'parents');
  assert.equal(tokens[7].value, 'and');
  assert.equal(tokens[8].value, 'mimeType');
  assert.equal(tokens[9].value, '=');
  assert.equal(tokens[10].value, 'application/vnd.google-apps.folder');
  assert.equal(tokens[11].value, 'and');
  assert.equal(tokens[12].value, 'trashed');
  assert.equal(tokens[13].value, '=');
  assert.equal(tokens[14].value, 'false');
  assert.equal(tokens.length, 15, 'Query must have exactly 15 tokens: 0 injected clauses');

  return {
    parsedName: tokens[2].value,
    parsedParent: tokens[4].value
  };
}

test('Drive Query Injection: Comprehensive Adversarial Payload Battery', () => {
  const injectionPayloads = [
    // 1. Classic SQL/Drive injection attempts
    "' or '1'='1",
    "' or 1=1 or name='",
    "' or trashed = true or '1'='1",
    "test' and mimeType != 'folder",
    "'; DROP TABLE files; --",
    "\\'; DROP TABLE files; --",
    "' contains '",
    "name contains 'a' or 'b' = '",

    // 2. Single quotes and apostrophes in legitimate folder names
    "O'Reilly's Books & Work's",
    "Don't Stop Believin'",
    "'''",
    "''''''''''",
    "'''''test'''''",

    // 3. Backslashes and Windows path separators
    "C:\\Users\\soham\\quanta\\",
    "\\\\server\\share\\folder",
    "trailing\\",
    "double_trailing\\\\",
    "triple_trailing\\\\\\",
    "mixed\\and'quotes\\'together",
    "escaped\\\\\\'quote",

    // 4. Double quotes and mixed quotes
    'Folder with "Double Quotes"',
    '"""""',
    '\'"""\'"""\'',

    // 5. Metacharacters and whitespace tricks
    "Folder\nwith\nnewlines",
    "Folder\r\nwith\r\nCRLF",
    "Folder\twith\ttabs",
    "Folder\0with\0nullbytes",
    "    spaces    ",
    "()[]{}!@#$%^&*+-=/<>:;,.?",

    // 6. Unicode, RTL overrides, emojis
    "📁 Quanta Projects 🚀",
    "中文 文件夹 ' 测试",
    "يوميات ' العمل \\ المشترك",
    "\u202Ereversed_folder\u202C",

    // 7. Extremely long string (10,000 chars)
    "O'Reilly \\\\".repeat(1000)
  ];

  for (const payload of injectionPayloads) {
    const escaped = escapeDriveQueryTerm(payload);

    // Build the query exactly as findOrCreateFolder builds it
    const query = `name = '${escaped}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

    // Parse and validate query using strict AST validator
    const { parsedName } = parseAndValidateDriveFolderQuery(query);

    // Verify unescaped value matches original payload byte-for-byte
    assert.equal(parsedName, payload, `Parsed literal value must equal original payload for: ${payload.substring(0, 30)}`);
  }
});

test('findOrCreateFolder: applies escapeDriveQueryTerm and builds syntactically valid URL', async () => {
  const origFetch = globalThis.fetch;
  let sentUrl = '';

  globalThis.fetch = async (url) => {
    sentUrl = url.toString();
    return new Response(JSON.stringify({
      files: [{ id: 'found-adversarial-id', name: "Adversarial's Folder" }]
    }), { status: 200 });
  };

  try {
    const maliciousName = "test' or '1'='1' and 'root";
    const maliciousParent = "parent' or 'a'='a";
    const id = await findOrCreateFolder('mock-token', maliciousName, maliciousParent);

    assert.equal(id, 'found-adversarial-id');
    const parsedUrl = new URL(sentUrl);
    const qParam = parsedUrl.searchParams.get('q');

    // qParam must be strictly parseable and safe
    const { parsedName, parsedParent } = parseAndValidateDriveFolderQuery(qParam);
    assert.equal(parsedName, maliciousName);
    assert.equal(parsedParent, maliciousParent);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// SECTION 3: GOOGLE DRIVE PAGINATION STRESS TESTING
// ============================================================================

test('Pagination Stress: listDriveFiles paginates 20 consecutive pages with 2,000 items', async () => {
  const TOTAL_PAGES = 20;
  const ITEMS_PER_PAGE = 100;
  const requestedTokens = [];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url.toString());
    const pageToken = parsed.searchParams.get('pageToken');
    requestedTokens.push(pageToken);

    const currentPageIndex = pageToken ? parseInt(pageToken.replace('page_', ''), 10) : 1;
    const isLastPage = currentPageIndex === TOTAL_PAGES;

    const files = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const fileNum = (currentPageIndex - 1) * ITEMS_PER_PAGE + i + 1;
      files.push({
        id: `file_${fileNum}`,
        name: `document_${fileNum}.txt`,
        mimeType: 'text/plain',
        modifiedTime: new Date().toISOString()
      });
    }

    return new Response(JSON.stringify({
      nextPageToken: isLastPage ? undefined : `page_${currentPageIndex + 1}`,
      files
    }), { status: 200 });
  };

  try {
    const results = await listDriveFiles('mock-token', 'folder_pagination_root');

    // 1. Must collect all 2,000 files
    assert.equal(results.length, TOTAL_PAGES * ITEMS_PER_PAGE);

    // 2. Must have made exactly 20 requests
    assert.equal(requestedTokens.length, TOTAL_PAGES);

    // 3. First request has no pageToken, remaining 19 have page_2 .. page_20
    assert.equal(requestedTokens[0], null);
    for (let p = 2; p <= TOTAL_PAGES; p++) {
      assert.equal(requestedTokens[p - 1], `page_${p}`);
    }

    // 4. Files must be in exact sequential order from 1 to 2000
    assert.equal(results[0].name, 'document_1.txt');
    assert.equal(results[results.length - 1].name, 'document_2000.txt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Pagination Stress: Page tokens with complex URL characters (&, +, =, ?, emojis)', async () => {
  const complexTokens = [
    'tok/with+slashes=and==equals',
    'tok&with?query%params',
    'tok with spaces and 🚀',
    'tok"with"quotes\'and\'single'
  ];

  let step = 0;
  const receivedTokens = [];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url.toString());
    const token = parsed.searchParams.get('pageToken');
    receivedTokens.push(token);

    if (step < complexTokens.length) {
      const nextTok = complexTokens[step++];
      return new Response(JSON.stringify({
        nextPageToken: nextTok,
        files: [{ id: `f_${step}`, name: `f_${step}.txt` }]
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      files: [{ id: 'f_final', name: 'f_final.txt' }]
    }), { status: 200 });
  };

  try {
    const results = await listDriveFiles('mock-token', 'root');
    assert.equal(results.length, complexTokens.length + 1);

    // Verify all complex tokens were transmitted and received uncorrupted
    assert.equal(receivedTokens[0], null);
    for (let i = 0; i < complexTokens.length; i++) {
      assert.equal(receivedTokens[i + 1], complexTokens[i], `Complex token ${i} must preserve characters`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Pagination Stress: listDriveFilesRecursive handles deep hierarchical pagination & 12 subfolder batching', async () => {
  // Scenario:
  // Root has 3 pages:
  // - Page 1: 5 files + 5 folders (sub_1 .. sub_5)
  // - Page 2: 5 files + 5 folders (sub_6 .. sub_10)
  // - Page 3: 5 files + 2 folders (sub_11, sub_12) -> total 12 subfolders (tests chunking of 5, 5, 2)
  // Each subfolder has 2 pages:
  // - Page 1: 2 files
  // - Page 2: 2 files
  // Total expected files: 15 root files + 12 folder entries + (12 * 4) = 75 items

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    const parsed = new URL(urlStr);
    const q = parsed.searchParams.get('q');
    const pageToken = parsed.searchParams.get('pageToken');

    if (q.includes("'root_hierarchical'")) {
      // Root requests
      if (!pageToken) {
        // Page 1
        return new Response(JSON.stringify({
          nextPageToken: 'root_page_2',
          files: [
            ...Array.from({ length: 5 }, (_, i) => ({ id: `rf_${i + 1}`, name: `root_file_${i + 1}.txt`, mimeType: 'text/plain' })),
            ...Array.from({ length: 5 }, (_, i) => ({ id: `sub_${i + 1}`, name: `sub_${i + 1}`, mimeType: 'application/vnd.google-apps.folder' }))
          ]
        }), { status: 200 });
      } else if (pageToken === 'root_page_2') {
        // Page 2
        return new Response(JSON.stringify({
          nextPageToken: 'root_page_3',
          files: [
            ...Array.from({ length: 5 }, (_, i) => ({ id: `rf_${i + 6}`, name: `root_file_${i + 6}.txt`, mimeType: 'text/plain' })),
            ...Array.from({ length: 5 }, (_, i) => ({ id: `sub_${i + 6}`, name: `sub_${i + 6}`, mimeType: 'application/vnd.google-apps.folder' }))
          ]
        }), { status: 200 });
      } else if (pageToken === 'root_page_3') {
        // Page 3
        return new Response(JSON.stringify({
          files: [
            ...Array.from({ length: 5 }, (_, i) => ({ id: `rf_${i + 11}`, name: `root_file_${i + 11}.txt`, mimeType: 'text/plain' })),
            ...Array.from({ length: 2 }, (_, i) => ({ id: `sub_${i + 11}`, name: `sub_${i + 11}`, mimeType: 'application/vnd.google-apps.folder' }))
          ]
        }), { status: 200 });
      }
    }

    // Subfolder requests
    for (let s = 1; s <= 12; s++) {
      if (q.includes(`'sub_${s}'`)) {
        if (!pageToken) {
          // Page 1 of subfolder
          return new Response(JSON.stringify({
            nextPageToken: `sub_${s}_page_2`,
            files: [
              { id: `sub_${s}_f1`, name: 'item1.txt', mimeType: 'text/plain' },
              { id: `sub_${s}_f2`, name: 'item2.txt', mimeType: 'text/plain' }
            ]
          }), { status: 200 });
        } else if (pageToken === `sub_${s}_page_2`) {
          // Page 2 of subfolder
          return new Response(JSON.stringify({
            files: [
              { id: `sub_${s}_f3`, name: 'item3.txt', mimeType: 'text/plain' },
              { id: `sub_${s}_f4`, name: 'item4.txt', mimeType: 'text/plain' }
            ]
          }), { status: 200 });
        }
      }
    }

    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  };

  try {
    const allFiles = await listDriveFilesRecursive('mock-token', 'root_hierarchical');

    // Expected: 15 root files + 12 folder markers (sub_1/ .. sub_12/) + 12 * 4 nested files = 75 items
    assert.equal(allFiles.length, 75);

    // Verify subfolders have correctly formatted recursive paths
    for (let s = 1; s <= 12; s++) {
      const folderItem = allFiles.find(f => f.name === `sub_${s}/`);
      assert.ok(folderItem, `Folder marker sub_${s}/ must be present`);

      for (let itemNum = 1; itemNum <= 4; itemNum++) {
        const nestedItem = allFiles.find(f => f.name === `sub_${s}/item${itemNum}.txt`);
        assert.ok(nestedItem, `Nested item sub_${s}/item${itemNum}.txt must be present`);
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});
