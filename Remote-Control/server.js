#!/usr/bin/env node
import './core/environment.js';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import path, { dirname, join } from 'path';
import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { parseMultipart } from './ide/multipart.js';
import { inspectUI } from './ui_inspector.js';
import { execSync } from 'child_process';
import { RateLimiter, getClientIp } from './security/rateLimiter.js';
import { timingSafeEqualString, validatePasswordSecurity, TotpEngine, SessionManager } from './security/sessionManager.js';
import { auditLogger } from './security/auditLogger.js';
import { verifyCdpSecurity } from './security/cdpCheck.js';
import { eventBus } from './core/eventBus.js';
import { approvalManager } from './agent/approvalManager.js';
import { taskQueue } from './agent/taskQueue.js';
import { checkpointManager } from './agent/checkpoints.js';
import { fileBrowser } from './ide/fileBrowser.js';
import { quickActionRunner } from './ide/quickActions.js';
import { imageUploader } from './ide/imageUpload.js';
import { telegramBot } from './notifications/telegramBot.js';
import { webhookDispatcher } from './webhooks/webhookDispatcher.js';
import { pluginHost } from './plugins/pluginHost.js';
import { tunnelSupervisor } from './connectivity/tunnelSupervisor.js';
import { canUseDemoLogin } from './security/demoAccess.js';
import { isLocalRequest, isSameOrigin, asyncRoute, apiErrorHandler } from './security/requestPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findAntigravityPort() {
    try {
        if (process.platform === 'win32') {
            const cmd = 'powershell -Command "Get-NetTCPConnection -State Listen | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -like \'*Antigravity*\' } | Select-Object -ExpandProperty LocalPort"';
            const output = execSync(cmd, { encoding: 'utf-8' }).trim();
            if (output) {
                const ports = output.split(/\r?\n/).map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p !== 3000);
                if (ports.length > 0) {
                    return [...new Set(ports)];
                }
            }
        } else {
            const cmd = 'lsof -i -P -n | grep -i Antigravity | grep -i LISTEN';
            const output = execSync(cmd, { encoding: 'utf-8' }).trim();
            const ports = [];
            const lines = output.split('\n');
            for (const line of lines) {
                const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                if (match) {
                    const port = parseInt(match[1], 10);
                    if (port && port !== 3000) ports.push(port);
                }
            }
            if (ports.length > 0) {
                return [...new Set(ports)];
            }
        }
    } catch (e) {}
    return [9000, 9001, 9002, 9003];
}

const PORTS = process.env.CDP_PORT ? [Number(process.env.CDP_PORT)] : findAntigravityPort();
const POLL_INTERVAL = 500;
const SERVER_PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const SESSION_SECRET = process.env.SESSION_SECRET && !/^your-|^antigravity_secret_key_1337$/.test(process.env.SESSION_SECRET)
    ? process.env.SESSION_SECRET : randomBytes(32).toString('hex');
if (!Number.isInteger(SERVER_PORT) || SERVER_PORT < 1 || SERVER_PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!validatePasswordSecurity(APP_PASSWORD, true).valid) throw new Error('Configure a strong APP_PASSWORD first: run npm run setup');
const AUTH_COOKIE_NAME = 'ag_auth_token';
const rateLimiter = new RateLimiter({ maxAttempts: 5, lockoutDurationMs: 15 * 60 * 1000 });
const sessionManager = new SessionManager({
    requirePairing: process.env.REQUIRE_DEVICE_PAIRING === 'true',
    allowLanAutoTrust: process.env.ALLOW_LAN_AUTO_TRUST === 'true'
});

telegramBot.setManagers({ approvalManager, taskQueue });
pluginHost.setQuickActionRegistrar(quickActionRunner);

// Read-Only vs Control Mode Enforcer Middleware
const requireControlMode = (req, res, next) => {
    const session = req.session;
    if (!session || session.mode !== 'control') {
        return res.status(403).json({
            error: 'Action disallowed: Session is in read-only mode. Please elevate to control mode.',
            mode: 'read-only'
        });
    }
    next();
};

// Security warning for default credentials
if (APP_PASSWORD === 'antigravity') {
    console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default APP_PASSWORD ("antigravity").');
    console.warn('\x1b[33m%s\x1b[0m', '   Set a strong APP_PASSWORD in your .env file for production use.\n');
}

// Note: hashString is defined later, so we will initialize the token inside createServer.
let AUTH_TOKEN = null;


// Shared CDP connection
let cdpConnection = null;
let lastSnapshot = null;
let lastSnapshotHash = null;

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('CDP discovery timed out')));
    });
}

