import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import dotenv from 'dotenv';
import { prepareEnvironment } from '../core/setupEnvironment.js';
import { canUseDemoLogin } from '../security/demoAccess.js';
import { FileBrowser } from '../ide/fileBrowser.js';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const source = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('setup replaces template and commented secrets and preserves real credentials on repeated runs', () => {
    const template = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const result = prepareEnvironment(template);
    const values = dotenv.parse(result.content);
    assert.match(values.APP_PASSWORD, /^[a-f0-9]{36}$/);
    assert.match(values.SESSION_SECRET, /^[a-f0-9]{64}$/);
    assert.match(values.AUTH_SALT, /^[a-f0-9]{64}$/);
    assert.equal(prepareEnvironment(result.content).updated, false);
    const existing = 'APP_PASSWORD="my own real password"\nSESSION_SECRET=existing-secret\nAUTH_SALT=existing-salt\n';
    assert.equal(prepareEnvironment(existing).content, existing);
});

test('demo login rejects spoofed localhost headers, proxies and disabled bypass', () => {
    const req = { socket: { remoteAddress: '192.168.1.8' }, headers: { host: 'localhost' } };
    assert.equal(canUseDemoLogin(req, true), false);
    req.socket.remoteAddress = '127.0.0.1';
    assert.equal(canUseDemoLogin(req, false), false);
    assert.equal(canUseDemoLogin(req, true), true);
    req.headers['x-forwarded-for'] = '127.0.0.1';
    assert.equal(canUseDemoLogin(req, true), false);
});

