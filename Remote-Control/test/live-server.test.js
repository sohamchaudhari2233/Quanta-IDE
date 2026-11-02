import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

test('actual server enforces HTTP, upload, tunnel, elevation and WebSocket boundaries', { timeout: 30000 }, async () => {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const tls = fs.existsSync(new URL('../certs/server.key', import.meta.url));
    const transport = tls ? https : http;
    const password = 'quanta-test-strong-password';
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
        cwd: directory, windowsHide: true,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CDP_PORT: '1', APP_PASSWORD: password,
            SESSION_SECRET: 'quanta-test-session-secret', ENABLE_TOTP: 'false', ENABLE_DEMO_LOGIN: 'false',
            ALLOW_LAN_AUTO_TRUST: 'false', REQUIRE_DEVICE_PAIRING: 'false' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostics = '';
    child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-3000); });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-3000); });
    function request(path, method = 'GET', body, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = transport.request({ hostname: '127.0.0.1', port, path, method, rejectUnauthorized: false,
                headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
                let text = '';
                res.on('data', data => { text += data; });
                res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
            });
            req.on('error', reject);
            req.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    try {
        let ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
            if (child.exitCode !== null) throw new Error(`Server exited: ${diagnostics}`);
            try { ready = (await request('/health')).status === 200; } catch {}
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(ready, true, diagnostics);
        assert.equal((await request('/api/session')).status, 401);
        assert.equal((await request('/?demo=1')).status, 302);
        assert.equal((await request('/login', 'POST', { password }, { Origin: 'https://evil.ngrok-free.app' })).status, 403);
        const login = await request('/login', 'POST', { password });
        assert.equal(login.status, 200);
        const cookie = login.headers['set-cookie'][0].split(';')[0];
        assert.equal((await request('/send', 'POST', { message: {} }, { cookie })).status, 400);
        assert.equal((await request('/send', 'POST', { message: 'hello' }, { cookie })).status, 503);
        assert.equal((await request('/api/checkpoints?workspace=C:/', 'GET', undefined, { cookie })).status, 400);
        assert.equal((await request('/upload-file', 'POST', {}, { cookie })).status, 400);

        const forwarded = { 'x-forwarded-for': '198.51.100.8' };
        const remote = await request('/login', 'POST', { password }, forwarded);
        assert.equal(remote.json.mode, 'read-only');
        const remoteCookie = remote.headers['set-cookie'][0].split(';')[0];
        const remoteHeaders = { ...forwarded, cookie: remoteCookie };
        assert.equal((await request('/upload-file', 'POST', {}, remoteHeaders)).status, 403);
        assert.equal((await request('/select-chat', 'POST', { title: 'test' }, remoteHeaders)).status, 403);
        assert.equal((await request('/api/elevate', 'POST', { password }, remoteHeaders)).json.success, true);
        assert.equal((await request('/api/session', 'GET', undefined, remoteHeaders)).json.mode, 'control');

        const wsURL = `${tls ? 'wss' : 'ws'}://127.0.0.1:${port}`;
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(wsURL, { rejectUnauthorized: false, headers: { cookie, Origin: 'https://evil.ngrok-free.app' } });
            socket.on('open', () => { socket.close(); reject(new Error('Cross-origin socket accepted')); });
            socket.on('unexpected-response', (req, res) => { res.resume(); socket.terminate(); assert.equal(res.statusCode, 403); resolve(); });
            socket.on('error', () => {});
        });
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(wsURL, { rejectUnauthorized: false, headers: { cookie } });
            socket.on('error', reject);
            socket.on('open', () => { socket.close(); resolve(); });
        });
        for (let i = 0; i < 5; i++) await request('/api/elevate', 'POST', { password: 'wrong' }, remoteHeaders);
        assert.equal((await request('/api/elevate', 'POST', { password }, remoteHeaders)).status, 429);
        await request('/logout', 'POST', {}, { cookie });
        assert.equal((await request('/api/session', 'GET', undefined, { cookie })).status, 401);
        assert.equal((await request('/health')).headers['cache-control'], 'no-store');
    } finally {
        if (child.exitCode === null) {
            const closed = new Promise(resolve => child.once('exit', resolve));
            child.kill();
            await closed;
        }
    }
});