// Find Antigravity CDP endpoint
// Find Antigravity CDP endpoint
async function discoverCDP() {
    const errors = [];
    const portsList = PORTS;
    for (const port of portsList) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // Priority 1: Standard Workbench (The main window)
            const workbench = list.find(t => t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            if (workbench && workbench.webSocketDebuggerUrl) {
                console.log('Found Workbench target:', workbench.title);
                return { port, url: workbench.webSocketDebuggerUrl };
            }

            // Priority 2: Jetski/Launchpad (Fallback)
            const jetski = list.find(t => t.url?.includes('jetski') || t.title === 'Launchpad');
            if (jetski && jetski.webSocketDebuggerUrl) {
                console.log('Found Jetski/Launchpad target:', jetski.title);
                return { port, url: jetski.webSocketDebuggerUrl };
            }

            // Priority 3: Active Antigravity Chat conversation pages (fallback)
            const activeChat = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && (t.url?.includes('/c/') || t.url?.includes('/chat') || t.url?.includes('/conversation')));
            if (activeChat && activeChat.webSocketDebuggerUrl) {
                console.log('Found active chat target:', activeChat.title, 'URL:', activeChat.url);
                return { port, url: activeChat.webSocketDebuggerUrl };
            }

            // Priority 4: Any local page target
            const localPage = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && (t.url?.includes('localhost') || t.url?.includes('127.0.0.1')));
            if (localPage && localPage.webSocketDebuggerUrl) {
                console.log('Found local page target:', localPage.title, 'URL:', localPage.url);
                return { port, url: localPage.webSocketDebuggerUrl };
            }

            // Priority 5: First available target with debugger URL
            const firstAvailable = list.find(t => t.webSocketDebuggerUrl);
            if (firstAvailable && firstAvailable.webSocketDebuggerUrl) {
                console.log('Found first available target:', firstAvailable.title, 'URL:', firstAvailable.url);
                return { port, url: firstAvailable.webSocketDebuggerUrl };
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`CDP not found. ${errorSummary}`);
}

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, contexts };
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(async () => {
        const cascade = document.getElementById('conversation') || 
                        document.getElementById('chat') || 
                        document.getElementById('cascade') ||
                        document.querySelector('.scrollbar-hide.px-4') ||
                        document.querySelector('[class*=\"scrollbar-hide\"][class*=\"px-\"]');
        if (!cascade) {
            // Debug info
            const body = document.body;
            const childIds = Array.from(body ? body.children : []).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Mark fixed/absolute elements in the original DOM before cloning
        // This is the only way to reliably catch CSS-class-based positioning
        const candidates = cascade.querySelectorAll('*');
        candidates.forEach(el => {
            try {
                const pos = window.getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'absolute') {
                    el.setAttribute('data-ag-rem', 'true');
                }
            } catch(e) {}
        });

        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        
        // Clean up markers from the original DOM immediately after cloning
        candidates.forEach(el => el.removeAttribute('data-ag-rem'));
        
        // Aggressively remove the entire interaction/input/review area
        try {
            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]',
                '[data-lexical-editor]',
                'form',
                // New aggressive selectors for recent Antigravity versions
                '.mx-8.mb-8',
                '.mx-4.mb-4',
                '.fixed.bottom-0',
                '.absolute.bottom-0'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // Protect elements that contain interactive buttons the user might need
                        const text = (el.innerText || '').toLowerCase();
                        const isActionArea = text.includes('allow') || text.includes('deny') || 
                                           text.includes('review') || text.includes('run') ||
                                           text.includes('confirm');
                        
                        // BUT: If it's specifically an input-related element, we DON'T protect it
                        const isEditor = el.getAttribute('contenteditable') === 'true' || 
                                       el.hasAttribute('data-lexical-editor') ||
                                       text.includes('ask anything') ||
                                       text.includes('to mention');
                        if (!isEditor && isActionArea && selector !== '[contenteditable="true"]') {
                            return; // Protect action bars
                        }

                        // For the editor or its container, remove it
                        // Go up to find the main floating box if it's a deep selector
                        let targetToRemove = el;
                        if (isEditor || selector.includes('bottom-0')) {
                             // Find the common container for the input box (usually has margins or padding)
                             let parent = el.parentElement;
                             for (let i = 0; i < 4; i++) {
                                 if (!parent || parent === clone) break;
                                 const pCls = (parent.className || '').toString();
                                 if (pCls.includes('mx-') || pCls.includes('mb-') || pCls.includes('bg-')) {
                                     targetToRemove = parent;
                                 }
                                 parent = parent.parentElement;
                             }
                        }
                        
                        if (targetToRemove && targetToRemove !== clone) {
                            targetToRemove.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            // 2. Text-based cleanup for stray status bars and redundant desktop inputs
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const isInputPlaceholder = text.includes('ask anything') || 
                                              text.includes('to mention') || 
                                              placeholder.includes('ask anything');
                    
                    // IF it's the main chat box (contains placeholder text), remove its container
                    if (isInputPlaceholder) {
                        // Find the container (usually a few levels up)
                        let container = el;
                        for (let i = 0; i < 5; i++) {
                            if (!container.parentElement || container.parentElement === clone) break;
                            const cls = (container.className || '').toString();
                            if (cls.includes('flex-col') || cls.includes('input') || cls.includes('area')) {
                                container.remove();
                                return;
                            }
                            container = container.parentElement;
                        }
                        el.remove();
                        return;
                    }
                } catch(e) {}
            });

            // 3. NUCLEAR: If any editor or redundant UI remains, remove its entire branch
            const redundantElements = clone.querySelectorAll('[contenteditable="true"], [data-lexical-editor], [role="textbox"], form, .mx-8.mb-8, .mx-4.mb-4');
            redundantElements.forEach(el => {
                try {
                    let branch = el;
                    // Go up to find the highest container that is still within the clone
                    // This ensures we remove the entire "box" (with chips, submit btn, etc)
                    while (branch.parentElement && branch.parentElement !== clone) {
                        const p = branch.parentElement;
                        const pCls = (p.className || '').toString().toLowerCase();
                        // Stop going up if we hit a main message/conversation wrapper
                        if (pCls.includes('message') || pCls.includes('bubble') || pCls.includes('conversation')) break;
                        branch = p;
                    }
                    if (branch && branch !== clone) branch.remove();
                    else el.remove();
                } catch(e) {}
            });

            // 4. Force hide any fixed/absolute elements (desktop overlays)
            // These were marked in the original before cloning to ensure accurate computed styles
            clone.querySelectorAll('[data-ag-rem]').forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    // Exclude Action Bars we want to keep
                    if (text.includes('allow') || text.includes('deny') || text.includes('review')) {
                        el.removeAttribute('data-ag-rem');
                        return;
                    }
                    el.remove();
                } catch(e) {}
            });
        } catch (globalErr) { }

        // Convert local images to base64
        const images = clone.querySelectorAll('img');
        const promises = Array.from(images).map(async (img) => {
            const rawSrc = img.getAttribute('src');
            if (rawSrc && (rawSrc.startsWith('/') || rawSrc.startsWith('vscode-file:')) && !rawSrc.startsWith('data:')) {
                try {
                    const res = await fetch(rawSrc);
                    const blob = await res.blob();
                    await new Promise(r => {
                        const reader = new FileReader();
                        reader.onloadend = () => { img.src = reader.result; r(); };
                        reader.onerror = () => r();
                        reader.readAsDataURL(blob);
                    });
                } catch(e) {}
            }
        });
        await Promise.all(promises);

        // Fix inline file references: Antigravity nests <div> elements inside
        // <span> and <p> tags (e.g. file-type icons). Browsers auto-close <p> and
        // <span> when they encounter a <div>, causing unwanted line breaks.
        // Solution: Convert any <div> inside an inline parent to a <span>.
        try {
            const inlineTags = new Set(['SPAN', 'P', 'A', 'LABEL', 'EM', 'STRONG', 'CODE']);
            const allDivs = Array.from(clone.querySelectorAll('div'));
            for (const div of allDivs) {
                try {
                    if (!div.parentNode) continue;
                    const parent = div.parentElement;
                    if (!parent) continue;
                    
                    const parentIsInline = inlineTags.has(parent.tagName) || 
                        (parent.className && (parent.className.includes('inline-flex') || parent.className.includes('inline-block')));
                        
                    if (parentIsInline) {
                        const span = document.createElement('span');
                        // MOVE children instead of copying (prevents orphaning nested divs)
                        while (div.firstChild) {
                            span.appendChild(div.firstChild);
                        }
                        if (div.className) span.className = div.className;
                        if (div.getAttribute('style')) span.setAttribute('style', div.getAttribute('style'));
                        span.style.display = 'inline-flex';
                        span.style.alignItems = 'center';
                        span.style.verticalAlign = 'middle';
                        div.replaceWith(span);
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\\n');
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length
            }
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                // console.log(`Context ${ctx.id} exception:`, result.exceptionDetails);
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    // console.log(`Context ${ctx.id} script error:`, val.error);
                    // if (val.debug) console.log(`   Debug info:`, JSON.stringify(val.debug));
                } else {
                    return val;
                }
            }
        } catch (e) {
            console.log(`Context ${ctx.id} connection error:`, e.message);
        }
    }

    return null;
}

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"], [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector('[data-testid="send-button"]') || 
                       document.querySelector('[aria-label="Send message"]') ||
                       document.querySelector('button[class*="bg-primary"]') ||
                       document.querySelector("svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        // Submit button not found, but text is inserted - trigger Enter key
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));
        
        return { ok:true, method:"enter_keypress" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Click Element (Remote) - Sanitized against CDP script injection
async function clickElement(cdp, { selector, index, textContent }) {
    if (!selector || typeof selector !== 'string') {
        return { error: 'Invalid selector: must be a non-empty string' };
    }

    const safeSelector = JSON.stringify(selector);
    const targetIndex = Number.isInteger(Number(index)) ? Math.max(0, parseInt(index, 10)) : 0;
    const safeText = JSON.stringify(typeof textContent === 'string' ? textContent : '');

    const EXP = `(async () => {
        try {
            const selectorStr = ${safeSelector};
            const targetIndex = ${targetIndex};
            const filterText = ${safeText};

            // Priority: Search inside the chat container first for better accuracy
            const root = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade') || document;
            
            // Strategy: Find all elements matching the selector safely
            let elements = Array.from(root.querySelectorAll(selectorStr));
            
            if (filterText) {
                elements = elements.filter(el => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    const firstLine = txt.split('\\n')[0].trim();
                    return firstLine === filterText || txt.includes(filterText);
                });
                
                // CRITICAL: If elements are nested, keep only the most specific (inner-most) one
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }

            const target = elements[targetIndex];

            if (target) {
                if (target.focus) target.focus();
                target.click();
                return { success: true, found: elements.length, indexUsed: targetIndex };
            }
            
            return { error: 'Element not found at index ' + targetIndex + ' among ' + elements.length + ' matches' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts or element not found at index' };
}

// Remote scroll - sync phone scroll to desktop (Sanitized against CDP script injection)
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    const hasPercent = scrollPercent !== undefined && scrollPercent !== null && Number.isFinite(Number(scrollPercent));
    const safePercent = hasPercent ? Math.min(Math.max(Number(scrollPercent), 0), 1) : null;
    const safeScrollTop = (scrollTop !== undefined && scrollTop !== null && Number.isFinite(Number(scrollTop)))
        ? Math.max(0, Number(scrollTop))
        : 0;

    const EXPRESSION = `(async () => {
        try {
            const percent = ${JSON.stringify(safePercent)};
            const topVal = ${JSON.stringify(safeScrollTop)};

            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling when provided, otherwise absolute pixel offset
            if (percent !== null) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * percent;
            } else {
                target.scrollTop = topVal;
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-tooltip-id patterns (most reliable)
            modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}
// Get Chat History - Click history button and scrape conversations
async function getChatHistory(cdp) {
    const EXP = `(async () => {
        try {
            const chats = [];
            const seenTitles = new Set();

            // Priority 1: Look for tooltip ID pattern (history/past/recent)
            let historyBtn = document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]');
            
            // Priority 2: Look for button ADJACENT to the new chat button
            if (!historyBtn) {
                const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
                if (newChatBtn) {
                    const parent = newChatBtn.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(el => el !== newChatBtn);
                        historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
                    }
                }
            }

            // Fallback: Use previous heuristics (icon/aria-label)
            if (!historyBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[data-tooltip-id]'));
                for (const btn of allButtons) {
                    if (btn.offsetParent === null) continue;
                    const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                                           btn.querySelector('svg.lucide-history') ||
                                           btn.querySelector('svg.lucide-folder') ||
                                           btn.querySelector('svg[class*="clock"]') ||
                                           btn.querySelector('svg[class*="history"]');
                    if (hasHistoryIcon) {
                        historyBtn = btn;
                        break;
                    }
                }
            }
            
            if (!historyBtn) {
                return { error: 'History button not found', chats: [] };
            }

            // Click and Wait
            historyBtn.click();
            await new Promise(r => setTimeout(r, 2000));
            
            // Find the side panel
            let panel = null;
            let inputsFoundDebug = [];
            
            // Strategy 1: The search input has specific placeholder
            let searchInput = null;
            const inputs = Array.from(document.querySelectorAll('input'));
            searchInput = inputs.find(i => {
                const ph = (i.placeholder || '').toLowerCase();
                return ph.includes('select') || ph.includes('conversation');
            });
            
            // Strategy 2: Look for any text input that looks like a search bar (based on user snippet classes)
            if (!searchInput) {
                const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
                inputsFoundDebug = allInputs.map(i => 'ph:' + i.placeholder + ', cls:' + i.className);
                
                searchInput = allInputs.find(i => 
                    i.offsetParent !== null && 
                    (i.className.includes('w-full') || i.classList.contains('w-full'))
                );
            }
            
            // Strategy 3: Find known text in the panel (Anchor Text Strategy)
            let anchorElement = null;
            if (!searchInput) {
                 const allSpans = Array.from(document.querySelectorAll('span, div, p'));
                 anchorElement = allSpans.find(s => {
                     const t = (s.innerText || '').trim();
                     return t === 'Current' || t === 'Refining Chat History Scraper'; // specific known title
                 });
            }

            const startElement = searchInput || anchorElement;

            if (startElement) {
                // Walk up to find the panel container
                let container = startElement;
                for (let i = 0; i < 15; i++) { 
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    const rect = container.getBoundingClientRect();
                    
                    // Panel should have good dimensions
                    // Relaxed constraints for mobile
                    if (rect.width > 50 && rect.height > 100) {
                        panel = container;
                        
                        // If it looks like a modal/popover (fixed or absolute pos), that's definitely it
                        const style = window.getComputedStyle(container);
                        if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                            break;
                        }
                    }
                }
                
                // Fallback if loop finishes without specific break
                if (!panel && startElement) {
                     // Just go up 4 levels
                     let p = startElement;
                     for(let k=0; k<4; k++) { if(p.parentElement) p = p.parentElement; }
                     panel = p;
                }
            }
            
            const debugInfo = { 
                panelFound: !!panel, 
                panelWidth: panel?.offsetWidth || 0,
                inputFound: !!searchInput,
                anchorFound: !!anchorElement,
                inputsDebug: inputsFoundDebug.slice(0, 5)
            };
            
            if (panel) {
                // Chat titles are in <span> elements
                const spans = Array.from(panel.querySelectorAll('span'));
                
                // Section headers and workspace labels to skip
                const SKIP_EXACT = new Set([
                    'current', 'other conversations', 'now',
                    'projects', 'personal', 'workspace', 'default', 'phone connect antigravity'
                ]);
                
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    const lower = text.toLowerCase();
                    
                    // Skip empty or too short
                    if (text.length < 3) continue;

                    // Sibling-span heuristic: skip tag/badge labels (like workspaces)
                    // If a short span has a longer sibling span, it's likely a tag next to the actual title
                    if (text.length < 40 && span.parentElement) {
                        let hasLongerSiblingSpan = false;
                        for (const child of span.parentElement.children) {
                            if (child !== span && child.tagName === 'SPAN') {
                                const childTextLength = (child.textContent?.trim() || '').length;
                                if (childTextLength > text.length) {
                                    hasLongerSiblingSpan = true;
                                    break;
                                }
                            }
                        }
                        if (hasLongerSiblingSpan) continue;
                    }
                    
                    // Skip section headers
                    if (SKIP_EXACT.has(lower)) continue;
                    if (lower.startsWith('recent in ')) continue;
                    if (lower.startsWith('show ') && lower.includes('more')) continue;
                    
                    // Skip timestamps
                    if (lower.endsWith(' ago') || /^\\d+\\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
                    
                    // Skip very long text (containers)
                    if (text.length > 100) continue;
                    
                    // Skip duplicates
                    if (seenTitles.has(text)) continue;
                    
                    seenTitles.add(text);
                    chats.push({ title: text, date: 'Recent' });
                    
                    if (chats.length >= 50) break;
                }
            }
            
            // Note: Panel is left open on PC as requested ("launch history on pc")

            return { success: true, chats: chats, debug: debugInfo };
        } catch(e) {
            return { error: e.toString(), chats: [] };
        }
    })()`;

    let lastError = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
            // If result.value is null/undefined but no error thrown, check exceptionDetails
            if (res.exceptionDetails) {
                lastError = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            }
        } catch (e) {
            lastError = e.message;
        }
    }
    return { error: 'Context failed: ' + (lastError || 'No contexts available'), chats: [] };
}

async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);

    const EXP = `(async () => {
        try {
            const targetTitle = ${safeChatTitle};
            let debugInfo = [];
            const log = (msg) => debugInfo.push(msg);
            log('Starting selectChat for: ' + targetTitle);

            // 1. Open History Panel (same robust method style as getChatHistory)
            let historyBtn = document.querySelector('[data-tooltip-id="history-tooltip"]');
            
            if (!historyBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
                
                // Try icon first
                historyBtn = allButtons.find(btn => {
                    if (btn.offsetParent === null) return false;
                    return btn.querySelector('svg.lucide-clock') ||
                        btn.querySelector('svg.lucide-history') ||
                        btn.querySelector('svg.lucide-folder') ||
                        btn.querySelector('svg.lucide-clock-rotate-left');
                });
                
                // Try position strategy (second button near new chat)
                if (!historyBtn) {
                    const topButtons = allButtons.filter(btn => {
                        if (btn.offsetParent === null) return false;
                        const rect = btn.getBoundingClientRect();
                        return rect.top < 100 && rect.top > 0;
                    }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                    
                    if (topButtons.length >= 2) historyBtn = topButtons[1];
                }
            }

            if (!historyBtn) return { error: 'History button not found', debug: debugInfo };

            historyBtn.click();
            log('Clicked history button');

            // 2. Wait-for-visible polling (up to 3s)
            let panel = null;
            let panelFound = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 200));

                const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
                const searchInput = inputs.find(input =>
                    input.offsetParent !== null &&
                    (input.placeholder?.toLowerCase().includes('select') ||
                     input.placeholder?.toLowerCase().includes('conversation') ||
                     input.className.includes('w-full'))
                );

                const allSpans = Array.from(document.querySelectorAll('span, div, p'));
                const anchorSpan = allSpans.find(s => s.offsetParent !== null && (s.innerText || '').trim() === 'Current');

                const anchor = searchInput || anchorSpan;
                if (anchor) {
                    let container = anchor;
                    for (let j = 0; j < 15; j++) {
                        if (!container) break;
                        const rect = container.getBoundingClientRect();
                        if (rect.width > 50 && rect.height > 100) {
                            const style = window.getComputedStyle(container);
                            if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                                panel = container;
                                panelFound = true;
                                break;
                            }
                        }
                        container = container.parentElement;
                    }
                }
                if (panelFound) break;
            }

            if (!panelFound) return { error: 'History panel did not open', debug: debugInfo };
            log('Panel found');

            // Give panel a bit more time to render list items
            await new Promise(r => setTimeout(r, 300));

            // 3. Scored fuzzy matching
            let candidates = Array.from(panel.querySelectorAll('span, p, div'))
                .filter(el => {
                    const text = el.textContent?.trim() || '';
                    return text.length >= 3 && el.children.length === 0 && el.offsetParent !== null;
                })
                .map(el => {
                    const text = el.textContent.trim();
                    const targetLower = targetTitle.toLowerCase();
                    const textLower = text.toLowerCase();

                    let score = 0;
                    if (text === targetTitle) score += 100;
                    else if (textLower === targetLower) score += 90;
                    else if (text.includes(targetTitle)) score += 60;
                    else if (textLower.includes(targetLower)) score += 50;
                    else if (targetLower.includes(textLower)) score += 40;
                    else if (textLower.startsWith(targetLower.substring(0, Math.min(20, targetLower.length)))) score += 30;

                    // Penalty for tiny labels/tags
                    if (text.length < 5) score -= 10;

                    // Bonus for deeper nodes (usually more specific)
                    let depth = 0;
                    let p = el;
                    while (p) { depth++; p = p.parentElement; }
                    score += depth;

                    return { el, text, score };
                })
                .filter(c => c.score >= 30)
                .sort((a, b) => b.score - a.score);

            if (candidates.length === 0) return { error: 'Chat title not found in panel', title: targetTitle, debug: debugInfo };

            log('Found ' + candidates.length + ' candidates. Best match: "' + candidates[0].text + '" (Score: ' + candidates[0].score + ')');

            // 4. Click execution with MouseEvent fallback
            const executeClick = (targetEl) => {
                let clickable = targetEl;
                let foundClickable = false;

                for (let i = 0; i < 5; i++) {
                    if (!clickable) break;
                    const style = window.getComputedStyle(clickable);
                    if (style.cursor === 'pointer' || clickable.tagName === 'BUTTON' || clickable.onclick) {
                        foundClickable = true;
                        break;
                    }
                    if (clickable.parentElement) clickable = clickable.parentElement;
                }

                const finalTarget = foundClickable ? clickable : targetEl;
                finalTarget.click();

                try {
                    const rect = finalTarget.getBoundingClientRect();
                    const centerX = rect.left + (rect.width / 2);
                    const centerY = rect.top + (rect.height / 2);
                    const events = ['mousedown', 'mouseup', 'click'];
                    events.forEach(type => {
                        finalTarget.dispatchEvent(new MouseEvent(type, {
                            view: window,
                            bubbles: true,
                            cancelable: true,
                            clientX: centerX,
                            clientY: centerY,
                            button: 0
                        }));
                    });
                } catch (e) {
                    log('MouseEvent fallback failed: ' + e.message);
                }
            };

            executeClick(candidates[0].el);
            log('Executed click on candidate 0');

            // 5. Verify/retry if panel still open
            await new Promise(r => setTimeout(r, 1500));
            const isPanelStillOpen = panel.offsetParent !== null && panel.style.display !== 'none' && panel.getBoundingClientRect().height > 0;

            if (isPanelStillOpen && candidates.length > 1) {
                log('Panel still open, retrying with candidate 1: "' + candidates[1].text + '"');
                executeClick(candidates[1].el);
                await new Promise(r => setTimeout(r, 1000));
            }

            // Ensure panel closes
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

            return { success: true, method: 'heuristic_click', bestMatch: candidates[0].text, retried: isPanelStillOpen, debug: debugInfo };
        } catch (e) {
            return { error: 'JS Exception: ' + e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || 
                          document.getElementById('chat') || 
                          document.getElementById('cascade') ||
                          document.querySelector('.scrollbar-hide.px-4') ||
                          document.querySelector('[class*="scrollbar-hide"][class*="px-"]');
    const hasMessages = chatContainer && (chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0 || chatContainer.children.length > 0);
    const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button') ||
                    document.querySelector('button[aria-label*="Stop"], button[title*="Stop"]');
    const isExecuting = !!(stopBtn && stopBtn.offsetParent !== null);
    return {
        hasChat: !!chatContainer,
        hasMessages: hasMessages,
        editorFound: !!(chatContainer && (chatContainer.querySelector('[data-lexical-editor="true"]') || document.querySelector('[contenteditable="true"]'))),
        isExecuting: isExecuting
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

// Get list of projects
async function getProjects(cdp) {
    const EXP = `(() => {
        try {
            const projects = [];
            const seen = new Set();
            
            // 1. Locate the "Projects" section label
            const divs = Array.from(document.querySelectorAll('div, span, button'));
            const projectsHeader = divs.find(el => el.innerText?.trim() === 'Projects' && el.offsetParent !== null);
            
            if (projectsHeader) {
                // Go up to the sidebar container
                let container = projectsHeader;
                for (let i = 0; i < 4; i++) {
                    if (container.parentElement) container = container.parentElement;
                }
                
                // Get all text spans/buttons inside this container
                const spans = Array.from(container.querySelectorAll('span, button, a'));
                for (const el of spans) {
                    const text = el.innerText?.trim();
                    if (text && text.length > 2 && text.length < 60 && text !== 'Projects' && el.children.length === 0) {
                        // Skip common actions
                        if (['New', 'Recent', 'Settings', 'Close', 'Help'].includes(text)) continue;
                        if (seen.has(text)) continue;
                        seen.add(text);
                        projects.push(text);
                    }
                }
            } else {
                // Fallback: search globally for candidate project spans
                const spans = Array.from(document.querySelectorAll('span, button'));
                for (const el of spans) {
                    const text = el.innerText?.trim();
                    const cls = typeof el.className === 'string' ? el.className : '';
                    if (text && text.length > 2 && text.length < 50 && el.children.length === 0 && el.offsetParent !== null) {
                        if (cls.includes('truncate') && (cls.includes('text-sm') || cls.includes('text-left'))) {
                            if (seen.has(text)) continue;
                            seen.add(text);
                            projects.push(text);
                        }
                    }
                }
            }
            
            return JSON.stringify(projects);
        } catch(e) {
            return JSON.stringify([]);
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                return JSON.parse(res.result.value);
            }
        } catch (e) { }
    }
    return [];
}

