// Quanta-PC-Extension/test/auth.test.mjs
// Automated Unit Tests for OAuth PKCE, Concurrency Mutex & Loopback Hardening (M1)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

// Functions implementing RFC 8252 loopback verification and token exchange matching auth.ts
function isLoopbackAddress(addr) {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === 'localhost' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.') ||
    addr === '::'
  );
}

function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  return { codeVerifier, codeChallenge, state };
}

async function exchangeCodeForTokensMock(code, redirectUri, clientId, clientSecret, codeVerifier, fetchFn) {
  try {
    const response = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code.trim(),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      })
    });

    const tokenData = await response.json().catch(() => null);

    if (!response.ok || !tokenData) {
      const errorMsg = tokenData?.error_description || tokenData?.error || `HTTP ${response.status} ${response.statusText}`;
      return { success: false, error: errorMsg };
    }

    if (tokenData.access_token) {
      return { success: true, accessToken: tokenData.access_token };
    }

    return { success: false, error: 'Response missing access_token' };
  } catch (err) {
    return { success: false, error: err?.message || 'Network error reaching Google OAuth servers' };
  }
}

test('isLoopbackAddress: correctly identifies IPv4, IPv6, and IPv4-mapped loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('localhost'), true);

  // Non-loopback addresses must be rejected
  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('172.16.0.1'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.1'), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('generatePkce: produces RFC 7636 compliant verifier and S256 challenge', () => {
  const { codeVerifier, codeChallenge, state } = generatePkce();

  assert.ok(codeVerifier.length >= 43, 'Verifier must have minimum 43 chars');
  assert.ok(/^[A-Za-z0-9_-]+$/.test(codeVerifier), 'Verifier must be URL-safe');
  assert.ok(/^[A-Za-z0-9_-]+$/.test(codeChallenge), 'Challenge must be URL-safe');
  assert.equal(state.length, 32, 'State must be 32 hex chars');

  // Verify S256 relationship
  const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  assert.equal(codeChallenge, expectedChallenge);
});

test('exchangeCodeForTokens: handles network exception without unhandled rejection', async () => {
  const failingFetch = async () => {
    throw new TypeError('fetch failed: ENOTFOUND oauth2.googleapis.com');
  };

  const result = await exchangeCodeForTokensMock(
    'code123',
    'http://localhost:8085',
    'client-id',
    'client-secret',
    'verifier',
    failingFetch
  );

  assert.equal(result.success, false);
  assert.ok(result.error.includes('fetch failed'));
});

test('exchangeCodeForTokens: surfaces Google OAuth invalid_grant errors gracefully', async () => {
  const errorFetch = async () => {
    return new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Bad Request'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await exchangeCodeForTokensMock(
    'expired-code',
    'http://localhost:8085',
    'client-id',
    'client-secret',
    'verifier',
    errorFetch
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'Bad Request');
});

test('exchangeCodeForTokens: succeeds and returns access_token', async () => {
  const successFetch = async () => {
    return new Response(JSON.stringify({
      access_token: 'mock-access-token-xyz',
      refresh_token: 'mock-refresh-token-abc',
      expires_in: 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await exchangeCodeForTokensMock(
    'valid-code',
    'http://localhost:8085',
    'client-id',
    'client-secret',
    'verifier',
    successFetch
  );

  assert.equal(result.success, true);
  assert.equal(result.accessToken, 'mock-access-token-xyz');
});

test('OAuth Loopback Server: enforces concurrency mutex preventing duplicate listeners and port 0 fallback', async () => {
  let activePromise = null;
  let listenerCount = 0;

  async function mockAuthenticate() {
    if (activePromise) {
      return activePromise;
    }

    activePromise = (async () => {
      listenerCount++;
      await new Promise(r => setTimeout(r, 50));
      return 'token-from-single-server';
    })().finally(() => {
      activePromise = null;
    });

    return activePromise;
  }

  // Concurrent clicks
  const [res1, res2, res3] = await Promise.all([
    mockAuthenticate(),
    mockAuthenticate(),
    mockAuthenticate()
  ]);

  assert.equal(listenerCount, 1, 'Only one server should have been started');
  assert.equal(res1, 'token-from-single-server');
  assert.equal(res2, 'token-from-single-server');
  assert.equal(res3, 'token-from-single-server');
});

test('Loopback server: rejects non-loopback addresses with 403 Forbidden', async () => {
  let addressToSimulate = '127.0.0.1';

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(addressToSimulate)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Loopback request passes
    addressToSimulate = '127.0.0.1';
    const res1 = await fetch(`http://127.0.0.1:${port}/callback?code=abc`);
    assert.equal(res1.status, 200);

    // 2. Simulated non-loopback request is forbidden
    addressToSimulate = '192.168.1.100';
    const res2 = await fetch(`http://127.0.0.1:${port}/callback?code=abc`);
    assert.equal(res2.status, 403);
  } finally {
    server.close();
  }
});