test('file browser rejects sibling-prefix escape, sensitive ancestors and external junctions', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-jail-'));
    try {
        const root = path.join(temp, 'workspace');
        const sibling = path.join(temp, 'workspace-private');
        fs.mkdirSync(root);
        fs.mkdirSync(sibling);
        fs.writeFileSync(path.join(sibling, 'secret.txt'), 'private');
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, '.git', 'config'), 'private');
        const browser = new FileBrowser(root);
        assert.throws(() => browser.resolveSafePath('../workspace-private/secret.txt'), /traversal/);
        assert.throws(() => browser.resolveSafePath('.git/config'), /Sensitive/);
        assert.throws(() => browser.resolveSafePath('API keys'), /Sensitive/);
        fs.symlinkSync(sibling, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => browser.resolveSafePath('external/secret.txt'), /Symlink/);
        assert.throws(() => browser.resolveSafePath('external/new.txt'), /Symlink/);
        assert.equal(browser.listDirectory().some(item => item.name === 'external'), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('offline queue keeps and replays prompts when browser storage is unavailable', async () => {
    for (const indexedDB of [undefined, { open() { throw new Error('Storage blocked'); } }]) {
        const context = vm.createContext({ window: { indexedDB, confirm: () => true }, console });
        vm.runInContext(source('js/offlineQueue.js'), context);
        const queue = context.window.QuantaOfflineQueue;
        const record = await queue.enqueuePrompt('Keep my draft');
        assert.equal(record.memoryOnly, true);
        assert.equal((await queue.getPendingPrompts()).length, 1);
        await queue.replayPending(async () => false);
        assert.equal((await queue.getPendingPrompts()).length, 1);
        await queue.replayPending(async item => item.prompt === 'Keep my draft');
        assert.equal((await queue.getPendingPrompts()).length, 0);
    }
});

test('service worker ignores private routes, pairing URLs, external assets and commands', async () => {
    const handlers = {};
    const context = vm.createContext({
        self: { location: { origin: 'https://quanta.test' }, addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting() {} },
        URL, Response, console,
        fetch: async () => new Response('static'),
        caches: { open: async () => ({ put: async () => {} }) }
    });
    vm.runInContext(source('sw.js'), context);
    for (const path of ['/', '/app-state', '/api/session', '/snapshot', '/health', '/pair?ticket=secret', '/login.html?ticket=secret', '/new-private-endpoint']) {
        let intercepted = false;
        handlers.fetch({ request: { url: `https://quanta.test${path}`, method: 'GET' }, respondWith() { intercepted = true; } });
        assert.equal(intercepted, false, path);
    }
    for (const request of [{ url: 'https://other.test/js/app.js', method: 'GET' }, { url: 'https://quanta.test/login.html', method: 'POST' }]) {
        handlers.fetch({ request, respondWith() { assert.fail('Must bypass'); } });
    }
    let response;
    handlers.fetch({ request: { url: 'https://quanta.test/css/layouts.css', method: 'GET' }, respondWith(value) { response = value; }, waitUntil() {} });
    assert.equal(await (await response).text(), 'static');
});

function composerContext(send) {
    const context = vm.createContext({
        messageInput: { value: 'Draft message', style: {} }, sendBtn: { disabled: false },
        navigator: { onLine: true }, window: {}, chatIsOpen: true,
        fetchWithAuth: send, setAgentExecuting() {}, setTimeout() {}, loadSnapshot() {}, checkChatStatus() {},
        showToast(message) { context.notice = message; }, confirm: () => true
    });
    const app = source('js/app.js');
    vm.runInContext(app.slice(app.indexOf('let messageSending = false;'), app.indexOf('// --- Event Listeners ---')), context);
    return context;
}

test('composer retains drafts for rejected and uncertain sends', async () => {
    for (const send of [async () => { throw Error('Offline'); }, async () => ({ ok: false, json: async () => ({ error: 'CDP disconnected' }) }), async () => ({ ok: true, json: async () => ({ success: false }) })]) {
        const context = composerContext(send);
        await context.sendMessage();
        assert.equal(context.messageInput.value, 'Draft message');
        assert.match(context.notice, /Draft kept/);
        assert.equal(context.sendBtn.disabled, false);
    }
});

test('composer blocks duplicate in-flight sends and preserves edits made while sending', async () => {
    let finish;
    let requests = 0;
    const context = composerContext(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
    const pending = context.sendMessage();
    await context.sendMessage();
    assert.equal(requests, 1);
    context.messageInput.value = 'Next draft';
    finish({ ok: true, json: async () => ({ success: true }) });
    await pending;
    assert.equal(context.messageInput.value, 'Next draft');
});

test('composer queues an offline message without sending a network request', async () => {
    const context = composerContext(() => assert.fail('Must not send offline'));
    context.navigator.onLine = false;
    let queued;
    context.window.QuantaOfflineQueue = { enqueuePrompt: async prompt => { queued = prompt; return { memoryOnly: true }; } };
    await context.sendMessage();
    assert.equal(queued, 'Draft message');
    assert.equal(context.messageInput.value, '');
    assert.match(context.notice, /Keep it open/);
});

test('offline enqueue preserves edits typed while browser storage is committing', async () => {
    const context = composerContext(() => assert.fail('Must not send offline'));
    context.navigator.onLine = false;
    let finish;
    context.window.QuantaOfflineQueue = { enqueuePrompt: () => new Promise(resolve => { finish = resolve; }) };
    const pending = context.sendMessage();
    context.messageInput.value = 'Next message';
    finish({ memoryOnly: false });
    await pending;
    assert.equal(context.messageInput.value, 'Next message');
    assert.equal(context.sendBtn.disabled, false);
});

test('PWA PNG icons decode to their advertised dimensions and ICO points to valid embedded PNG', () => {
    const manifest = JSON.parse(source('manifest.webmanifest'));
    for (const icon of manifest.icons) {
        const bytes = fs.readFileSync(new URL(`../public${icon.src}`, import.meta.url));
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        assert.equal(icon.sizes, `${width}x${height}`);
        const imageData = [];
        for (let offset = 8; offset < bytes.length;) {
            const size = bytes.readUInt32BE(offset);
            const type = bytes.toString('ascii', offset + 4, offset + 8);
            if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, offset + 8 + size));
            offset += 12 + size;
        }
        assert.equal(inflateSync(Buffer.concat(imageData)).length, height * (width * 4 + 1));
    }
    const ico = fs.readFileSync(new URL('../public/favicon.ico', import.meta.url));
    const pngOffset = ico.readUInt32LE(18);
    assert.equal(ico.subarray(pngOffset, pngOffset + 8).toString('hex'), '89504e470d0a1a0a');
});