// Select a project by clicking it
async function selectProject(cdp, projectName) {
    const safeProjectName = JSON.stringify(projectName);
    const EXP = `(async () => {
        try {
            const targetName = ${safeProjectName};
            const spans = Array.from(document.querySelectorAll('span, button, div, a'));
            
            // Find the project element
            const el = spans.find(s => 
                s.offsetParent !== null && 
                s.innerText?.trim() === targetName && 
                s.children.length === 0
            );
            
            if (!el) return { error: 'Project element not found: ' + targetName };
            
            // Click it
            let clickable = el;
            for (let i = 0; i < 5; i++) {
                if (!clickable) break;
                const style = window.getComputedStyle(clickable);
                if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || style.cursor === 'pointer' || clickable.onclick) {
                    break;
                }
                clickable = clickable.parentElement;
            }
            
            const target = clickable || el;
            target.click();
            return { success: true, clicked: target.tagName };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to select project in all contexts' };
}

// Get available models dynamically from the active UI dropdown
async function getAvailableModels(cdp) {
    const EXP = `(async () => {
        try {
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            // Try to find the model selector button
            let modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON');
                }) || candidates[0];
            }
            
            if (!modelBtn) return JSON.stringify([]);
            
            // Open the dropdown menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 450));
            
            // Scrape the dropdown/dialog
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], div[class*="menu"], div[class*="popup"]'));
            const visibleDialog = dialogs.find(d => d.offsetHeight > 0);
            
            let models = [];
            if (visibleDialog) {
                // Find all items
                const items = Array.from(visibleDialog.querySelectorAll('[role="menuitem"], [role="option"], button, span, div'))
                    .filter(el => el.children.length === 0 && el.innerText?.trim().length > 0);
                models = items.map(el => el.innerText.trim()).filter(text => {
                    return KNOWN_KEYWORDS.some(k => text.includes(k)) && text.length < 60;
                });
            } else {
                // Fallback: search globally for menu items
                const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
                    .filter(el => el.innerText?.trim().length > 0);
                models = items.map(el => el.innerText.trim()).filter(text => {
                    return KNOWN_KEYWORDS.some(k => text.includes(k)) && text.length < 60;
                });
            }
            
            // Close the menu
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            
            return JSON.stringify([...new Set(models)]);
        } catch(e) {
            return JSON.stringify([]);
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const parsed = JSON.parse(res.result.value);
                if (parsed && parsed.length > 0) return parsed;
            }
        } catch (e) { }
    }
    
    // Fallback if dynamic scraping fails
    return [
        "Gemini 3.1 Pro (High)",
        "Gemini 3.1 Pro (Low)",
        "Gemini 3.5 Pro (Thinking)",
        "Gemini 3.5 Flash (High)",
        "Gemini 3.5 Flash (Low)",
        "Gemini 3 Flash",
        "Claude Sonnet 4.6 (Thinking)",
        "Claude Opus 4.6 (Thinking)",
        "GPT-OSS 120B (Medium)"
    ];
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for leaf text nodes containing a known model keyword
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes2 = allEls.filter(el => el.children.length === 0 && el.innerText);
        
        // First try: find inside a clickable parent (button, cursor:pointer)
        let modelEl = textNodes2.find(el => {
            const txt = el.innerText.trim();
            if (!KNOWN_MODELS.some(k => txt.includes(k))) return false;
            // Must be in a clickable context (header/toolbar, not chat content)
            let parent = el;
            for (let i = 0; i < 8; i++) {
                if (!parent) break;
                if (parent.tagName === 'BUTTON' || window.getComputedStyle(parent).cursor === 'pointer') return true;
                parent = parent.parentElement;
            }
            return false;
        });
        
        // Fallback: any leaf node with a known model name
        if (!modelEl) {
            modelEl = textNodes2.find(el => {
                const txt = el.innerText.trim();
                return KNOWN_MODELS.some(k => txt.includes(k)) && txt.length < 60;
            });
        }

        if (modelEl) {
            state.model = modelEl.innerText.trim();
        }

        // 3. Get Active Project Name
        const activeProjectBtn = document.querySelector('button[class*="headerbtn"]');
        if (activeProjectBtn) {
            state.project = activeProjectBtn.innerText.trim();
        } else {
            // Fallback: search for elements with header/project classes or keywords
            const pBtn = Array.from(document.querySelectorAll('button'))
                .find(b => {
                    const text = (b.innerText || '').toLowerCase();
                    return text.includes('project') && !text.includes('options') && b.offsetParent !== null;
                });
            if (pBtn) {
                state.project = pBtn.innerText.trim();
            } else {
                state.project = 'Unknown';
            }
        }

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Initialize CDP connection
async function initCDP(quiet = false) {
    if (!quiet) console.log('🔍 Discovering Antigravity CDP endpoint...');
    const cdpInfo = await discoverCDP();
    console.log(`✅ Found Antigravity on port ${cdpInfo.port} `);

    console.log('🔌 Connecting to CDP...');
    cdpConnection = await connectCDP(cdpInfo.url);
    console.log(`✅ Connected! Found ${cdpConnection.contexts.length} execution contexts\n`);
}

