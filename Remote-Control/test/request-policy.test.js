import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import express from 'express';
import { isLocalRequest, isSameOrigin, asyncRoute, apiErrorHandler } from '../security/requestPolicy.js';
import { getClientIp } from '../security/rateLimiter.js';
import { SessionManager, TotpEngine } from '../security/sessionManager.js';
import { parseMultipart } from '../ide/multipart.js';

test('local network classification rejects public 172 addresses and forwarding headers', () => {
    const request = address => ({ headers: {}, socket: { remoteAddress: address } });
    for (const ip of ['172.32.1.1', '172.39.1.1', '172.200.1.1', '8.8.8.8']) assert.equal(isLocalRequest(request(ip)), false, ip);
    for (const ip of ['172.16.0.1', '172.31.255.255', '::ffff:172.20.0.1', '192.168.1.2', '::1']) assert.equal(isLocalRequest(request(ip)), true, ip);
    const req = request('127.0.0.1'); req.headers.forwarded = 'for=1.2.3.4';
    assert.equal(isLocalRequest(req), false);
});

test('origin checks require an exact host and port including tunnel domains', () => {
    const req = { headers: { host: 'quanta.ngrok-free.app' } };
    assert.equal(isSameOrigin(req, 'https://quanta.ngrok-free.app'), true);
    for (const origin of ['https://evil.ngrok-free.app', 'https://evillocalhost', 'https://evil127.0.0.1', 'null', 'file://quanta.ngrok-free.app', 'https://quanta.ngrok-free.app:444']) assert.equal(isSameOrigin(req, origin), false, origin);
});

test('direct clients cannot evade rate limiting using forged forwarding headers', () => {
    const req = { socket: { remoteAddress: '192.168.1.8' }, headers: { 'x-forwarded-for': '8.8.8.8' } };
    assert.equal(getClientIp(req), '192.168.1.8');
    req.socket.remoteAddress = '127.0.0.1';
    assert.equal(getClientIp(req), '8.8.8.8');
    assert.equal(getClientIp(req, 'false'), '127.0.0.1');
});

test('session demotion and destruction release controller locks; passive validation preserves idle timeout', () => {
    const sm = new SessionManager({ idleTimeoutMs: 1000 });
    try {
        const a = sm.createSession({ ip: '127.0.0.1', userAgent: 'a', isLocal: true });
        const b = sm.createSession({ ip: '127.0.0.1', userAgent: 'b', isLocal: true });
        assert.equal(sm.isController(a.id), true);
        sm.demoteSession(a.id);
        assert.equal(sm.isController(b.id), true);
        const before = b.lastSeenAt = Date.now() - 500;
        sm.getSession(b.id, false);
        assert.equal(b.lastSeenAt, before);
        sm.destroySession(b.id);
        assert.equal(sm.activeControllerSessionId, null);
        a.lastSeenAt = Date.now() - 2000;
        assert.equal(sm.getSession(a.id, false), null);
    } finally { clearInterval(sm.cleanupInterval); }
});

test('TOTP malformed payloads fail closed without throwing', () => {
    for (const token of [123456, {}, [], null, 'abc123', '1234567']) assert.equal(TotpEngine.verifyToken(token, 'JBSWY3DPEHPK3PXP'), false);
    assert.equal(TotpEngine.verifyToken('123456', {}), false);
});

test('multipart parser accepts quoted boundary and preserves raw binary bytes', async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13]);
    const req = Readable.from([Buffer.from('--xyz\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\n\r\n'), bytes, Buffer.from('\r\n--xyz--\r\n')]);
    req.headers = { 'content-type': 'multipart/form-data; boundary="xyz"' };
    const result = await parseMultipart(req);
    assert.equal(result.filename, 'image.png');
    assert.deepEqual(result.data, bytes);
});

test('multipart parser bounds uploads and rejects malformed requests', async () => {
    for (const size of [0, 11 * 1024 * 1024]) {
        const req = Readable.from([Buffer.alloc(size)]);
        req.headers = { 'content-type': 'multipart/form-data; boundary=xyz' };
        await assert.rejects(parseMultipart(req), error => error.status === (size ? 413 : 400));
    }
});

test('async route rejection returns JSON and the server keeps serving subsequent requests', async () => {
    const app = express();
    app.get('/fail', asyncRoute(async () => { throw new Error('private stack data'); }));
    app.get('/ok', (req, res) => res.json({ ok: true }));
    app.use(apiErrorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const failed = await fetch(`${base}/fail`);
        assert.equal(failed.status, 500);
        assert.doesNotMatch(await failed.text(), /private stack/);
        assert.deepEqual(await (await fetch(`${base}/ok`)).json(), { ok: true });
    } finally { await new Promise(resolve => server.close(resolve)); }
});
