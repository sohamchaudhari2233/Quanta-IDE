import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

// --- F-22: Voice Input Verification ---
test('F-22: voiceInput.js exports VoiceInputManager and VoiceInputController', async () => {
    const voiceModule = await import('../public/js/voiceInput.js');
    assert.ok(voiceModule.VoiceInputManager, 'VoiceInputManager must be exported');
    assert.ok(voiceModule.VoiceInputController, 'VoiceInputController must be exported');
    assert.equal(voiceModule.VoiceInputManager, voiceModule.VoiceInputController, 'Controller must alias Manager');
});

test('F-22: index.html contains #btnVoiceInput and #voiceLangSelect in chat composer', () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.match(html, /id=["']btnVoiceInput["']/, 'Must contain #btnVoiceInput');
    assert.match(html, /id=["']voiceLangSelect["']/, 'Must contain #voiceLangSelect');
    assert.match(html, /class=["']voice-btn["']/, 'Must contain voice-btn CSS class');
});

test('F-22: style.css defines .voice-btn and .listening animation', () => {
    const css = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.match(css, /\.voice-btn/, '.voice-btn style rule must exist');
    assert.match(css, /\.listening/, '.listening state rule must exist');
    assert.match(css, /@keyframes voice-pulse/, 'voice-pulse pulse animation must be declared');
});

// --- F-23: Login 2FA TOTP Verification ---
test('F-23: login.html contains 6-digit TOTP input field', () => {
    const html = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
    assert.match(html, /id=["']totp["']/, 'login.html must contain #totp input');
    assert.match(html, /id=["']totpGroup["']/, 'login.html must contain #totpGroup container');
    assert.match(html, /maxlength=["']6["']/, 'TOTP field must enforce 6 character max length');
    assert.match(html, /autocomplete=["']one-time-code["']/, 'TOTP field must have one-time-code attribute');
});

test('F-23: login.js handles TOTP error message and submits payload', () => {
    const js = fs.readFileSync(path.join(publicDir, 'js', 'login.js'), 'utf8');
    assert.match(js, /totpGroup/, 'login.js must reference totpGroup');
    assert.match(js, /totpInput/, 'login.js must reference totpInput');
    assert.match(js, /includes\(['"]TOTP['"]\)/, 'login.js must detect TOTP error from server');
});

// --- F-24: Service Worker & Asset Routes Verification ---
test('F-24: /assets/antigravity.png and favicon exist in public directory', () => {
    const iconPng = path.join(publicDir, 'assets', 'antigravity.png');
    assert.ok(fs.existsSync(iconPng), 'antigravity.png must exist in public/assets/');
    assert.ok(fs.statSync(iconPng).size > 1000, 'antigravity.png must have valid non-zero byte size');

    const favicon = path.join(publicDir, 'favicon.ico');
    assert.ok(fs.existsSync(favicon), 'favicon.ico must exist in public/');
    assert.ok(fs.statSync(favicon).size > 1000, 'favicon.ico must have valid non-zero byte size');
});

test('F-24: manifest.webmanifest references valid icon routes', () => {
    const manifestRaw = fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    assert.ok(Array.isArray(manifest.icons), 'Manifest must declare icons array');
    assert.ok(manifest.icons.some(i => i.src === '/assets/antigravity.png'), 'Icon must point to /assets/antigravity.png');
});

test('F-24: sw.js defines resilient caching and includes all static assets', () => {
    const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.match(sw, /['"]\/assets\/antigravity\.png['"]/, 'sw.js must cache /assets/antigravity.png');
    assert.match(sw, /['"]\/manifest\.webmanifest['"]/, 'sw.js must cache /manifest.webmanifest');
});

test('F-24: index.html and login.html declare web manifest and icon links', () => {
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.match(indexHtml, /rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']/, 'index.html must link web manifest');
    assert.match(indexHtml, /rel=["']icon["']/, 'index.html must link icon');

    const loginHtml = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
    assert.match(loginHtml, /rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']/, 'login.html must link web manifest');
});