// Background polling
async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;

    const poll = async () => {
        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                // Was connected, now lost
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
            }
            try {
                await initCDP(true);
                if (cdpConnection) {
                    console.log('✅ CDP Connection established from polling loop');
                    isConnecting = false;
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000); // Try again in 2 seconds if not found
            return;
        }

        try {
            const snapshot = await captureSnapshot(cdpConnection);
            if (snapshot && !snapshot.error) {
                const hash = hashString(snapshot.html);

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast to all connected clients
                    wss.clients.forEach(client => {
                        if (client.isAuthenticated && client.readyState === WebSocket.OPEN &&
                            (!client.session || sessionManager.getSession(client.session.id, false))) {
                            client.send(JSON.stringify({
                                type: 'snapshot_update',
                                timestamp: new Date().toISOString()
                            }));
                        }
                    });

                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
            } else {
                // Snapshot is null or has error
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    console.warn(`⚠️  Snapshot capture issue: ${errorMsg} `);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in Antigravity)');
                    }
                    if (cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Antigravity window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

// Create Express app
async function createServer() {
    const app = express();

    // Check for SSL certificates
    const keyPath = join(__dirname, 'certs', 'server.key');
    const certPath = join(__dirname, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({
        server,
        verifyClient: (info, callback) => {
            const ip = info.req.socket.remoteAddress || '127.0.0.1';
            if (rateLimiter.isLocked(ip)) {
                return callback(false, 429, 'Rate limited');
            }
            const origin = info.origin || info.req.headers.origin;
            if (!isSameOrigin(info.req, origin)) {
                auditLogger.log({ type: 'WS_ORIGIN_BLOCKED', ip, summary: 'Rejected cross-origin WebSocket' });
                return callback(false, 403, 'Cross-Origin Forbidden');
            }
            callback(true);
        }
    });

    // Initialize Auth Token using a unique salt from environment
    const authSalt = process.env.AUTH_SALT || 'antigravity_default_salt_99';
    AUTH_TOKEN = hashString(APP_PASSWORD + authSalt);

    app.use(compression());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req, req.headers.origin)) {
            return res.status(403).json({ error: 'Cross-origin request rejected' });
        }
        next();
    });
    app.use(express.json({ limit: '1mb' }));

    // Use a secure session secret from .env if available
    const sessionSecret = SESSION_SECRET;

    if (sessionSecret === 'antigravity_secret_key_1337') {
        console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default SESSION_SECRET ("antigravity_secret_key_1337").');
        console.warn('\x1b[33m%s\x1b[0m', '   Set a strong SESSION_SECRET in your .env file for production use.\n');
    }
    app.use(cookieParser(sessionSecret));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware
    app.use((req, res, next) => {
        const publicPaths = ['/health', '/ssl-status', '/login', '/login.html', '/favicon.ico', '/manifest.webmanifest', '/sw.js', '/styleguide', '/styleguide.html'];
        if (publicPaths.includes(req.path) || req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/assets/')) {
            return next();
        }

        // Demo Mode (?demo=1) - strictly restricted to localhost / dev review
        if (req.query.demo === '1' && canUseDemoLogin(req)) {
            const clientIp = getClientIp(req);
            const session = sessionManager.createSession({
                ip: clientIp,
                userAgent: req.headers['user-agent'] || '',
                isLocal: true,
                isTunnel: false
            });
            res.cookie(AUTH_COOKIE_NAME, session.id, {
                httpOnly: true,
                signed: true,
                sameSite: 'strict',
                secure: hasSSL,
                maxAge: 24 * 60 * 60 * 1000
            });
            req.session = session;
            return next();
        }

        // Ephemeral One-Time Pairing Ticket Login (Replaces dangerous ?key= query string)
        if (req.query.ticket) {
            const isValidTicket = sessionManager.consumePairingTicket(req.query.ticket);
            if (isValidTicket) {
                const clientIp = getClientIp(req, process.env.TUNNEL_PROVIDER || 'auto');
                const session = sessionManager.createSession({
                    ip: clientIp,
                    userAgent: req.headers['user-agent'] || '',
                    isLocal: isLocalRequest(req),
                    isTunnel: !isLocalRequest(req)
                });
                res.cookie(AUTH_COOKIE_NAME, session.id, {
                    httpOnly: true,
                    signed: true,
                    sameSite: 'strict',
                    secure: hasSSL,
                    maxAge: 24 * 60 * 60 * 1000
                });
                auditLogger.log({ type: 'PAIRING_TICKET_LOGIN', ip: clientIp, deviceId: session.deviceFingerprint, summary: 'Logged in via ephemeral pairing ticket' });
                return res.redirect('/');
            } else {
                auditLogger.log({ type: 'INVALID_PAIRING_TICKET', ip: getClientIp(req), summary: 'Attempted login with invalid/expired pairing ticket' });
                return res.status(401).send('<h1>Pairing ticket is invalid or expired.</h1>');
            }
        }

        const sessionId = req.signedCookies[AUTH_COOKIE_NAME];
        const session = sessionManager.getSession(sessionId);

        if (session) {
            req.session = session;
            return next();
        }

        // Configurable LAN Auto-Trust (Disabled by default for Zero-Trust compliance)
        if (sessionManager.allowLanAutoTrust && isLocalRequest(req)) {
            const clientIp = getClientIp(req);
            const lanSession = sessionManager.createSession({
                ip: clientIp,
                userAgent: req.headers['user-agent'] || '',
                isLocal: true,
                isTunnel: false
            });
            res.cookie(AUTH_COOKIE_NAME, lanSession.id, {
                httpOnly: true,
                signed: true,
                sameSite: 'strict',
                maxAge: 24 * 60 * 60 * 1000
            });
            req.session = lanSession;
            return next();
        }

        const isApi = req.xhr || 
                      req.headers.accept?.includes('json') || 
                      req.path.startsWith('/snapshot') || 
                      req.path.startsWith('/send') ||
                      req.path.startsWith('/projects') ||
                      req.path.startsWith('/select-project') ||
                      req.path.startsWith('/models') ||
                      req.path.startsWith('/set-model') ||
                      req.path.startsWith('/set-mode') ||
                      req.path.startsWith('/stop') ||
                      req.path.startsWith('/upload-file') ||
                      req.path.startsWith('/api/');
        
        if (isApi) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });

    app.use(express.static(join(__dirname, 'public')));

    // Secure Login endpoint with Rate Limiting and Constant-Time Authentication
    app.post('/login', (req, res) => {
        const clientIp = getClientIp(req, process.env.TUNNEL_PROVIDER || 'auto');
        if (rateLimiter.isLocked(clientIp)) {
            const sec = rateLimiter.getRemainingLockoutSec(clientIp);
            auditLogger.log({ type: 'LOCKOUT_REJECTED', ip: clientIp, summary: 'Login rejected: IP locked out' });
            return res.status(429).json({ success: false, error: 'Too many failed login attempts. Locked out for ' + sec + ' seconds.' });
        }

        const { password, totp } = req.body;
        const isPasswordCorrect = timingSafeEqualString(password, APP_PASSWORD);

        // Optional TOTP 2FA Verification (RFC 6238)
        if (isPasswordCorrect && process.env.ENABLE_TOTP === 'true') {
            const totpSecret = process.env.TOTP_SECRET;
            if (!totp) return res.status(401).json({ success: false, code: 'TOTP_REQUIRED', error: '2FA TOTP code required.' });
            if (!totp || !TotpEngine.verifyToken(totp, totpSecret)) {
                rateLimiter.recordFailure(clientIp);
                auditLogger.log({ type: 'TOTP_FAILURE', ip: clientIp, summary: 'Invalid TOTP code provided' });
                return res.status(401).json({ success: false, error: 'Invalid 2FA TOTP code.' });
            }
        }

        if (isPasswordCorrect) {
            const fingerprint = sessionManager.computeDeviceFingerprint(req);
            if (sessionManager.requirePairing && !isLocalRequest(req) && !sessionManager.isDeviceApproved(fingerprint)) {
                sessionManager.requestDevicePairing(fingerprint, req.headers['user-agent'] || '', clientIp);
                return res.status(403).json({ success: false, error: 'Device pairing approval required on the desktop.' });
            }
            rateLimiter.recordSuccess(clientIp);
            const session = sessionManager.createSession({
                ip: clientIp,
                userAgent: req.headers['user-agent'] || '',
                isLocal: isLocalRequest(req),
                isTunnel: !isLocalRequest(req),
                deviceFingerprint: fingerprint
            });

            res.cookie(AUTH_COOKIE_NAME, session.id, {
                httpOnly: true,
                signed: true,
                sameSite: 'strict',
                secure: hasSSL,
                maxAge: 24 * 60 * 60 * 1000
            });

            auditLogger.log({ type: 'LOGIN_SUCCESS', ip: clientIp, deviceId: session.deviceFingerprint, summary: 'Login successful (Mode: ' + session.mode + ')' });
            res.json({ success: true, mode: session.mode });
        } else {
            const outcome = rateLimiter.recordFailure(clientIp);
            auditLogger.log({ type: 'LOGIN_FAILURE', ip: clientIp, summary: 'Failed password attempt' });
            if (outcome.locked) {
                return res.status(429).json({ success: false, error: 'Too many failed attempts. Locked out for ' + outcome.lockoutSec + ' seconds.' });
            }
            res.status(401).json({ success: false, error: 'Invalid password', attemptsRemaining: outcome.attemptsRemaining });
        }
    });

    // Logout endpoint with Server-Side Session Invalidation
    app.post('/logout', (req, res) => {
        const sessionId = req.signedCookies[AUTH_COOKIE_NAME];
        if (sessionId) {
            sessionManager.destroySession(sessionId);
        }
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Session Status & Elevation Endpoints
    app.get('/api/session', (req, res) => {
        const session = req.session;
        const isTunnel = session ? session.isTunnel : !isLocalRequest(req);
        const tunnelStatus = tunnelSupervisor ? tunnelSupervisor.getCurrentStatus() : {};
        let connectionType = 'LAN';
        if (isTunnel) {
            const providerName = tunnelStatus.provider ? (tunnelStatus.provider.charAt(0).toUpperCase() + tunnelStatus.provider.slice(1)) : 'External';
            connectionType = `Tunnel (${providerName})`;
        }
        res.json({
            authenticated: !!session,
            user: session?.user || 'Administrator',
            mode: session ? session.mode : 'unauthenticated',
            deviceFingerprint: session ? session.deviceFingerprint : null,
            isLocal: session ? session.isLocal : isLocalRequest(req),
            isTunnel: !!isTunnel,
            connection: connectionType
        });
    });

    app.post('/api/elevate', (req, res) => {
        const { password, totp } = req.body;
        const clientIp = getClientIp(req);
        if (rateLimiter.isLocked(clientIp)) return res.status(429).json({ success: false, error: 'Too many attempts. Please wait.' });
        if (!timingSafeEqualString(password, APP_PASSWORD) ||
            (process.env.ENABLE_TOTP === 'true' && !TotpEngine.verifyToken(totp, process.env.TOTP_SECRET))) {
            rateLimiter.recordFailure(clientIp);
            auditLogger.log({ type: 'ELEVATE_FAILED', ip: clientIp, summary: 'Elevation attempt failed: wrong password' });
            return res.status(401).json({ success: false, error: 'Invalid password or 2FA code' });
        }
        rateLimiter.recordSuccess(clientIp);
        const sessionId = req.session.id;
        sessionManager.elevateSession(sessionId, 30 * 60 * 1000); // 30 mins
        auditLogger.log({ type: 'ELEVATE_SUCCESS', ip: clientIp, summary: 'Session elevated to control mode' });
        res.json({ success: true, mode: 'control' });
    });

    app.post('/api/demote', (req, res) => {
        const sessionId = req.session.id;
        sessionManager.demoteSession(sessionId);
        res.json({ success: true, mode: 'read-only' });
    });

    app.get('/api/audit-log', (req, res) => {
        res.json(auditLogger.getRecentEntries(50));
    });

    // Approvals API
    app.get('/api/approvals', (req, res) => {
        res.json(approvalManager.getPending());
    });

    app.post('/api/approvals/:id/resolve', requireControlMode, (req, res) => {
        const { decision, edits } = req.body;
        try {
            const resolved = approvalManager.resolve(req.params.id, decision, {
                user: req.session?.user || 'mobile',
                edits
            });
            res.json({ success: true, approval: resolved });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Task Queue API
    app.get('/api/queue', (req, res) => {
        res.json(taskQueue.getStatus());
    });

    app.post('/api/queue', requireControlMode, (req, res) => {
        const { prompt, priority, idempotencyKey } = req.body;
        try {
            const task = taskQueue.enqueue({ prompt, priority, idempotencyKey, session: req.session });
            res.json({ success: true, task });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    app.delete('/api/queue/:id', requireControlMode, (req, res) => {
        const cancelled = taskQueue.cancel(req.params.id);
        res.json({ success: cancelled });
    });

    // Timeline & Checkpoint API
    app.get('/api/timeline', (req, res) => {
        const limit = parseInt(req.query.limit, 10) || 50;
        res.json(eventBus.getHistory(limit));
    });

    app.get('/api/checkpoints', asyncRoute(async (req, res) => {
        const workspaceRoot = fileBrowser.workspaceRoot;
        if (req.query.workspace && path.resolve(req.query.workspace) !== workspaceRoot) return res.status(400).json({ error: 'Workspace must match the active workspace' });
        const limit = parseInt(req.query.limit, 10) || 20;
        const list = await checkpointManager.listCheckpoints(workspaceRoot, limit);
        res.json(list);
    }));

    // Sync Manifest Endpoint for Google Drive Cloud State Inspection (F-17)
    app.get('/api/sync-manifest', (req, res) => {
        try {
            const candidatePaths = [
                join(process.cwd(), '.quanta', 'sync-manifest.json'),
                join(process.cwd(), '..', '.quanta', 'sync-manifest.json'),
                join(__dirname, '..', '.quanta', 'sync-manifest.json')
            ];
            const manifestPath = candidatePaths.find(p => fs.existsSync(p));
            if (manifestPath) {
                try {
                    const raw = fs.readFileSync(manifestPath, 'utf8');
                    const data = JSON.parse(raw);
                    const fileCount = data.files ? Object.keys(data.files).length : 0;
                    return res.json({
                        exists: true,
                        status: 'synced',
                        version: data.version || 1,
                        workspaceName: data.workspaceName || 'quanta-ide',
                        lastSyncTimestamp: data.lastSyncTimestamp || 0,
                        fileCount,
                        files: data.files || {}
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

    app.post('/api/checkpoints/rollback', requireControlMode, asyncRoute(async (req, res) => {
        const { checkpointId, workspace: reqWorkspace } = req.body;
        if (!checkpointId) {
            return res.status(400).json({ success: false, error: 'checkpointId is required' });
        }
        const workspaceRoot = fileBrowser.workspaceRoot;
        if (reqWorkspace && path.resolve(reqWorkspace) !== workspaceRoot) return res.status(400).json({ error: 'Workspace must match the active workspace' });
        try {
            const result = await checkpointManager.rollback(workspaceRoot, checkpointId, { user: req.session?.user || 'mobile' });
            res.json({ success: true, result });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    }));

    // Phone Mini-IDE File Endpoints
    app.get('/api/files', (req, res) => {
        try {
            const list = fileBrowser.listDirectory(req.query.path || '');
            res.json(list);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.get('/api/files/content', (req, res) => {
        try {
            const fileData = fileBrowser.readFile(req.query.path || '');
            res.json(fileData);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/files/save', requireControlMode, (req, res) => {
        const { path: filePath, content, baseHash } = req.body;
        try {
            const result = fileBrowser.writeFile(filePath, content, baseHash, req.session.deviceFingerprint);
            res.json({ success: true, result });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Quick Actions
    app.get('/api/quick-actions', (req, res) => {
        res.json(quickActionRunner.listActions());
    });

    app.post('/api/quick-actions/:id/execute', requireControlMode, asyncRoute(async (req, res) => {
        try {
            const result = await quickActionRunner.executeAction(req.params.id, req.body?.params || {}, req.session);
            res.json({ success: true, result });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    }));

    // Image Upload
    app.post('/api/upload-image', requireControlMode, express.raw({ type: ['image/*', 'application/octet-stream'], limit: '10mb' }), asyncRoute(async (req, res) => {
        try {
            const originalName = req.headers['x-file-name'] || 'image.png';
            const uploadRes = await imageUploader.processAndSaveImage(req.body, originalName, req.session);
            res.json({ success: true, ...uploadRes });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    }));

    // Static serve for uploads
    app.use('/api/uploads', express.static(join(process.cwd(), '.quanta', 'uploads')));

    // Devices & Controller Lock API
    app.get('/api/devices', (req, res) => {
        res.json(sessionManager.getConnectedDevices());
    });

    app.post('/api/devices/claim-controller', requireControlMode, (req, res) => {
        const sessionId = req.session.id;
        const result = sessionManager.claimController(sessionId, !!req.body.force);
        res.json(result);
    });

    app.post('/api/devices/release-controller', (req, res) => {
        const sessionId = req.session.id;
        const released = sessionManager.releaseController(sessionId);
        res.json({ success: released });
    });

    const requireDesktop = (req, res, next) => {
        if (!canUseDemoLogin(req, true)) return res.status(403).json({ error: 'Use the local desktop to manage pairing' });
        next();
    };
    app.get('/api/devices/pending', requireDesktop, (req, res) => res.json([...sessionManager.pendingDevices.values()]));
    app.post('/api/devices/:fingerprint/approve', requireControlMode, requireDesktop, (req, res) => {
        if (!sessionManager.pendingDevices.has(req.params.fingerprint)) return res.status(404).json({ error: 'Unknown pending device' });
        sessionManager.approveDevice(req.params.fingerprint);
        res.json({ success: true });
    });
    app.post('/api/devices/:fingerprint/revoke', requireControlMode, requireDesktop, (req, res) => {
        sessionManager.revokeDevice(req.params.fingerprint);
        res.json({ success: true });
    });

    // Webhooks & Plugins API
    app.get('/api/webhooks', (req, res) => {
        res.json(webhookDispatcher.webhooks.map(w => ({ url: w.url, events: w.events })));
    });

    app.post('/api/webhooks', requireControlMode, (req, res) => {
        const { url, secret, events } = req.body;
        webhookDispatcher.addWebhook({ url, secret, events });
        res.json({ success: true });
    });

    app.get('/api/plugins', (req, res) => {
        res.json(pluginHost.listPlugins());
    });

    // Get current snapshot
    app.get('/snapshot', (req, res) => {
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(lastSnapshot);
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1, // WebSocket.OPEN = 1
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: hasSSL
        });
    });

    // Living styleguide endpoint (Ink & Paper)
    app.get('/styleguide', (req, res) => {
        res.sendFile(join(__dirname, 'public', 'styleguide.html'));
    });

    // SSL status endpoint
    app.get('/ssl-status', (req, res) => {
        const keyPath = join(__dirname, 'certs', 'server.key');
        const certPath = join(__dirname, 'certs', 'server.cert');
        const certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
        res.json({
            enabled: hasSSL,
            certsExist: certsExist,
            message: hasSSL ? 'HTTPS is active' :
                certsExist ? 'Certificates exist, restart server to enable HTTPS' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', asyncRoute(async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', { cwd: __dirname, stdio: 'pipe' });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    }));

    // Debug UI Endpoint
    app.get('/debug-ui', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    }));

    // Set Mode
    app.post('/set-mode', requireControlMode, asyncRoute(async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    }));

    // Set Model
    app.post('/set-model', requireControlMode, asyncRoute(async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    }));

    // Get Models list dynamically
    app.get('/models', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.json({ models: [] });
        const modelsList = await getAvailableModels(cdpConnection);
        res.json({ models: modelsList });
    }));


    // Upload file to the active workspace folder
    app.post('/upload-file', requireControlMode, asyncRoute(async (req, res) => {
        try {
            const { filename, data } = await parseMultipart(req);
            if (!filename || !data) {
                return res.status(400).json({ error: 'Invalid file upload' });
            }

            let activeProject = 'project quanta ide'; // default
            if (cdpConnection) {
                const state = await getAppState(cdpConnection);
                if (state.project && state.project !== 'Unknown') {
                    activeProject = state.project;
                }
            }

            const sanitizedFilename = path.win32.basename(path.posix.basename(filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.bin';
            const uploadDir = path.join(fileBrowser.workspaceRoot, '.quanta', 'attachments');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            const savePath = path.join(uploadDir, `${randomUUID()}-${sanitizedFilename}`);
            fs.writeFileSync(savePath, data, { flag: 'wx' });

            console.log(`📂 Mobile Upload: Saved file "${filename}" to workspace: "${savePath}"`);
            res.json({ success: true, filename, savedPath: savePath, project: activeProject });
        } catch (err) {
            console.error('File upload route error:', err);
            res.status(err.status || 500).json({ error: err.message });
        }
    }));

    // Stop Generation
    app.post('/stop', requireControlMode, asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    }));

    // Send message
    app.post('/send', requireControlMode, asyncRoute(async (req, res) => {
        const { message } = req.body;

        if (typeof message !== 'string' || !message.trim() || message.length > 100000) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const result = await injectMessage(cdpConnection, message);

        // Always return 200 - the message usually goes through even if CDP reports issues
        // The client will refresh and see if the message appeared
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
    }));

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (err) {
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    }));

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', asyncRoute(async (req, res) => {
        const results = {};
        const portsList = findAntigravityPort();
        for (const port of portsList) {
            try {
                const list = await getJson(`http://127.0.0.1:${port}/json/list`);
                results[port] = list;
            } catch (e) {
                results[port] = e.message;
            }
        }
        res.json(results);
    }));

    // WebSocket connection with Auth check
    wss.on('connection', (ws, req) => {
        // Parse cookies from headers
        const rawCookies = req.headers.cookie || '';
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

        // Verify signed cookie manually
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = false;

        // Exempt local Wi-Fi devices from authentication only if LAN auto-trust is enabled (Zero-Trust compliance)
        if (sessionManager.allowLanAutoTrust && isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const sessionSecret = SESSION_SECRET;

            if (sessionSecret === 'antigravity_secret_key_1337') {
                // Warning already printed on startup, but we check here for token verification
            }

            const token = cookieParser.signedCookie(signedToken, sessionSecret);
            if (token && token !== signedToken) {
                const session = sessionManager.getSession(token);
                if (session) {
                    isAuthenticated = true;
                    ws.session = session;
                }
            }
        }

        if (!isAuthenticated) {
            console.log('🚫 Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log('📱 Client connected (Authenticated)');
        ws.isAuthenticated = true;

        // Keepalive ping to prevent tunnel proxies (Cloudflare/ngrok) from dropping idle connections
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    // Server-side ping every 20s to keep WebSocket alive through tunnels
    const pingInterval = setInterval(() => {
        wss.clients.forEach(client => {
            if (!client.isAuthenticated || (client.session && !sessionManager.getSession(client.session.id, false))) {
                return client.close(1008, 'Unauthorized');
            }
            if (client.isAlive === false) {
                console.log('📱 Client timed out, terminating...');
                return client.terminate();
            }
            client.isAlive = false;
            client.ping();
        });
    }, 20000);

    wss.on('close', () => clearInterval(pingInterval));

    return { server, wss, app, hasSSL };
}

// Main
async function main() {
    try {
        await initCDP();
    } catch (err) {
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=9000 to connect.');
    }

    try {
        const { server, wss, app, hasSSL } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Remote Click
        app.post('/remote-click', requireControlMode, asyncRoute(async (req, res) => {
            const { selector, index, textContent } = req.body;
            if (!selector || typeof selector !== 'string') {
                return res.status(400).json({ error: 'Selector must be a non-empty string' });
            }
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await clickElement(cdpConnection, { selector, index, textContent });
            res.json(result);
        }));

        // Remote Scroll - sync phone scroll to desktop
        app.post('/remote-scroll', requireControlMode, asyncRoute(async (req, res) => {
            const { scrollTop, scrollPercent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
            res.json(result);
        }));

        function computeDiskUsage(targetPath = process.cwd()) {
            try {
                if (typeof fs.statfsSync === 'function') {
                    const stats = fs.statfsSync(targetPath);
                    if (stats && stats.blocks > 0) {
                        const total = stats.blocks * stats.bsize;
                        const free = stats.bavail * stats.bsize;
                        const used = total - free;
                        return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
                    }
                }
            } catch (e) {}
            return 0;
        }

        // Get App State
        app.get('/app-state', asyncRoute(async (req, res) => {
            const isTunnel = !isLocalRequest(req);
            const tunnelStatus = tunnelSupervisor ? tunnelSupervisor.getCurrentStatus() : {};
            let connectionType = 'LAN';
            if (isTunnel) {
                const providerName = tunnelStatus.provider ? (tunnelStatus.provider.charAt(0).toUpperCase() + tunnelStatus.provider.slice(1)) : 'External';
                connectionType = `Tunnel (${providerName})`;
            }

            let telemetry = { cpuPercent: 0, memoryUsedGB: '0.0', memoryTotalGB: '0.0', memoryPercent: 0, diskPercent: computeDiskUsage() };
            try {
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const usedMem = totalMem - freeMem;
                const totalMemGB = (totalMem / (1024 ** 3)).toFixed(1);
                const usedMemGB = (usedMem / (1024 ** 3)).toFixed(1);
                const memPercent = Math.round((usedMem / totalMem) * 100);
                const cpus = os.cpus() || [];
                let totalIdle = 0, totalTick = 0;
                cpus.forEach(cpu => {
                    for (const type in cpu.times) totalTick += cpu.times[type];
                    totalIdle += cpu.times.idle;
                });
                const idle = totalIdle / (cpus.length || 1);
                const total = totalTick / (cpus.length || 1);
                const cpuPercent = total > 0 ? Math.min(100, Math.max(0, Math.round((1 - (idle / total)) * 100))) : 0;
                telemetry = { cpuPercent, memoryUsedGB: usedMemGB, memoryTotalGB: totalMemGB, memoryPercent: memPercent, diskPercent: computeDiskUsage() };
            } catch (e) {}

            if (!cdpConnection) {
                return res.json({
                    cdpConnected: false,
                    mode: 'Standby',
                    model: 'Antigravity (Local)',
                    project: 'quanta-ide',
                    telemetry,
                    connectionType
                });
            }
            const result = await getAppState(cdpConnection);
            res.json(Object.assign({ cdpConnected: true, project: 'quanta-ide', telemetry, connectionType }, result));
        }));

        app.get('/api/system-telemetry', (req, res) => {
            try {
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const usedMem = totalMem - freeMem;
                const totalMemGB = (totalMem / (1024 ** 3)).toFixed(1);
                const usedMemGB = (usedMem / (1024 ** 3)).toFixed(1);
                const memPercent = Math.round((usedMem / totalMem) * 100);
                const cpus = os.cpus() || [];
                let totalIdle = 0, totalTick = 0;
                cpus.forEach(cpu => {
                    for (const type in cpu.times) totalTick += cpu.times[type];
                    totalIdle += cpu.times.idle;
                });
                const idle = totalIdle / (cpus.length || 1);
                const total = totalTick / (cpus.length || 1);
                const cpuPercent = total > 0 ? Math.min(100, Math.max(0, Math.round((1 - (idle / total)) * 100))) : 0;
                res.json({ cpuPercent, memoryUsedGB: usedMemGB, memoryTotalGB: totalMemGB, memoryPercent: memPercent, diskPercent: computeDiskUsage() });
            } catch (e) {
                res.status(503).json({ error: 'System telemetry unavailable' });
            }
        });

        // Start New Chat
        app.post('/new-chat', requireControlMode, asyncRoute(async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await startNewChat(cdpConnection);
            res.json(result);
        }));

        // Get Chat History
        app.get('/chat-history', asyncRoute(async (req, res) => {
            if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
            const result = await getChatHistory(cdpConnection);
            res.json(result);
        }));

        // Select a Chat
        app.post('/select-chat', requireControlMode, asyncRoute(async (req, res) => {
            const { title } = req.body;
            if (!title) return res.status(400).json({ error: 'Chat title required' });
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectChat(cdpConnection, title);
            res.json(result);
        }));

        // Close Chat History
        app.post('/close-history', requireControlMode, asyncRoute(async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await closeHistory(cdpConnection);
            res.json(result);
        }));

        // Check if Chat is Open
        app.get('/chat-status', asyncRoute(async (req, res) => {
            if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
            const result = await hasChatOpen(cdpConnection);
            res.json(result);
        }));

        // Get list of projects/workspaces
        app.get('/projects', asyncRoute(async (req, res) => {
            if (!cdpConnection) return res.json({ error: 'CDP disconnected', projects: [] });
            const result = await getProjects(cdpConnection);
            res.json({ projects: result });
        }));

        // Select a project/workspace
        app.post('/select-project', requireControlMode, asyncRoute(async (req, res) => {
            const { project } = req.body;
            if (!project) return res.status(400).json({ error: 'Project name required' });
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectProject(cdpConnection, project);
            res.json(result);
        }));

        app.use(apiErrorHandler);

        // Start server
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        server.on('error', (error) => {
            console.error(error.code === 'EADDRINUSE'
                ? `Port ${SERVER_PORT} is already in use. Stop the existing server or configure another PORT.`
                : `Server failed: ${error.message}`);
            process.exit(1);
        });
        server.listen(SERVER_PORT, process.env.HOST || '0.0.0.0', () => {
            console.log(`🚀 Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
            if (hasSSL) {
                console.log(`💡 First time on phone? Accept the security warning to proceed.`);
            }
        });

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
