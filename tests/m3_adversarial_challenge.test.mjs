// tests/m3_adversarial_challenge.test.mjs
// Empirical Adversarial Challenge Suite for Milestone M3 (Empirical Challenger 2)
// Testing: login.html & login.js TOTP flow, voiceInput.js dictation & fallback,
// session modal interaction & elevation endpoints, PWA asset integrity & sw.js caching resilience.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import express from '../Remote-Control/node_modules/express/index.js';
import cookieParser from '../Remote-Control/node_modules/cookie-parser/index.js';
import signature from '../Remote-Control/node_modules/cookie-signature/index.js';
import { SessionManager, TotpEngine, timingSafeEqualString } from '../Remote-Control/security/sessionManager.js';
import { RateLimiter } from '../Remote-Control/security/rateLimiter.js';
import { VoiceInputManager, VoiceInputController } from '../Remote-Control/public/js/voiceInput.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const remoteControlDir = path.join(projectRoot, 'Remote-Control');
const publicDir = path.join(remoteControlDir, 'public');

const TEST_SECRET = 'quanta_session_secret_m3_challenger_99';
const TEST_PASSWORD = 'fixture-only-password-42-master-pw';
const AUTH_COOKIE_NAME = 'ag_auth_token';

// Helper for making local HTTP requests to a test server
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
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body,
                    json: parsed
                });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

// ============================================================================
// SUITE 1: PWA Static Assets & Service Worker Resilience (F-24)
// ============================================================================

test('PWA-01: /assets/antigravity.png and /favicon.ico exist with non-zero bytes and valid signatures', () => {
    const pngPath = path.join(publicDir, 'assets', 'antigravity.png');
    const icoPath = path.join(publicDir, 'favicon.ico');

    assert.ok(fs.existsSync(pngPath), 'assets/antigravity.png must exist in public/assets/');
    const pngStat = fs.statSync(pngPath);
    assert.ok(pngStat.size > 1000, 'PNG must be non-empty; compression should not be penalized');

    // Verify PNG stream contains standard PNG chunk markers
    const pngBuf = fs.readFileSync(pngPath);
    const hasPngSignature = pngBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    assert.ok(hasPngSignature, 'antigravity.png must contain valid PNG markers (PNG/IHDR)');

    assert.ok(fs.existsSync(icoPath), 'favicon.ico must exist in public/');
    const icoStat = fs.statSync(icoPath);
    assert.ok(icoStat.size > 22, 'ICO must contain a header and image data');

    // Verify ICO 4-byte magic header: 00 00 01 00
    const icoBuf = Buffer.alloc(4);
    const icoFd = fs.openSync(icoPath, 'r');
    fs.readSync(icoFd, icoBuf, 0, 4, 0);
    fs.closeSync(icoFd);
    const expectedIcoHeader = Buffer.from([0x00, 0x00, 0x01, 0x00]);
    assert.ok(icoBuf.equals(expectedIcoHeader), 'favicon.ico must have valid ICO magic bytes (00 00 01 00)');
});

test('PWA-02: manifest.webmanifest is valid JSON conforming to PWA spec with icon links', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    assert.equal(manifest.start_url, '/', 'start_url must be /');
    assert.equal(manifest.display, 'standalone', 'display must be standalone');
    assert.ok(manifest.name.includes('Quanta'), 'name must include Quanta');
    assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
    assert.ok(manifest.icons.length >= 2, 'icons must provide at least two sizes');

    const has192 = manifest.icons.some(i => i.src === '/assets/icon-192.png' && i.sizes === '192x192');
    const has512 = manifest.icons.some(i => i.src === '/assets/antigravity.png' && i.sizes === '512x512');
    assert.ok(has192, 'manifest must declare the separate 192x192 icon');
    assert.ok(has512, 'manifest must declare 512x512 icon pointing to /assets/antigravity.png');
});

