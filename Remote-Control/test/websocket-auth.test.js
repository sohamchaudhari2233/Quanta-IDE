import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import signature from 'cookie-signature';
import { SessionManager } from '../security/sessionManager.js';

const AUTH_COOKIE_NAME = 'ag_auth_token';
const sessionSecret = 'fixture-only-session-secret-42';

// Helper matching server.js isLocalRequest
function isLocalRequest(req) {
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

// Fixed WebSocket connection handler logic (matching server.js:2806-2847)
function handleWebSocketAuth(req, sessionManager, secret = sessionSecret) {
    const rawCookies = req.headers?.cookie || '';
    const parsedCookies = {};
    rawCookies.split(';').forEach(c => {
        const [k, v] = c.trim().split('=');
        if (k && v) {
            try {
                parsedCookies[k] = decodeURIComponent(v);
            } catch (e) {
                parsedCookies[k] = v;
            }
        }
    });

    const signedToken = parsedCookies[AUTH_COOKIE_NAME];
    let isAuthenticated = false;
    let authenticatedSession = null;

    // 1. Configurable LAN Auto-Trust (Zero-Trust compliance)
    if (sessionManager.allowLanAutoTrust && isLocalRequest(req)) {
        isAuthenticated = true;
    } else if (signedToken) {
        const token = cookieParser.signedCookie(signedToken, secret);
        // Valid signed cookie must not be false and must differ from raw signed string
        if (token && token !== signedToken) {
            const session = sessionManager.getSession(token);
            if (session) {
                isAuthenticated = true;
                authenticatedSession = session;
            }
        }
    }

    return { isAuthenticated, session: authenticatedSession };
}

test('WebSocket Tunnel Auth: rejects connection without cookie', () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const req = {
        headers: {
            'x-forwarded-for': '198.51.100.24'
        },
        socket: { remoteAddress: '127.0.0.1' }
    };
    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, false);
    assert.equal(result.session, null);
});

test('WebSocket Tunnel Auth: authenticates valid session via sessionManager.getSession and avoids redirect loop', () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const session = sm.createSession({
        ip: '198.51.100.24',
        userAgent: 'Mozilla/5.0 Mobile',
        isLocal: false,
        isTunnel: true
    });

    const signedCookie = 's:' + signature.sign(session.id, sessionSecret);
    const req = {
        headers: {
            'x-forwarded-for': '198.51.100.24',
            cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(signedCookie)}`
        },
        socket: { remoteAddress: '127.0.0.1' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, true);
    assert.ok(result.session);
    assert.equal(result.session.id, session.id);
    assert.equal(result.session.mode, 'read-only');
});

test('WebSocket Tunnel Auth: rejects tampered or forged signed cookies', () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const session = sm.createSession({
        ip: '198.51.100.24',
        userAgent: 'Mozilla/5.0 Mobile',
        isLocal: false,
        isTunnel: true
    });

    const forgedCookie = 's:' + signature.sign(session.id, 'attacker-secret');
    const req = {
        headers: {
            'x-forwarded-for': '198.51.100.24',
            cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(forgedCookie)}`
        },
        socket: { remoteAddress: '127.0.0.1' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, false);
    assert.equal(result.session, null);
});

test('WebSocket Tunnel Auth: rejects expired sessions even with valid signature', () => {
    const sm = new SessionManager({
        absoluteLifetimeMs: 1000,
        idleTimeoutMs: 500
    });
    const session = sm.createSession({
        ip: '198.51.100.24',
        userAgent: 'Mozilla/5.0 Mobile',
        isLocal: false,
        isTunnel: true
    });
    // Manually expire
    session.createdAt = Date.now() - 2000;

    const signedCookie = 's:' + signature.sign(session.id, sessionSecret);
    const req = {
        headers: {
            'x-forwarded-for': '198.51.100.24',
            cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(signedCookie)}`
        },
        socket: { remoteAddress: '127.0.0.1' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, false);
    assert.equal(result.session, null);
});

test('WebSocket Zero-Trust: rejects unauthenticated LAN connection when allowLanAutoTrust is false', () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const req = {
        headers: {},
        socket: { remoteAddress: '192.168.1.150' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, false);
    assert.equal(result.session, null);
});

test('WebSocket Zero-Trust: accepts authenticated LAN connection with valid session cookie when allowLanAutoTrust is false', () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const session = sm.createSession({
        ip: '192.168.1.150',
        userAgent: 'Local Browser',
        isLocal: true,
        isTunnel: false
    });

    const signedCookie = 's:' + signature.sign(session.id, sessionSecret);
    const req = {
        headers: {
            cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(signedCookie)}`
        },
        socket: { remoteAddress: '192.168.1.150' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, true);
    assert.ok(result.session);
    assert.equal(result.session.id, session.id);
});

test('WebSocket LAN Auto-Trust: accepts unauthenticated LAN connection when allowLanAutoTrust is true', () => {
    const sm = new SessionManager({ allowLanAutoTrust: true });
    const req = {
        headers: {},
        socket: { remoteAddress: '192.168.1.150' }
    };

    const result = handleWebSocketAuth(req, sm);
    assert.equal(result.isAuthenticated, true);
});

test('WebSocket Tunnel Spoofing Defense: rejects tunnel connection with forwarded headers claiming loopback socket', () => {
    const sm = new SessionManager({ allowLanAutoTrust: true });
    // Proxy forwards external client through loopback reverse proxy
    const req = {
        headers: {
            'x-forwarded-for': '203.0.113.88'
        },
        socket: { remoteAddress: '127.0.0.1' }
    };

    const result = handleWebSocketAuth(req, sm);
    // Despite socket being 127.0.0.1 and allowLanAutoTrust=true, x-forwarded-for marks it as non-local!
    assert.equal(result.isAuthenticated, false);
});

test('WebSocket Live Server Integration: full TCP handshake and tunnel authentication flow', async () => {
    const sm = new SessionManager({ allowLanAutoTrust: false });
    const session = sm.createSession({
        ip: '203.0.113.50',
        userAgent: 'TestClient',
        isLocal: false,
        isTunnel: true
    });
    const validCookie = 's:' + signature.sign(session.id, sessionSecret);

    // Setup temporary HTTP + WS server on port 0
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws, req) => {
        const auth = handleWebSocketAuth(req, sm);
        if (!auth.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 20);
            return;
        }
        ws.session = auth.session;
        ws.send(JSON.stringify({ type: 'authenticated', mode: auth.session.mode }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        // Case A: Connect with valid tunnel session cookie
        const wsValid = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: {
                'x-forwarded-for': '203.0.113.50',
                cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(validCookie)}`
            }
        });

        const validMsg = await new Promise((resolve, reject) => {
            wsValid.on('message', (data) => resolve(JSON.parse(data.toString())));
            wsValid.on('error', reject);
        });

        assert.equal(validMsg.type, 'authenticated');
        assert.equal(validMsg.mode, 'read-only');
        wsValid.close();

        // Case B: Connect over tunnel without cookie -> receives Unauthorized error
        const wsInvalid = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: {
                'x-forwarded-for': '203.0.113.50'
            }
        });

        const invalidMsg = await new Promise((resolve, reject) => {
            wsInvalid.on('message', (data) => resolve(JSON.parse(data.toString())));
            wsInvalid.on('error', reject);
        });

        assert.equal(invalidMsg.type, 'error');
        assert.equal(invalidMsg.message, 'Unauthorized');

        await new Promise((resolve) => wsInvalid.on('close', resolve));
    } finally {
        wss.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