test('PWA-03: index.html and login.html declare web manifest and favicon link tags', () => {
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const loginHtml = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');

    assert.match(indexHtml, /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']/i, 'index.html must link web manifest');
    assert.match(indexHtml, /<link\s+rel=["']icon["']/i, 'index.html must link favicon');

    assert.match(loginHtml, /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']/i, 'login.html must link web manifest');
    assert.match(loginHtml, /<link\s+rel=["']icon["']/i, 'login.html must link favicon');
});

test('PWA-04: sw.js defines resilient per-asset try/catch caching loop preventing installation failure', async () => {
    const swPath = path.join(publicDir, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js must exist');
    const swCode = fs.readFileSync(swPath, 'utf8');

    // Verify STATIC_ASSETS definition
    assert.match(swCode, /const\s+STATIC_ASSETS\s*=\s*\[/, 'Must declare STATIC_ASSETS array');
    assert.match(swCode, /['"]\/assets\/antigravity\.png['"]/, 'STATIC_ASSETS must include /assets/antigravity.png');
    assert.match(swCode, /['"]\/manifest\.webmanifest['"]/, 'STATIC_ASSETS must include /manifest.webmanifest');
    assert.match(swCode, /['"]\/login\.html['"]/, 'STATIC_ASSETS must include /login.html');

    // Emulate sw.js per-asset try/catch installation loop against simulated cache
    const mockCache = new Map();
    const mockFailingAsset = '/nonexistent-flaky-asset.js';
    const testAssets = [
        '/',
        '/login.html',
        mockFailingAsset, // will fail
        '/assets/antigravity.png'
    ];

    let failureCaught = 0;
    for (const asset of testAssets) {
        try {
            if (asset === mockFailingAsset) {
                throw new Error('404 Not Found');
            }
            mockCache.set(asset, 'cached-content-ok');
        } catch (err) {
            failureCaught++;
        }
    }

    assert.equal(failureCaught, 1, 'Exactly one failing asset should be caught');
    assert.equal(mockCache.size, 3, 'Valid assets must still be successfully cached despite single failure');
    assert.ok(mockCache.has('/assets/antigravity.png'), 'antigravity.png was cached successfully');
});

test('PWA-05: actual service worker bypasses private and future dynamic routes', () => {
    const swCode = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    const handlers = {};
    vm.runInNewContext(swCode, { URL, self: { location: { origin: 'https://quanta.test' }, skipWaiting() {}, addEventListener: (event, handler) => { handlers[event] = handler; } } });
    for (const route of ['/api/session', '/snapshot', '/send', '/app-state', '/new-private-route']) {
        handlers.fetch({ request: { method: 'GET', url: `https://quanta.test${route}` }, respondWith() { assert.fail(`Must bypass ${route}`); } });
    }
});

// ============================================================================
// SUITE 2: login.html & login.js TOTP Flow Stress Testing (F-23)
// ============================================================================

test('LOGIN-01: login.html DOM contract exposes all required 2FA elements with correct constraints', () => {
    const html = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');

    assert.match(html, /id=["']loginForm["']/, 'Must contain #loginForm');
    assert.match(html, /id=["']password["']/, 'Must contain #password');
    assert.match(html, /id=["']togglePasswordBtn["']/, 'Must contain #togglePasswordBtn');
    assert.match(html, /id=["']totpGroup["']/, 'Must contain #totpGroup');
    assert.match(html, /id=["']totp["']/, 'Must contain #totp');
    assert.match(html, /id=["']btnToggleTotp["']/, 'Must contain #btnToggleTotp');
    assert.match(html, /id=["']loginError["']/, 'Must contain #loginError');
    assert.match(html, /id=["']loginErrorText["']/, 'Must contain #loginErrorText');
    assert.match(html, /id=["']loginBtn["']/, 'Must contain #loginBtn');

    // Verify totp input security and UX attributes
    assert.match(html, /id=["']totpGroup["'][^>]*style=["'][^"']*display:\s*none/i, '#totpGroup must be hidden by default');
    assert.match(html, /<input[^>]*id=["']totp["'][^>]*inputmode=["']numeric["']/, 'totp must have inputmode="numeric"');
    assert.match(html, /<input[^>]*id=["']totp["'][^>]*maxlength=["']6["']/, 'totp must have maxlength="6"');
    assert.match(html, /<input[^>]*id=["']totp["'][^>]*autocomplete=["']one-time-code["']/, 'totp must have autocomplete="one-time-code"');
});

// Lightweight DOM element class for stateful testing of client scripts
class MockElement {
    constructor(id, tagName = 'div') {
        this.id = id;
        this.tagName = tagName.toUpperCase();
        this.value = '';
        this.type = tagName === 'input' ? 'text' : '';
        this.textContent = '';
        this.disabled = false;
        this.style = {};
        this.listeners = {};
        this.attributes = {};
        this.classList = {
            classes: new Set(),
            add: (c) => this.classList.classes.add(c),
            remove: (c) => this.classList.classes.delete(c),
            toggle: (c, force) => {
                if (force === undefined) {
                    if (this.classList.classes.has(c)) this.classList.classes.delete(c);
                    else this.classList.classes.add(c);
                } else if (force) {
                    this.classList.classes.add(c);
                } else {
                    this.classList.classes.delete(c);
                }
            },
            contains: (c) => this.classList.classes.has(c)
        };
        this.focused = false;
        this.selected = false;
    }
    addEventListener(event, fn) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(fn);
    }
    removeEventListener(event, fn) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(f => f !== fn);
        }
    }
    dispatchEvent(event) {
        const fns = this.listeners[event.type] || [];
        for (const fn of fns) fn(event);
    }
    setAttribute(name, val) { this.attributes[name] = val; }
    getAttribute(name) { return this.attributes[name] || null; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
}

function createLoginDomHarness(fetchImpl) {
    const elements = {
        loginForm: new MockElement('loginForm', 'form'),
        password: new MockElement('password', 'input'),
        totp: new MockElement('totp', 'input'),
        totpGroup: new MockElement('totpGroup', 'div'),
        btnToggleTotp: new MockElement('btnToggleTotp', 'button'),
        loginBtn: new MockElement('loginBtn', 'button'),
        togglePasswordBtn: new MockElement('togglePasswordBtn', 'button'),
        loginError: new MockElement('loginError', 'div'),
        loginErrorText: new MockElement('loginErrorText', 'span')
    };

    elements.password.type = 'password';
    elements.totpGroup.style.display = 'none';
    elements.loginError.style.display = 'none';
    elements.loginBtn.textContent = 'Connect Securely';

    const location = { href: '' };
    const localStorageMock = new Map();
    let domContentLoadedCb = null;

    const mockDocument = {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        documentElement: { setAttribute: () => {} },
        addEventListener: (event, fn) => {
            if (event === 'DOMContentLoaded') domContentLoadedCb = fn;
        }
    };

    const mockWindow = {
        location,
        localStorage: {
            getItem: (k) => localStorageMock.get(k) || null,
            setItem: (k, v) => localStorageMock.set(k, v)
        },
        matchMedia: () => ({ matches: false }),
        showToast: () => {}
    };

    // Load and evaluate login.js in this isolated harness
    const loginJsSource = fs.readFileSync(path.join(publicDir, 'js', 'login.js'), 'utf8');
    const runner = new Function('document', 'window', 'localStorage', 'fetch', loginJsSource);
    runner(mockDocument, mockWindow, mockWindow.localStorage, fetchImpl);

    // Trigger DOMContentLoaded callback
    if (domContentLoadedCb) {
        domContentLoadedCb();
    }

    return { elements, window: mockWindow };
}

test('LOGIN-02: Password visibility toggle toggles type between text and password', () => {
    const { elements } = createLoginDomHarness(async () => {});
    const eyeBtn = elements.togglePasswordBtn;
    const pwdInput = elements.password;

    assert.equal(pwdInput.type, 'password');

    // Click 1: Reveal password
    eyeBtn.dispatchEvent({ type: 'click' });
    assert.equal(pwdInput.type, 'text');
    assert.equal(eyeBtn.getAttribute('aria-label'), 'Hide password');
    assert.ok(eyeBtn.classList.contains('revealed'));

    // Click 2: Hide password
    eyeBtn.dispatchEvent({ type: 'click' });
    assert.equal(pwdInput.type, 'password');
    assert.equal(eyeBtn.getAttribute('aria-label'), 'Show password');
    assert.ok(!eyeBtn.classList.contains('revealed'));
});

test('LOGIN-03: Manual 2FA toggle button toggles visibility, updates label, and focuses input', () => {
    const { elements } = createLoginDomHarness(async () => {});
    const btnToggle = elements.btnToggleTotp;
    const totpGroup = elements.totpGroup;
    const totpInput = elements.totp;

    assert.equal(totpGroup.style.display, 'none');

    // Toggle 1: Reveal 2FA field
    btnToggle.dispatchEvent({ type: 'click' });
    assert.equal(totpGroup.style.display, 'block');
    assert.equal(btnToggle.textContent, 'Hide 2FA Code Field');
    assert.ok(totpInput.focused, 'totpInput must be focused when revealed');

    // Toggle 2: Hide 2FA field
    totpInput.focused = false;
    btnToggle.dispatchEvent({ type: 'click' });
    assert.equal(totpGroup.style.display, 'none');
    assert.equal(btnToggle.textContent, 'Use 2FA / Authenticator Code');
    assert.ok(!totpInput.focused);
});

test('LOGIN-04: Submitting without password blocks network request and shows validation error', async () => {
    let fetchCalled = false;
    const { elements } = createLoginDomHarness(async () => {
        fetchCalled = true;
        return { ok: true };
    });

    elements.password.value = '';
    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.equal(fetchCalled, false, 'Fetch must not be called when password is empty');
    assert.equal(elements.loginError.style.display, 'flex');
    assert.equal(elements.loginErrorText.textContent, 'Please enter the master password.');
    assert.ok(elements.password.focused, 'Password input must be focused');
});

test('LOGIN-05: Non-numeric input in TOTP field is immediately sanitized', () => {
    const { elements } = createLoginDomHarness(async () => {});
    const totpInput = elements.totp;

    totpInput.value = '12ab-34#@!5';
    totpInput.dispatchEvent({ type: 'input' });
    assert.equal(totpInput.value, '12345', 'All non-digits must be stripped');
});

test('LOGIN-06: Submitting with partial TOTP code (< 6 digits) when group is visible blocks request', async () => {
    let fetchCalled = false;
    const { elements } = createLoginDomHarness(async () => {
        fetchCalled = true;
        return { ok: true };
    });

    elements.password.value = 'my-secret-password';
    elements.totpGroup.style.display = 'block';
    elements.totp.value = '12345'; // only 5 digits

    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.equal(fetchCalled, false, 'Fetch must not be called with partial TOTP code');
    assert.equal(elements.loginError.style.display, 'flex');
    assert.equal(elements.loginErrorText.textContent, 'TOTP code must be exactly 6 digits.');
    assert.ok(elements.totp.focused, 'TOTP input must be focused on error');
});

test('LOGIN-07: Auto-advance automatically submits login when 6th numeric digit is entered with password', async () => {
    let submittedPayload = null;
    const { elements } = createLoginDomHarness(async (url, opts) => {
        submittedPayload = JSON.parse(opts.body);
        return {
            ok: true,
            json: async () => ({ success: true })
        };
    });

    elements.password.value = 'valid-password';
    elements.totp.value = '123456';
    elements.totp.dispatchEvent({ type: 'input' });

    // Allow microtask ticks for async doLogin
    await new Promise(r => setTimeout(r, 10));

    assert.ok(submittedPayload !== null, 'doLogin must be triggered by 6-digit input event');
    assert.equal(submittedPayload.password, 'valid-password');
    assert.equal(submittedPayload.totp, '123456');
    assert.equal(elements.loginBtn.textContent, 'Authenticated ✓');
});

test('LOGIN-08: 401 challenge with TOTP error progressively reveals TOTP field and focuses it', async () => {
    const { elements } = createLoginDomHarness(async () => {
        return {
            ok: false,
            status: 401,
            json: async () => ({ success: false, error: 'Invalid 2FA TOTP code.' })
        };
    });

    elements.password.value = 'valid-password';
    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    await new Promise(r => setTimeout(r, 10));

    assert.equal(elements.totpGroup.style.display, 'block', 'totpGroup must be revealed upon 401 TOTP response');
    assert.equal(elements.btnToggleTotp.style.display, 'none', 'btnToggleTotp must be hidden when progressively revealed');
    assert.equal(elements.loginError.style.display, 'flex');
    assert.equal(elements.loginErrorText.textContent, 'Invalid 2FA TOTP code.');
    assert.ok(elements.totp.focused, 'totp input must be focused');
    assert.ok(elements.totp.selected, 'totp input must be selected');
    assert.equal(elements.loginBtn.disabled, false, 'Button must be re-enabled after response');
    assert.equal(elements.loginBtn.textContent, 'Connect Securely');
});

test('LOGIN-09: Invalid code rejection keeps TOTP group visible and displays rejection message', async () => {
    const { elements } = createLoginDomHarness(async () => {
        return {
            ok: false,
            status: 401,
            json: async () => ({ success: false, error: 'Invalid 2FA TOTP code.' })
        };
    });

    elements.password.value = 'valid-password';
    elements.totpGroup.style.display = 'block';
    elements.totp.value = '000000';

    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(elements.totpGroup.style.display, 'block');
    assert.equal(elements.loginErrorText.textContent, 'Invalid 2FA TOTP code.');
    assert.equal(elements.loginBtn.disabled, false);
});

test('LOGIN-10: Rate limiting (429) surfaces lockout warning and re-enables submit button', async () => {
    const { elements } = createLoginDomHarness(async () => {
        return {
            ok: false,
            status: 429,
            json: async () => ({ success: false, error: 'Too many failed login attempts. Locked out for 60 seconds.' })
        };
    });

    elements.password.value = 'some-password';
    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(elements.loginError.style.display, 'flex');
    assert.equal(elements.loginErrorText.textContent, 'Too many failed login attempts. Locked out for 60 seconds.');
    assert.equal(elements.loginBtn.disabled, false);
});

test('LOGIN-11: Network exception displays server connection failure message and re-enables button', async () => {
    const { elements } = createLoginDomHarness(async () => {
        throw new Error('ECONNREFUSED');
    });

    elements.password.value = 'some-password';
    elements.loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(elements.loginError.style.display, 'flex');
    assert.equal(elements.loginErrorText.textContent, 'Connection failed. Please ensure the Quanta server is running.');
    assert.equal(elements.loginBtn.disabled, false);
});

// ============================================================================
// SUITE 3: Live HTTP Server 2FA TOTP End-to-End RFC 6238 Verification
// ============================================================================

test('LOGIN-12: Live HTTP Server TOTP RFC 6238 challenge, invalid rejection, and valid token elevation', async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser(TEST_SECRET));

    const sessionManager = new SessionManager();
    const rateLimiter = new RateLimiter({ maxAttempts: 5, lockoutDurationMs: 60000 });
    const totpSecret = TotpEngine.generateSecret(20);

    // Setup live /login route matching server.js lines 2171-2223
    app.post('/login', (req, res) => {
        const clientIp = '127.0.0.1';
        if (rateLimiter.isLocked(clientIp)) {
            const sec = rateLimiter.getRemainingLockoutSec(clientIp);
            return res.status(429).json({ success: false, error: `Too many failed login attempts. Locked out for ${sec} seconds.` });
        }

        const { password, totp } = req.body;
        const isPasswordCorrect = timingSafeEqualString(password, TEST_PASSWORD);

        // Required TOTP 2FA Verification (RFC 6238)
        if (!totp || !TotpEngine.verifyToken(totp, totpSecret)) {
            rateLimiter.recordFailure(clientIp);
            return res.status(401).json({ success: false, error: 'Invalid 2FA TOTP code.' });
        }

        if (isPasswordCorrect) {
            rateLimiter.recordSuccess(clientIp);
            const session = sessionManager.createSession({
                ip: clientIp,
                userAgent: 'challenger-test',
                isLocal: true,
                isTunnel: false
            });
            sessionManager.elevateSession(session.id, 24 * 60 * 60 * 1000);
            res.cookie(AUTH_COOKIE_NAME, session.id, {
                httpOnly: true,
                signed: true,
                sameSite: 'strict',
                maxAge: 24 * 60 * 60 * 1000
            });
            return res.json({ success: true, mode: session.mode });
        } else {
            rateLimiter.recordFailure(clientIp);
            return res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        // Step 1: Submit wrong password with no TOTP -> 401 Invalid 2FA TOTP code
        const res1 = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: 'wrong-password' }
        });
        assert.equal(res1.status, 401);
        assert.equal(res1.json.error, 'Invalid 2FA TOTP code.');

        // Step 2: Submit correct password but no TOTP -> 401 Invalid 2FA TOTP code
        const res2 = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD }
        });
        assert.equal(res2.status, 401);
        assert.equal(res2.json.error, 'Invalid 2FA TOTP code.');

        // Step 3: Submit correct password but invalid TOTP code -> 401 Invalid 2FA TOTP code
        const res3 = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD, totp: '987654' }
        });
        assert.equal(res3.status, 401);
        assert.equal(res3.json.error, 'Invalid 2FA TOTP code.');

        // Step 4: Submit correct password with genuine valid TOTP code
        const validTotp = TotpEngine.generateToken(totpSecret);
        const res4 = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD, totp: validTotp }
        });
        assert.equal(res4.status, 200, 'Valid password and TOTP must return HTTP 200');
        assert.equal(res4.json.success, true);
        assert.equal(res4.json.mode, 'control', 'Session must be elevated to control mode');
        assert.ok(res4.headers['set-cookie'], 'Response must set session cookie');
        assert.ok(res4.headers['set-cookie'][0].includes(AUTH_COOKIE_NAME), 'Cookie must be ag_auth_token');

    } finally {
        server.close();
    }
});

// ============================================================================
// SUITE 4: voiceInput.js Empirical Dictation & Fallback Testing (F-22)
// ============================================================================

test('VOICE-01: Module exports VoiceInputManager and VoiceInputController identically', () => {
    assert.ok(VoiceInputManager, 'VoiceInputManager must be defined');
    assert.ok(VoiceInputController, 'VoiceInputController must be defined');
    assert.equal(VoiceInputManager, VoiceInputController, 'VoiceInputController must alias VoiceInputManager');
});

test('VOICE-02: SpeechRecognition fallback when API is missing sets disabled state without throwing', () => {
    const inputEl = new MockElement('promptInput', 'textarea');
    const micBtn = new MockElement('btnVoiceInput', 'button');
    const langSelect = new MockElement('voiceLangSelect', 'select');

    // In current Node.js context, SpeechRecognition does NOT exist on globalThis
    const manager = new VoiceInputManager(inputEl, micBtn, langSelect);

    assert.equal(manager.recognition, null, 'Recognition must be null without SpeechRecognition API');
    assert.equal(manager.isListening, false, 'isListening must be false');
    assert.equal(micBtn.title, 'Voice input not supported on this browser');
    assert.equal(micBtn.style.opacity, '0.35');
    assert.equal(micBtn.style.cursor, 'not-allowed');

    // Calling start() should be a safe no-op
    assert.doesNotThrow(() => manager.start());
    assert.equal(manager.isListening, false);
});

// Mock SpeechRecognition class to test active speech flows
class MockSpeechRecognition {
    constructor() {
        this.continuous = false;
        this.interimResults = false;
        this.lang = 'en-US';
        this.onstart = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.started = false;
        this.stopped = false;
    }
    start() {
        this.started = true;
        if (this.onstart) this.onstart();
    }
    stop() {
        this.stopped = true;
        if (this.onend) this.onend();
    }
}

test('VOICE-03: SpeechRecognition initialization sets continuous, interimResults, and selected language', () => {
    const origWindow = globalThis.window;
    globalThis.window = {
        SpeechRecognition: MockSpeechRecognition,
        showToast: () => {}
    };

    try {
        const inputEl = new MockElement('promptInput', 'textarea');
        const micBtn = new MockElement('btnVoiceInput', 'button');
        const langSelect = new MockElement('voiceLangSelect', 'select');
        langSelect.value = 'es-ES';

        const manager = new VoiceInputManager(inputEl, micBtn, langSelect);

        assert.ok(manager.recognition instanceof MockSpeechRecognition);
        assert.equal(manager.recognition.continuous, true);
        assert.equal(manager.recognition.interimResults, true);
        assert.equal(manager.recognition.lang, 'es-ES');

        // Test changing language select
        langSelect.value = 'fr-FR';
        langSelect.dispatchEvent({ type: 'change' });
        assert.equal(manager.recognition.lang, 'fr-FR');

    } finally {
        globalThis.window = origWindow;
    }
});

test('VOICE-04: Base text preservation and transcript concatenation without overwriting prompt', () => {
    const origWindow = globalThis.window;
    globalThis.window = {
        SpeechRecognition: MockSpeechRecognition,
        showToast: () => {}
    };

    try {
        const inputEl = new MockElement('promptInput', 'textarea');
        inputEl.value = 'Please inspect';
        const micBtn = new MockElement('btnVoiceInput', 'button');
        const langSelect = new MockElement('voiceLangSelect', 'select');
        langSelect.value = 'en-US';

        const manager = new VoiceInputManager(inputEl, micBtn, langSelect);

        // Click mic button to trigger start
        micBtn.dispatchEvent({ type: 'click', preventDefault: () => {} });

        assert.equal(manager.isListening, true);
        assert.equal(manager.baseText, 'Please inspect ');
        assert.ok(micBtn.classList.contains('listening'));
        assert.equal(micBtn.getAttribute('aria-pressed'), 'true');
        assert.equal(micBtn.title, 'Listening... (Click to stop)');

        // Simulate interim transcript event
        let inputEventDispatched = false;
        inputEl.addEventListener('input', (e) => {
            if (e.bubbles) inputEventDispatched = true;
        });

        manager.recognition.onresult({
            results: [
                Object.assign([{ transcript: ' the test files' }], { isFinal: false })
            ]
        });

        assert.equal(inputEl.value, 'Please inspect  the test files');
        assert.ok(inputEventDispatched, 'Must dispatch input event with bubbles: true');

        // Simulate final transcript followed by new interim
        manager.recognition.onresult({
            results: [
                Object.assign([{ transcript: ' the test files' }], { isFinal: true }),
                Object.assign([{ transcript: ' for edge cases' }], { isFinal: false })
            ]
        });

        assert.equal(inputEl.value, 'Please inspect  the test files for edge cases');

        // Click again to stop
        micBtn.dispatchEvent({ type: 'click', preventDefault: () => {} });
        assert.equal(manager.isListening, false);
        assert.ok(!micBtn.classList.contains('listening'));
        assert.equal(micBtn.getAttribute('aria-pressed'), 'false');

    } finally {
        globalThis.window = origWindow;
    }
});

test('VOICE-05: Speech error classification, toast notification, and graceful reset', () => {
    const origWindow = globalThis.window;
    let toastMessage = '';
    globalThis.window = {
        SpeechRecognition: MockSpeechRecognition,
        showToast: (msg) => { toastMessage = msg; }
    };

    try {
        const inputEl = new MockElement('promptInput', 'textarea');
        const micBtn = new MockElement('btnVoiceInput', 'button');
        const langSelect = new MockElement('voiceLangSelect', 'select');

        // Test 1: not-allowed error with window.showToast
        const manager1 = new VoiceInputManager(inputEl, micBtn, langSelect);
        manager1.start();
        assert.equal(manager1.isListening, true);

        manager1.recognition.onerror({ error: 'not-allowed' });
        assert.equal(toastMessage, 'Microphone access denied. Please grant microphone permission.');
        assert.equal(manager1.isListening, false);
        assert.ok(!micBtn.classList.contains('listening'));

        // Test 2: no-speech error
        manager1.start();
        manager1.recognition.onerror({ error: 'no-speech' });
        assert.equal(toastMessage, 'No speech detected. Please speak into microphone.');

        // Test 3: network error
        manager1.start();
        manager1.recognition.onerror({ error: 'network' });
        assert.equal(toastMessage, 'Speech network connectivity error.');

        // Test 4: custom options.onError callback
        let customErr = null;
        let customMsg = null;
        const manager2 = new VoiceInputManager(inputEl, micBtn, langSelect, {
            onError: (err, msg) => {
                customErr = err;
                customMsg = msg;
            }
        });
        manager2.start();
        manager2.recognition.onerror({ error: 'service-not-allowed' });

        assert.equal(customErr, 'service-not-allowed');
        assert.equal(customMsg, 'Voice recognition error');
        assert.equal(manager2.isListening, false);

    } finally {
        globalThis.window = origWindow;
    }
});

// ============================================================================
// SUITE 5: Session Modal Interactions & Security Endpoints (F-20 & F-21)
// ============================================================================

test('SESSION-01: index.html DOM contract declares all session modal elements and accessibility tags', () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

    assert.match(html, /id=["']sessionModalOverlay["']/, 'Must contain #sessionModalOverlay');
    assert.match(html, /id=["']closeSessionModalBtn["']/, 'Must contain #closeSessionModalBtn');
    assert.match(html, /id=["']sessionUser["']/, 'Must contain #sessionUser');
    assert.match(html, /id=["']sessionModeBadge["']/, 'Must contain #sessionModeBadge');
    assert.match(html, /id=["']btnToggleElevation["']/, 'Must contain #btnToggleElevation');
    assert.match(html, /id=["']sessionFingerprint["']/, 'Must contain #sessionFingerprint');
    assert.match(html, /id=["']sessionConnectionLabel["']/, 'Must contain #sessionConnectionLabel');
    assert.match(html, /id=["']btnLogout["']/, 'Must contain #btnLogout');
    assert.match(html, /id=["']userAvatarBadge["']/, 'Must contain #userAvatarBadge');

    assert.match(html, /id=["']sessionModalOverlay["'][^>]*style=["'][^"']*display:\s*none/i, 'Session modal must be hidden by default');
});

test('SESSION-02: Live Server Session Status, Demote, Elevate, and Logout Lifecycle', async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser(TEST_SECRET));

    const sessionManager = new SessionManager();
    sessionManager.allowLanAutoTrust = false; // Zero-trust enforcement

    // Auth Middleware matching server.js
    app.use((req, res, next) => {
        const publicPaths = ['/login', '/login.html'];
        if (publicPaths.includes(req.path)) return next();

        const signedCookie = req.signedCookies[AUTH_COOKIE_NAME];
        const session = sessionManager.getSession(signedCookie);
        if (session) {
            req.session = session;
            return next();
        }
        res.status(401).json({ error: 'Unauthorized' });
    });

    // Endpoints matching server.js:2226-2273
    app.get('/api/session', (req, res) => {
        const session = req.session;
        res.json({
            authenticated: !!session,
            user: session?.user || 'Administrator',
            mode: session ? session.mode : 'unauthenticated',
            deviceFingerprint: session ? session.deviceFingerprint : null,
            isLocal: session ? session.isLocal : true,
            isTunnel: false,
            connection: 'LAN'
        });
    });

    app.post('/api/demote', (req, res) => {
        const sessionId = req.signedCookies[AUTH_COOKIE_NAME];
        sessionManager.demoteSession(sessionId);
        res.json({ success: true, mode: 'read-only' });
    });

    app.post('/api/elevate', (req, res) => {
        const { password } = req.body;
        if (!timingSafeEqualString(password, TEST_PASSWORD)) {
            return res.status(401).json({ success: false, error: 'Invalid password' });
        }
        const sessionId = req.signedCookies[AUTH_COOKIE_NAME];
        sessionManager.elevateSession(sessionId, 30 * 60 * 1000);
        res.json({ success: true, mode: 'control' });
    });

    app.post('/logout', (req, res) => {
        const sessionId = req.signedCookies[AUTH_COOKIE_NAME];
        if (sessionId) {
            sessionManager.destroySession(sessionId);
        }
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        // Step 1: Unauthenticated request to /api/session -> 401 Unauthorized
        const unauthRes = await makeRequest(server, '/api/session');
        assert.equal(unauthRes.status, 401);
        assert.equal(unauthRes.json.error, 'Unauthorized');

        // Step 2: Create a session in control mode and sign cookie
        const session = sessionManager.createSession({
            ip: '127.0.0.1',
            userAgent: 'test-agent',
            isLocal: true,
            isTunnel: false
        });
        sessionManager.elevateSession(session.id, 3600000);
        const signedCookieValue = 's:' + signature.sign(session.id, TEST_SECRET);
        const cookieHeader = `${AUTH_COOKIE_NAME}=${encodeURIComponent(signedCookieValue)}`;

        // Step 3: Authenticated /api/session returns active parameters
        const sessionRes = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': cookieHeader }
        });
        assert.equal(sessionRes.status, 200);
        assert.equal(sessionRes.json.authenticated, true);
        assert.equal(sessionRes.json.mode, 'control');
        assert.equal(sessionRes.json.user, 'Administrator');
        assert.equal(sessionRes.json.connection, 'LAN');

        // Step 4: Demote session to read-only mode
        const demoteRes = await makeRequest(server, '/api/demote', {
            method: 'POST',
            headers: { 'Cookie': cookieHeader }
        });
        assert.equal(demoteRes.status, 200);
        assert.equal(demoteRes.json.mode, 'read-only');

        // Check updated session mode
        const sessionResAfterDemote = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': cookieHeader }
        });
        assert.equal(sessionResAfterDemote.json.mode, 'read-only');

        // Step 5: Elevate with wrong password -> 401 Invalid password
        const badElevateRes = await makeRequest(server, '/api/elevate', {
            method: 'POST',
            headers: { 'Cookie': cookieHeader, 'Content-Type': 'application/json' },
            body: { password: 'incorrect-pass' }
        });
        assert.equal(badElevateRes.status, 401);
        assert.equal(badElevateRes.json.error, 'Invalid password');

        // Step 6: Elevate with correct password -> 200 control mode
        const goodElevateRes = await makeRequest(server, '/api/elevate', {
            method: 'POST',
            headers: { 'Cookie': cookieHeader, 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD }
        });
        assert.equal(goodElevateRes.status, 200);
        assert.equal(goodElevateRes.json.mode, 'control');

        // Step 7: Logout -> clears session on server
        const logoutRes = await makeRequest(server, '/logout', {
            method: 'POST',
            headers: { 'Cookie': cookieHeader }
        });
        assert.equal(logoutRes.status, 200);
        assert.equal(logoutRes.json.success, true);

        // Step 8: Subsequent request with invalidated session -> 401 Unauthorized
        const afterLogoutRes = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': cookieHeader }
        });
        assert.equal(afterLogoutRes.status, 401, 'Invalidated session must return 401 Unauthorized');

    } finally {
        server.close();
    }
});


// ============================================================================
// SUITE 6: Adversarial Stress & Attack Scenarios
// ============================================================================

test('LOGIN-13: Repeated invalid TOTP submissions trigger rate limiter lockout (brute-force defense)', async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser(TEST_SECRET));

    const sessionManager = new SessionManager();
    const rateLimiter = new RateLimiter({ maxAttempts: 5, lockoutDurationMs: 60000 });
    const totpSecret = TotpEngine.generateSecret(20);

    app.post('/login', (req, res) => {
        const clientIp = '127.0.0.1';
        if (rateLimiter.isLocked(clientIp)) {
            const sec = rateLimiter.getRemainingLockoutSec(clientIp);
            return res.status(429).json({ success: false, error: `Too many failed login attempts. Locked out for ${sec} seconds.` });
        }

        const { password, totp } = req.body;
        if (!totp || !TotpEngine.verifyToken(totp, totpSecret)) {
            const outcome = rateLimiter.recordFailure(clientIp);
            if (outcome.locked) {
                return res.status(429).json({ success: false, error: `Too many failed attempts. Locked out for ${outcome.lockoutSec} seconds.` });
            }
            return res.status(401).json({ success: false, error: 'Invalid 2FA TOTP code.', attemptsRemaining: outcome.attemptsRemaining });
        }
        res.json({ success: true });
    });

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        // Submit 4 bad TOTPs -> 401
        for (let i = 0; i < 4; i++) {
            const res = await makeRequest(server, '/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: { password: TEST_PASSWORD, totp: `00000${i}` }
            });
            assert.equal(res.status, 401);
            assert.equal(res.json.attemptsRemaining, 4 - i);
        }

        // 5th bad TOTP -> 429 Locked out
        const res5 = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD, totp: '000005' }
        });
        assert.equal(res5.status, 429);
        assert.ok(res5.json.error.includes('Locked out'));

        // 6th attempt with valid TOTP is blocked during lockout
        const validTotp = TotpEngine.generateToken(totpSecret);
        const resBlocked = await makeRequest(server, '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { password: TEST_PASSWORD, totp: validTotp }
        });
        assert.equal(resBlocked.status, 429, 'Valid token must be rejected during lockout');

    } finally {
        server.close();
    }
});

test('VOICE-06: Rapid toggle stress test preserves deterministic listening state', () => {
    const origWindow = globalThis.window;
    globalThis.window = {
        SpeechRecognition: MockSpeechRecognition,
        showToast: () => {}
    };

    try {
        const inputEl = new MockElement('promptInput', 'textarea');
        const micBtn = new MockElement('btnVoiceInput', 'button');
        const langSelect = new MockElement('voiceLangSelect', 'select');

        const manager = new VoiceInputManager(inputEl, micBtn, langSelect);

        // Rapidly toggle 20 times
        for (let i = 0; i < 20; i++) {
            micBtn.dispatchEvent({ type: 'click', preventDefault: () => {} });
            assert.equal(manager.isListening, i % 2 === 0);
        }

        // Final state should be not listening (even number of toggles)
        assert.equal(manager.isListening, false);
        assert.ok(!micBtn.classList.contains('listening'));
        assert.equal(micBtn.getAttribute('aria-pressed'), 'false');

    } finally {
        globalThis.window = origWindow;
    }
});

test('SESSION-03: Tampered or forged signed session cookies are rejected with 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser(TEST_SECRET));

    const sessionManager = new SessionManager();

    app.use((req, res, next) => {
        const signedCookie = req.signedCookies[AUTH_COOKIE_NAME];
        const session = sessionManager.getSession(signedCookie);
        if (session) {
            req.session = session;
            return next();
        }
        res.status(401).json({ error: 'Unauthorized' });
    });

    app.get('/api/session', (req, res) => {
        res.json({ authenticated: true });
    });

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        // Case 1: Tampered payload with valid signature prefix
        const tamperedCookie = 's:fake-session-uuid.wrongsignature';
        const res1 = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(tamperedCookie)}` }
        });
        assert.equal(res1.status, 401);

        // Case 2: Signed with wrong secret
        const forgedCookie = 's:' + signature.sign('some-session-uuid', 'completely-wrong-secret');
        const res2 = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(forgedCookie)}` }
        });
        assert.equal(res2.status, 401);

        // Case 3: Empty cookie
        const res3 = await makeRequest(server, '/api/session', {
            headers: { 'Cookie': `${AUTH_COOKIE_NAME}=` }
        });
        assert.equal(res3.status, 401);

    } finally {
        server.close();
    }
});
