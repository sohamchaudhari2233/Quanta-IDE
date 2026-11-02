// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const projectBtn = document.getElementById('projectBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const projectText = document.getElementById('projectText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// New elements for event listeners
const enableHttpsBtn = document.getElementById('enableHttpsBtn');
const dismissSslBtn = document.querySelector('.dismiss-btn');
const closeModalBtn = document.getElementById('closeModalBtn');
const supportBtn = document.getElementById('supportBtn');
const supportOverlay = document.getElementById('supportOverlay');
const closeSupportBtn = document.getElementById('closeSupportBtn');
const backHistoryBtn = document.querySelector('.history-header .btn-icon, .history-header .icon-btn');
const quickActionChips = document.querySelectorAll('.action-chip');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true; // Track if a chat is currently open

function readPreference(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function writePreference(key, value) {
    try { localStorage.setItem(key, value); } catch {}
}


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';
    const controller = new AbortController();
    if (!options.signal) options.signal = controller.signal;
    const requestTimeout = setTimeout(() => controller.abort(), 35000);

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            throw new Error('Session expired');
        }
        if (res.status === 403) {
            const clone = res.clone();
            try {
                const body = await clone.json();
                if (body && (body.mode === 'read-only' || (body.error && body.error.includes('read-only')))) {
                    const pass = prompt('Session is in read-only mode. Enter password to elevate to control mode:');
                    if (pass) {
                        const elevateRes = await fetch('/api/elevate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: pass, totp: prompt('Authenticator code (leave blank if 2FA is disabled):') || '' })
                        });
                        const elevateData = await elevateRes.json();
                        if (elevateData.success) {
                            return await fetch(url, options);
                        } else {
                            alert('Elevation failed: ' + (elevateData.error || 'Incorrect password'));
                        }
                    }
                }
            } catch {}
        }
        return res;
    } catch (e) {
        throw e;
    } finally {
        clearTimeout(requestTimeout);
    }
}
const USER_SCROLL_LOCK_DURATION = 3000; // 3 seconds of scroll protection

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        // Mode Sync (Fast/Planning) - Desktop is source of truth
        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        // Model Sync - Desktop is source of truth
        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }

        // Project Sync - Desktop is source of truth
        if (data.project && data.project !== 'Unknown') {
            projectText.textContent = data.project;
        } else {
            projectText.textContent = 'Workspace idle · Retry';
        }

        // Right Inspector Panel sync
        const inspModel = document.getElementById('inspectorModel');
        if (inspModel && data.model) inspModel.textContent = data.model;
        const inspWs = document.getElementById('inspectorWorkspace');
        if (inspWs && data.project) inspWs.textContent = 'Workspace: ' + data.project;
        const inspSync = document.getElementById('inspectorSync');
        if (inspSync && (!lastSyncTimestamp || lastSyncTimestamp === 0)) {
            inspSync.textContent = 'Sync: Standby';
        }
        const inspMode = document.getElementById('inspectorMode');
        if (inspMode && data.mode) inspMode.textContent = 'Mode: ' + (data.mode || 'Control');

        const inspConn = document.getElementById('inspectorConnection');
        if (inspConn) {
            let connLabel = data.connectionType;
            if (!connLabel) {
                const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
                                    window.location.hostname.startsWith('192.168.') ||
                                    window.location.hostname.startsWith('10.');
                if (isLocalHost) {
                    connLabel = 'LAN';
                } else if (window.location.hostname.includes('trycloudflare.com')) {
                    connLabel = 'Tunnel (Cloudflare)';
                } else if (window.location.hostname.includes('ngrok')) {
                    connLabel = 'Tunnel (ngrok)';
                } else if (window.location.hostname.includes('pinggy')) {
                    connLabel = 'Tunnel (pinggy)';
                } else if (window.location.hostname.includes('loclx')) {
                    connLabel = 'Tunnel (loclx)';
                } else {
                    connLabel = 'Tunnel';
                }
            }
            inspConn.textContent = 'Connection: ' + connLabel;
        }

        const lanCardTitle = document.getElementById('lanCardTitleText');
        if (lanCardTitle && data.connectionType) {
            lanCardTitle.textContent = data.connectionType.startsWith('Tunnel') ? `${data.connectionType} Connection` : 'LAN Connection';
        }

        // System Telemetry Meters
        if (data.telemetry) {
            updateTelemetryDisplay(data.telemetry);
        }

        console.log('[SYNC] State refreshed from Desktop:', data);
    } catch (e) {
        console.error('[SYNC] Failed to sync state', e);
        if (projectText && (!projectText.textContent || projectText.textContent.includes('Checking') || projectText.textContent.includes('Loading'))) {
            projectText.textContent = 'Workspace idle · Retry';
        }
    }
}

function updateTelemetryDisplay(t) {
    if (!t) return;
    const cpuVal = document.getElementById('cpuValue');
    const cpuFill = document.getElementById('cpuFill');
    if (cpuVal && cpuFill) {
        cpuVal.textContent = t.cpuPercent + '%';
        cpuFill.style.width = t.cpuPercent + '%';
    }
    const memVal = document.getElementById('memoryValue');
    const memFill = document.getElementById('memoryFill');
    if (memVal && memFill) {
        memVal.textContent = `${t.memoryUsedGB} / ${t.memoryTotalGB} GB`;
        memFill.style.width = t.memoryPercent + '%';
    }
    const diskVal = document.getElementById('diskValue');
    const diskFill = document.getElementById('diskFill');
    if (diskVal && diskFill) {
        diskVal.textContent = t.diskPercent + '%';
        diskFill.style.width = t.diskPercent + '%';
    }
}

async function refreshTelemetry() {
    try {
        const res = await fetchWithAuth('/api/system-telemetry');
        const t = await res.json();
        updateTelemetryDisplay(t);
    } catch {}
}
setInterval(refreshTelemetry, 6000);

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:') return;

    // Check if user dismissed the banner before
    if (readPreference('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span style="display:inline-flex; align-items:center; gap:6px;"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> ${data.message}</span>
                <button id="sslReloadBtn">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
            
            // Add listener to the newly created button
            const reloadBtn = document.getElementById('sslReloadBtn');
            if (reloadBtn) reloadBtn.addEventListener('click', () => location.reload());
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    writePreference('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Models ---
const MODELS = [
    "Gemini 3.1 Pro (High)",
    "Gemini 3.1 Pro (Low)",
    "Gemini 3 Flash",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)"
];

// --- WebSocket ---
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 10000;
let wsReconnectTimer = null;

function connectWebSocket() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (navigator.onLine === false) {
        updateConnectionState('disconnected');
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    updateConnectionState('connecting');
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
        ws = new WebSocket(`${protocol}//${window.location.host}`);
    } catch (e) {
        console.error('WS creation failed:', e);
        scheduleReconnect();
        return;
    }

    const socket = ws;
    ws.onopen = () => {
        if (ws !== socket) return;
        console.log('WS Connected');
        wsReconnectDelay = 1000; // Reset backoff on successful connect
        updateConnectionState('connected');
        loadSnapshot();
        offerQueuedPrompts();
    };

    ws.onmessage = (event) => {
        if (ws !== socket) return;
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'error' && data.message === 'Unauthorized') {
                window.location.href = '/login.html';
                return;
            }
            if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
                loadSnapshot();
            }
        } catch (e) {
            console.warn('WS message parse error:', e);
        }
    };

    ws.onclose = (event) => {
        if (ws !== socket) return;
        if (event.code === 1008) {
            window.location.href = '/login.html';
            return;
        }
        console.log('WS Disconnected, code:', event.code);
        updateConnectionState('disconnected');
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.warn('WS Error:', err);
        // onclose will fire after onerror, so reconnect happens there
    };
}

function scheduleReconnect() {
    if (wsReconnectTimer) return; // Already scheduled
    if (navigator.onLine === false) {
        updateConnectionState('disconnected');
        return;
    }
    updateConnectionState('connecting');
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket();
        // Exponential backoff capped at max
        wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
    }, wsReconnectDelay);
}

window.addEventListener('offline', () => {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
    if (ws) ws.close();
    updateConnectionState('disconnected');
});
window.addEventListener('online', connectWebSocket);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // A mobile OS may suspend an open socket without delivering a close event.
    if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
    }
    connectWebSocket();
});

let syncingTextTimer = null;
function updateConnectionState(state) {
    if (syncingTextTimer) { clearTimeout(syncingTextTimer); syncingTextTimer = null; }
    const desktopStatusText = document.getElementById('desktopStatusText');
    const desktopStatusDot = document.getElementById('desktopStatusDot') || document.querySelector('.lan-card-title span:last-child');
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

    if (state === 'connected') {
        if (statusDot) {
            statusDot.className = 'live-dot connected';
        }
        if (statusText) statusText.textContent = 'Live';
        if (desktopStatusDot) {
            desktopStatusDot.className = 'status-dot-green';
        }
        if (desktopStatusText) {
            desktopStatusText.textContent = `Connected · Port ${port}`;
        }
    } else if (state === 'connecting') {
        if (statusDot) {
            statusDot.className = 'live-dot connecting';
        }
        if (statusText) statusText.textContent = 'Connecting...';
        if (desktopStatusDot) {
            desktopStatusDot.className = 'status-dot-amber';
        }
        if (desktopStatusText) {
            desktopStatusText.textContent = `Connecting · Port ${port}...`;
        }
    } else { // 'disconnected'
        if (statusDot) {
            statusDot.className = 'live-dot disconnected';
        }
        if (statusText) statusText.textContent = navigator.onLine === false ? 'Offline' : 'Disconnected';
        if (desktopStatusDot) {
            desktopStatusDot.className = 'status-dot-red';
        }
        if (desktopStatusText) {
            desktopStatusText.textContent = 'Disconnected · Retrying';
        }
    }
}

function updateStatus(connected) {
    updateConnectionState(connected ? 'connected' : 'disconnected');
}

function showSyncing() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        statusText.textContent = 'Syncing...';
        if (syncingTextTimer) clearTimeout(syncingTextTimer);
        syncingTextTimer = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                statusText.textContent = 'Live';
            }
        }, 800);
    }
}


// --- Honest Sync State & Relative Timestamp Ledger ---
let lastSyncTimestamp = 0;
function updateSyncTimestampDisplay() {
    const statsText = document.getElementById('statsText');
    const inspSync = document.getElementById('inspectorSync');
    if (!lastSyncTimestamp || lastSyncTimestamp === 0) {
        if (statsText) statsText.textContent = 'Sync: Standby';
        if (inspSync) inspSync.textContent = 'Sync: Standby';
        return;
    }
    const diffSec = Math.floor((Date.now() - lastSyncTimestamp) / 1000);
    let timeStr = '';
    if (diffSec < 5) {
        timeStr = 'Sync: Live · just now';
    } else if (diffSec < 60) {
        timeStr = 'Sync: Live · ' + diffSec + 's ago';
    } else {
        const mins = Math.floor(diffSec / 60);
        timeStr = 'Sync: Live · ' + mins + 'm ago';
    }
    if (statsText) statsText.textContent = timeStr;
    if (inspSync) inspSync.textContent = timeStr;
}
setInterval(updateSyncTimestampDisplay, 10000);

async function refreshSyncManifestStatus() {
    try {
        const res = await fetchWithAuth('/api/sync-manifest');
        const manifest = await res.json();
        const statsText = document.getElementById('statsText');
        const inspSync = document.getElementById('inspectorSync');

        if (manifest.exists && manifest.lastSyncTimestamp > 0) {
            lastSyncTimestamp = manifest.lastSyncTimestamp;
            updateSyncTimestampDisplay();
        } else if (manifest.exists) {
            if (statsText) statsText.textContent = 'Sync: Initialized';
            if (inspSync) inspSync.textContent = 'Sync: Initialized';
        } else {
            if (statsText) statsText.textContent = 'Sync: Standby';
            if (inspSync) inspSync.textContent = 'Sync: Standby';
        }
    } catch (e) {
        updateSyncTimestampDisplay();
    }
}
setInterval(refreshSyncManifestStatus, 30000);
refreshSyncManifestStatus();

// --- Rendering ---
async function loadSnapshot() {
    showSyncing();
    try {
        // Add spin animation to refresh button
        const icon = refreshBtn.querySelector('svg');
        icon.classList.remove('spin-anim');
        void icon.offsetWidth; // trigger reflow
        icon.classList.add('spin-anim');

        const response = await fetchWithAuth('/snapshot');
        if (!response.ok) {
            if (response.status === 503) {
                // No snapshot available - likely no chat open
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        // Mark chat as open since we got a valid snapshot
        chatIsOpen = true;

        const data = await response.json();

        // Capture scroll state BEFORE updating content
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        // --- UPDATE STATS & TIMESTAMP ---
        lastSyncTimestamp = Date.now();
        updateSyncTimestampDisplay();

        // --- CSS INJECTION (Cached) ---
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const paperThemeOverrides = '/* --- BASE SNAPSHOT CSS --- */\n' +
            data.css +
            '\n\n/* --- INK & PAPER CONVERSATION ADAPTATIONS --- */\n' +
            ':root {\n' +
            '    --bg-app: transparent;\n' +
            '    --text-main: var(--text);\n' +
            '    --text-muted: var(--text-2);\n' +
            '    --border-color: var(--rule);\n' +
            '}\n' +
            '\n' +
            '#conversation, #chat, #cascade {\n' +
            '    background-color: transparent !important;\n' +
            '    color: var(--text) !important;\n' +
            '    font-family: inherit !important;\n' +
            '    position: relative !important;\n' +
            '    height: auto !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '\n' +
            '#conversation > div, #chat > div, #cascade > div {\n' +
            '    position: static !important;\n' +
            '}\n' +
            '[style*="position: absolute"], [style*="position: fixed"],\n' +
            '[data-headlessui-state], [id*="headlessui"] {\n' +
            '    position: absolute !important;\n' +
            '}\n' +
            '\n' +
            '#conversation p, #chat p, #cascade p, #conversation span, #chat span, #cascade span, #conversation div, #chat div, #cascade div {\n' +
            '    color: inherit !important;\n' +
            '}\n' +
            '\n' +
            '#conversation a, #chat a, #cascade a {\n' +
            '    color: var(--info) !important;\n' +
            '    text-decoration: underline;\n' +
            '}\n' +
            '\n' +
            'img[src^="/c:"], img[src^="/C:"], img[src*="AppData"] {\n' +
            '    display: none !important;\n' +
            '}\n' +
            'img, svg {\n' +
            '    display: inline !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            'div:has(> img[src^="data:"]), div:has(> img[alt]), span:has(> img) {\n' +
            '    display: inline !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            '[class*="inline-flex"], [class*="inline-block"], [class*="items-center"]:has(img) {\n' +
            '    display: inline-flex !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            '\n' +
            ':not(pre) > code {\n' +
            '    padding: 1px 4px !important;\n' +
            '    border-radius: var(--radius-xs) !important;\n' +
            '    background-color: var(--surface-sunken) !important;\n' +
            '    color: var(--text) !important;\n' +
            '    font-family: \'JetBrains Mono\', monospace !important;\n' +
            '    font-size: 0.85em !important;\n' +
            '    border: 1px solid var(--rule) !important;\n' +
            '}\n' +
            '\n' +
            'pre, code, .monaco-editor-background, [class*="terminal"] {\n' +
            '    background-color: var(--surface-sunken) !important;\n' +
            '    color: var(--text) !important;\n' +
            '    font-family: \'JetBrains Mono\', monospace !important;\n' +
            '    border-radius: var(--radius-xs);\n' +
            '    border: 1px solid var(--rule) !important;\n' +
            '}\n' +
            '\n' +
            'pre {\n' +
            '    position: relative !important;\n' +
            '    white-space: pre-wrap !important;\n' +
            '    word-break: break-word !important;\n' +
            '    padding: 8px 10px !important;\n' +
            '    margin: 6px 0 !important;\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '\n' +
            'pre.has-copy-btn {\n' +
            '    padding-right: 32px !important;\n' +
            '}\n' +
            '\n' +
            'pre.single-line-pre {\n' +
            '    display: inline-block !important;\n' +
            '    width: auto !important;\n' +
            '    max-width: 100% !important;\n' +
            '    padding: 2px 6px !important;\n' +
            '    margin: 0px !important;\n' +
            '    vertical-align: middle !important;\n' +
            '    background-color: var(--surface-sunken) !important;\n' +
            '    font-size: 0.85em !important;\n' +
            '}\n' +
            '\n' +
            'pre.single-line-pre > code {\n' +
            '    display: inline !important;\n' +
            '    white-space: nowrap !important;\n' +
            '}\n' +
            '\n' +
            'pre:not(.single-line-pre) > code {\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '    overflow-x: auto !important;\n' +
            '    background: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '\n' +
            '.mobile-copy-btn {\n' +
            '    position: absolute !important;\n' +
            '    top: 4px !important;\n' +
            '    right: 4px !important;\n' +
            '    background: var(--surface) !important;\n' +
            '    color: var(--text-2) !important;\n' +
            '    border: 1px solid var(--rule) !important;\n' +
            '    width: 24px !important;\n' +
            '    height: 24px !important;\n' +
            '    padding: 0 !important;\n' +
            '    cursor: pointer !important;\n' +
            '    display: flex !important;\n' +
            '    align-items: center !important;\n' +
            '    justify-content: center !important;\n' +
            '    border-radius: var(--radius-xs) !important;\n' +
            '    transition: all 0.15s ease !important;\n' +
            '    z-index: 10 !important;\n' +
            '}\n' +
            '\n' +
            '.mobile-copy-btn:hover {\n' +
            '    background: var(--surface-raised) !important;\n' +
            '    color: var(--text) !important;\n' +
            '}\n' +
            '\n' +
            'blockquote {\n' +
            '    border-left: 2px solid var(--rule-strong) !important;\n' +
            '    background: var(--surface-sunken) !important;\n' +
            '    color: var(--text-2) !important;\n' +
            '    padding: 6px 12px !important;\n' +
            '    margin: 6px 0 !important;\n' +
            '}\n' +
            '\n' +
            'table {\n' +
            '    border-collapse: collapse !important;\n' +
            '    width: 100% !important;\n' +
            '    border: 1px solid var(--rule) !important;\n' +
            '}\n' +
            'th, td {\n' +
            '    border: 1px solid var(--rule) !important;\n' +
            '    padding: 6px 10px !important;\n' +
            '    color: var(--text) !important;\n' +
            '}\n' +
            '\n' +
            '::-webkit-scrollbar {\n' +
            '    width: 0 !important;\n' +
            '}\n' +
            '\n' +
            '[style*="background-color: rgb(255, 255, 255)"],\n' +
            '[style*="background-color: white"],\n' +
            '[style*="background: white"] {\n' +
            '    background-color: transparent !important;\n' +
            '}';
        styleTag.textContent = paperThemeOverrides;
        chatContent.innerHTML = data.html;


        // Add mobile copy buttons to all code blocks
        addMobileCopyButtons();

        // Smart scroll behavior: respect user scroll, only auto-scroll when appropriate
        if (isUserScrollLocked) {
            // User recently scrolled - try to maintain their approximate position
            // Use percentage-based restoration for better accuracy
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            const newScrollPos = chatContainer.scrollHeight * scrollPercent;
            chatContainer.scrollTop = newScrollPos;
        } else if (isNearBottom || scrollPos === 0) {
            // User was at bottom or hasn't scrolled - auto scroll to bottom
            scrollToBottom();
        } else {
            // Preserve exact scroll position
            chatContainer.scrollTop = scrollPos;
        }

    } catch (err) {
        console.error(err);
    }
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// --- Inputs ---
let messageSending = false;

async function dispatchMessage(message) {
    if (!chatIsOpen) {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not open a new chat.');
        await new Promise(resolve => setTimeout(resolve, 800));
        chatIsOpen = true;
    }
    const res = await fetchWithAuth('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (!res.ok || data.success !== true) throw new Error(data.error || 'Delivery was not confirmed.');
}

async function offerQueuedPrompts() {
    const queue = window.QuantaOfflineQueue;
    if (!queue || queue.isReplaying || messageSending) return;
    const items = await queue.getPendingPrompts();
    if (messageSending || queue.isReplaying || !items.length || !confirm(`You have ${items.length} queued message(s). Send them to the current IDE chat?`)) return;
    messageSending = true;
    sendBtn.disabled = true;
    try {
        await queue.replayPending(async item => {
            try {
                await dispatchMessage(item.prompt);
                return true;
            } catch {
                showToast('Queued message kept. Check the IDE chat before retrying.');
                return false;
            }
        });
        loadSnapshot();
    } finally {
        messageSending = false;
        sendBtn.disabled = false;
    }
}

async function sendMessage() {
    if (messageSending) return;
    const message = messageInput.value.trim();
    if (!message) return;

    if (navigator.onLine === false) {
        messageSending = true;
        const previousValue = messageInput.value;
        sendBtn.disabled = true;
        try {
            const record = await window.QuantaOfflineQueue.enqueuePrompt(message);
            if (messageInput.value === previousValue) messageInput.value = '';
            showToast(record.memoryOnly ? 'Queued for this tab. Keep it open until connected.' : 'Queued. You can confirm sending after reconnecting.');
        } catch {
            showToast('Could not queue message. Your draft is still here.');
        } finally {
            messageSending = false;
            sendBtn.disabled = false;
        }
        return;
    }

    messageSending = true;
    const previousValue = messageInput.value;
    sendBtn.disabled = true;
    try {
        await dispatchMessage(message);
        // Preserve anything typed while the request was in flight.
        if (messageInput.value === previousValue) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }
        setAgentExecuting(true);
        setTimeout(loadSnapshot, 300);
        setTimeout(checkChatStatus, 1000);
    } catch (error) {
        showToast('Delivery not confirmed. Draft kept. Check the chat before retrying.');
        setTimeout(loadSnapshot, 500);
    } finally {
        messageSending = false;
        sendBtn.disabled = false;
    }
}

// --- Event Listeners ---
sendBtn.addEventListener('click', sendMessage);

refreshBtn.addEventListener('click', () => {
    // Refresh both Chat and State (Mode/Model)
    loadSnapshot();
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// --- Support Modal Logic ---
if (supportBtn) {
    supportBtn.addEventListener('click', () => {
        if (supportOverlay) {
            supportOverlay.classList.add('show');
        }
    });
}

if (closeSupportBtn) {
    closeSupportBtn.addEventListener('click', () => {
        if (supportOverlay) {
            supportOverlay.classList.remove('show');
        }
    });
}

if (supportOverlay) {
    supportOverlay.addEventListener('click', (e) => {
        if (e.target === supportOverlay) {
            supportOverlay.classList.remove('show');
        }
    });
}

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollPercent = chatContainer.scrollTop / (chatContainer.scrollHeight - chatContainer.clientHeight);
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Antigravity uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 300);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Quick Actions ---
function quickAction(text, autoSend = false) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    if (autoSend) {
        sendMessage();
    } else {
        messageInput.focus();
    }
}

// --- Agent Execution & Hold-to-Confirm Stop Logic ---
function setAgentExecuting(isExecuting) {
    if (!stopBtn) return;
    if (isExecuting) {
        stopBtn.classList.add('agent-active');
    } else {
        stopBtn.classList.remove('agent-active');
        stopBtn.classList.remove('holding');
    }
}

let stopHoldTimer = null;
const STOP_HOLD_DURATION = 900;

function startStopHold(e) {
    if (!stopBtn || !stopBtn.classList.contains('agent-active')) return;
    stopBtn.classList.add('holding');
    if (stopHoldTimer) clearTimeout(stopHoldTimer);
    stopHoldTimer = setTimeout(async () => {
        stopBtn.classList.remove('holding');
        stopHoldTimer = null;
        await triggerStopAction();
    }, STOP_HOLD_DURATION);
}

function cancelStopHold() {
    if (stopHoldTimer) {
        clearTimeout(stopHoldTimer);
        stopHoldTimer = null;
    }
    if (stopBtn) stopBtn.classList.remove('holding');
}

async function triggerStopAction() {
    if (!stopBtn) return;
    stopBtn.style.opacity = '0.5';
    showToast('Stopping agent execution...');
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Agent execution stopped');
            setAgentExecuting(false);
            setTimeout(loadSnapshot, 500);
        } else {
            showToast('Stop error: ' + (data.error || 'Failed to stop'));
        }
    } catch (e) {
        showToast('Stop failed: ' + e.message);
    } finally {
        setTimeout(() => { if (stopBtn) stopBtn.style.opacity = '1'; }, 400);
    }
}

if (stopBtn) {
    stopBtn.addEventListener('mousedown', startStopHold);
    stopBtn.addEventListener('touchstart', startStopHold, { passive: true });
    stopBtn.addEventListener('mouseup', cancelStopHold);
    stopBtn.addEventListener('mouseleave', cancelStopHold);
    stopBtn.addEventListener('touchend', cancelStopHold);
    stopBtn.addEventListener('touchcancel', cancelStopHold);
    stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
    });
}

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Chat History Logic ---
async function showChatHistory() {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div class="history-state-container">
            <div class="history-spinner"></div>
            <div class="history-state-text">Loading History...</div>
        </div>
    `;
    historyLayer.classList.add('show');
    historyBtn.style.opacity = '1';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();

        if (data.error) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon"><svg viewBox="0 0 24 24" width="36" height="36" stroke="#f59e0b" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
                    <div class="history-state-title">Error loading history</div>
                    <div class="history-state-desc">${data.error}</div>
                    <button class="history-new-btn mt-4">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            return;
        }

        const chats = data.chats || [];
        if (chats.length === 0) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon"><svg viewBox="0 0 24 24" width="36" height="36" stroke="var(--text-muted)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></div>
                    <div class="history-state-title">No recent chats found</div>
                    <div class="history-state-desc">Start a new conversation to see them here.</div>
                    <button class="history-new-btn mt-4">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            return;
        }

        // Render chats
        let html = `
            <div class="history-action-container">
                <button class="history-new-btn">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    New Conversation
                </button>
            </div>
            <div class="history-list-group">
        `;

        chats.forEach(chat => {
            const safeTitle = chat.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            html += `
                <div class="history-card" data-title="${safeTitle}">
                    <div class="history-card-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </div>
                    <div class="history-card-content">
                        <span class="history-card-title">${escapeHtml(chat.title)}</span>
                    </div>
                    <div class="history-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                </div>
            `;
        });

        html += `</div>`;

        historyList.innerHTML = html;

    } catch (e) {
        historyList.innerHTML = `
            <div class="history-state-container">
                <div class="history-state-icon"><svg viewBox="0 0 24 24" width="36" height="36" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></div>
                <div class="history-state-title">Connection Error</div>
                <div class="history-state-desc">Failed to reach the server.</div>
            </div>
        `;
    }
}


function hideChatHistory() {
    historyLayer.classList.remove('show');
    // Send an escape key to Antigravity to close the History panel
    try {
        fetchWithAuth('/close-history', { method: 'POST' });
    } catch (e) {
        console.error('Failed to close history on desktop:', e);
    }
}

historyBtn.addEventListener('click', showChatHistory);

// --- Select Chat from History ---
async function selectChat(title) {
    // Visual reset while desktop switches conversation
    chatContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Switching Conversation...</p></div>';

    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        const data = await res.json();

        if (data.success) {
            // Persistent polling to catch delayed desktop render/update
            let attempts = 0;
            const poll = setInterval(async () => {
                await loadSnapshot();
                attempts++;
                if (attempts > 10) clearInterval(poll);
            }, 500);
        } else {
            console.error('Failed to select chat:', data.error);
            setTimeout(loadSnapshot, 500);
        }
    } catch (e) {
        console.error('Select chat error:', e);
        setTimeout(loadSnapshot, 500);
    }
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();

        chatIsOpen = data.hasChat || data.editorFound;

        if (data.isExecuting !== undefined) {
            setAgentExecuting(data.isExecuting);
        }

        if (!chatIsOpen) {
            showEmptyState();
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-emblem">
                <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="var(--gold-accent)" stroke-width="1.8">
                    <polygon points="12 2 22 7 12 12 2 7 12 2" />
                    <polyline points="2 12 12 17 22 12" />
                    <polyline points="2 17 12 22 22 17" />
                </svg>
            </div>
            <h1 class="empty-state-title">Your workspace, within reach.</h1>
            <div class="by-vyoma-group">QUANTA REMOTE · BY VYOMA GROUP</div>
            <p class="empty-state-desc">Review your agent’s work, continue a conversation, or take care of a quick task.</p>
            <button class="empty-state-btn" id="newChatFromEmptyBtn">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Start a conversation</span>
            </button>
            <div class="empty-state-grid">
                <div class="starter-card" data-starter="run-tests" role="button" tabindex="0">
                    <div class="starter-card-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><path d="M10 2v7.31M14 2v7.31M8.5 2h7M14 9.3a6.5 6.5 0 1 1-4 0"/></svg>
                    </div>
                    <div class="starter-card-body">
                        <div class="starter-card-title">Run Test Suite</div>
                        <div class="starter-card-desc">Execute unit tests & verify code</div>
                    </div>
                    <div class="starter-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                </div>
                <div class="starter-card" data-starter="git-status" role="button" tabindex="0">
                    <div class="starter-card-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
                    </div>
                    <div class="starter-card-body">
                        <div class="starter-card-title">Git Status</div>
                        <div class="starter-card-desc">Inspect modified files & branch</div>
                    </div>
                    <div class="starter-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                </div>
                <div class="starter-card" data-starter="approvals" role="button" tabindex="0">
                    <div class="starter-card-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    </div>
                    <div class="starter-card-body">
                        <div class="starter-card-title">Review Approvals</div>
                        <div class="starter-card-desc">Check pending execution requests</div>
                    </div>
                    <div class="starter-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                </div>
                <div class="starter-card" data-starter="cloud-sync" role="button" tabindex="0">
                    <div class="starter-card-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>
                    </div>
                    <div class="starter-card-body">
                        <div class="starter-card-title">Cloud Sync</div>
                        <div class="starter-card-desc">Two-way Google Drive workspace</div>
                    </div>
                    <div class="starter-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Settings Logic ---


function openModal(title, options, onSelect) {
    modalTitle.textContent = title;
    modalList.innerHTML = '';
    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'modal-option';
        div.textContent = opt;
        div.addEventListener('click', () => {
            onSelect(opt);
            closeModal();
        });
        modalList.appendChild(div);
    });
    modalOverlay.classList.add('show');
}

function closeModal() {
    modalOverlay.classList.remove('show');
}

modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
};

modeBtn.addEventListener('click', () => {
    openModal('Select Mode', ['Fast', 'Planning'], async (mode) => {
        modeText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
            });
            const data = await res.json();
            if (data.success) {
                currentMode = mode;
                modeText.textContent = mode;
                modeBtn.classList.toggle('active', mode === 'Planning');
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modeText.textContent = currentMode;
            }
        } catch (e) {
            modeText.textContent = currentMode;
        }
    });
});

modelBtn.addEventListener('click', async () => {
    const prev = modelText.textContent;
    modelText.textContent = 'Loading...';
    try {
        const res = await fetchWithAuth('/models');
        const data = await res.json();
        const modelsList = (data.models && data.models.length > 0) ? data.models : MODELS;
        
        modelText.textContent = prev;
        openModal('Select Model', modelsList, async (model) => {
            const innerPrev = modelText.textContent;
            modelText.textContent = 'Setting...';
            try {
                const setRes = await fetchWithAuth('/set-model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model })
                });
                const setData = await setRes.json();
                if (setData.success) {
                    modelText.textContent = model;
                } else {
                    alert('Error: ' + (setData.error || 'Unknown'));
                    modelText.textContent = innerPrev;
                }
            } catch (e) {
                modelText.textContent = innerPrev;
            }
        });
    } catch (e) {
        modelText.textContent = prev;
        openModal('Select Model', MODELS, async (model) => {
            const innerPrev = modelText.textContent;
            modelText.textContent = 'Setting...';
            try {
                const setRes = await fetchWithAuth('/set-model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model })
                });
                const setData = await setRes.json();
                if (setData.success) {
                    modelText.textContent = model;
                } else {
                    alert('Error: ' + (setData.error || 'Unknown'));
                    modelText.textContent = innerPrev;
                }
            } catch (err) {
                modelText.textContent = innerPrev;
            }
        });
    }
});

projectBtn.addEventListener('click', async () => {
    const prevText = projectText.textContent;
    projectText.textContent = 'Fetching...';
    
    try {
        const res = await fetchWithAuth('/projects');
        const data = await res.json();
        
        if (data.projects && data.projects.length > 0) {
            openModal('Select Project', data.projects, async (project) => {
                projectText.textContent = 'Switching...';
                try {
                    const selectRes = await fetchWithAuth('/select-project', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ project })
                    });
                    const selectData = await selectRes.json();
                    if (selectData.success) {
                        projectText.textContent = project;
                        // Rapidly update state and snapshot
                        setTimeout(fetchAppState, 800);
                        setTimeout(loadSnapshot, 1000);
                        setTimeout(loadSnapshot, 2500);
                    } else {
                        alert('Error switching project: ' + (selectData.error || 'Unknown'));
                        projectText.textContent = prevText;
                    }
                } catch(e) {
                    projectText.textContent = prevText;
                }
            });
        } else {
            alert('No projects detected in the current view.');
            projectText.textContent = prevText;
        }
    } catch(e) {
        projectText.textContent = prevText;
        alert('Failed to load projects list.');
    }
});

// --- Viewport / Keyboard Handling ---
// This fixes the issue where the keyboard hides the input or layout breaks
if (window.visualViewport) {
    function handleResize() {
        // Resize the body to match the visual viewport (screen minus keyboard)
        if (window.visualViewport.scale !== 1) return;
        document.body.style.height = window.visualViewport.height + 'px';

        // Scroll to bottom if keyboard opened
        if (document.activeElement === messageInput) {
            setTimeout(scrollToBottom, 100);
        }
    }

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
    handleResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (Thinking/Thought) ---
chatContainer.addEventListener('click', async (e) => {
    // Strategy: Check if the clicked element OR its parent contains "Thought" or "Thinking" text.
    // This handles both opening (collapsed) and closing (expanded) states.

    // 1. Find the nearest container that might be the "Thought" block
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';

    // Check if this looks like a clickable UI toggle from Antigravity/Cascade
    // Includes: Thought blocks, Worked status, Edited files status, and File lists
    const isUiToggle = /Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(text) && text.length < 500;

    if (isUiToggle) {
        // Visual feedback - briefly dim the clicked element
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        // Extract just the first line for matching
        const firstLine = text.split('\n')[0].trim();

        // Determine which occurrence of this text the user tapped
        // This handles multiple Thought blocks with identical labels
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elText = el.innerText || '';
            const elFirstLine = elText.split('\n')[0].trim();

            // Only count if it looks like a UI toggle and matches the first line exactly
            if (/Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(elText) && elText.length < 500 && elFirstLine === firstLine) {
                // If this is our target (or contains it), we've found the correct index
                if (el === target || el.contains(target)) {
                    break;
                }
                tapIndex++;
            }
        }

        try {
            const response = await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine  // Use first line for more reliable matching
                })
            });

            // Reload snapshot multiple times to catch the UI change
            // Desktop animation takes time, so we poll a few times
            setTimeout(loadSnapshot, 400);   // Quick check
            setTimeout(loadSnapshot, 800);   // After animation starts
            setTimeout(loadSnapshot, 1500);  // After animation completes
        } catch (e) {
            console.error('Remote click failed:', e);
        }
        return;
    }

    // --- Command Action Buttons (Run, Reject, Allow, Deny, etc.) ---
    const btn = e.target.closest('button, [role="button"]');
    if (btn) {
        const btnText = (btn.innerText || '').trim();

        // Match various action keywords
        const actionKeywords = [
            'Allow this conversation', 'Always allow', 'Allow once',
            'Review changes', 'Review',
            'Confirm', 'Accept', 'Reject', 'Discard',
            'Allow', 'Deny', 'Apply', 'Save', 'Run',
            'Yes', 'No'
        ];

        const btnTextLower = btnText.toLowerCase();
        const matchedKeyword = actionKeywords.find(kw =>
            btnTextLower.includes(kw.toLowerCase())
        );
        if (matchedKeyword) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);

            // Determine which occurrence of this button text the user tapped
            const allButtons = Array.from(chatContainer.querySelectorAll('button, [role="button"]'));

            // Filter to only those that match our specific keyword
            const matchingButtons = allButtons.filter(b =>
                (b.innerText || '').toLowerCase().includes(matchedKeyword.toLowerCase())
            );
            const btnIndex = matchingButtons.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: btn.tagName.toLowerCase() === 'button' ? 'button' : '[role="button"]',
                        index: btnIndex >= 0 ? btnIndex : 0,
                        textContent: matchedKeyword
                    })
                });

                // Rapidly poll for updates as actions usually trigger DOM changes
                setTimeout(loadSnapshot, 400);
                setTimeout(loadSnapshot, 1000);
                setTimeout(loadSnapshot, 2500);
            } catch (err) {
                console.error('Remote button click failed:', err);
            }
        }
    }
});

// --- Initial Event Listeners (Refactored from inline) ---
if (enableHttpsBtn) enableHttpsBtn.addEventListener('click', enableHttps);
if (dismissSslBtn) dismissSslBtn.addEventListener('click', dismissSslBanner);
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (backHistoryBtn) backHistoryBtn.addEventListener('click', hideChatHistory);

// Global Header & Inspector Listeners (Image 2)
document.getElementById('btnOpenNewWindow')?.addEventListener('click', () => {
    window.open(window.location.href, '_blank');
});

// --- Command Palette / Search Modal Logic ---
const searchModalOverlay = document.getElementById('searchModalOverlay');
const paletteSearchInput = document.getElementById('paletteSearchInput');
const paletteResultsList = document.getElementById('paletteResultsList');
const closeSearchModalBtn = document.getElementById('closeSearchModalBtn');

const paletteItems = [
    { title: 'Run Test Suite', category: 'Action', run: () => quickAction('npm test', true) },
    { title: 'Git Status & Diffs', category: 'Action', run: () => quickAction('git status', true) },
    { title: 'Review Approvals', category: 'Navigation', run: () => switchTab('tabApprovals') },
    { title: 'Agent Task Queue', category: 'Navigation', run: () => switchTab('tabQueue') },
    { title: 'Execution Timeline', category: 'Navigation', run: () => switchTab('tabTimeline') },
    { title: 'Developer Tools & Diagnostics', category: 'Navigation', run: () => switchTab('tabTools') },
    { title: 'Google Drive Sync Status', category: 'Cloud', run: () => { switchTab('tabTools'); document.getElementById('toolCloudSync')?.click(); } },
    { title: 'Explain Code in Current Scope', category: 'Prompt', run: () => quickAction('Explain this code in detail.', false) },
    { title: 'Find and Fix Bugs in Code', category: 'Prompt', run: () => quickAction('Analyze and fix errors or bugs in this code.', false) },
    { title: 'Generate Documentation', category: 'Prompt', run: () => quickAction('Generate documentation for this module.', false) },
    { title: 'Switch Theme: Graphite (Dark)', category: 'Appearance', run: () => switchTheme('graphite') },
    { title: 'Switch Theme: Paper (Light)', category: 'Appearance', run: () => switchTheme('paper') },
    { title: 'Switch Theme: Ink (OLED)', category: 'Appearance', run: () => switchTheme('ink') }
];

function renderPaletteItems(filter = '') {
    if (!paletteResultsList) return;
    const query = filter.toLowerCase().trim();
    const matches = paletteItems.filter(item => 
        !query || item.title.toLowerCase().includes(query) || item.category.toLowerCase().includes(query)
    );

    if (matches.length === 0) {
        paletteResultsList.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-2); font-size: 13px;">No matching actions found.</div>`;
        return;
    }

    paletteResultsList.innerHTML = matches.map((item, idx) => `
        <div class="palette-item" data-idx="${idx}" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease;">
            <span style="font-size: 13px; font-weight: 500; color: var(--text);">${escapeHtml(item.title)}</span>
            <span style="font-size: 10.5px; font-family: 'JetBrains Mono', monospace; text-transform: uppercase; color: var(--gold-accent); background: rgba(217,164,65,0.08); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--gold-border);">${escapeHtml(item.category)}</span>
        </div>
    `).join('');

    paletteResultsList.querySelectorAll('.palette-item').forEach((el, i) => {
        el.addEventListener('mouseenter', () => {
            el.style.background = 'rgba(217, 164, 65, 0.12)';
        });
        el.addEventListener('mouseleave', () => {
            el.style.background = 'transparent';
        });
        el.addEventListener('click', () => {
            closeSearchModal();
            matches[i].run();
        });
    });
}

function openSearchModal() {
    if (!searchModalOverlay) return;
    searchModalOverlay.style.display = 'flex';
    searchModalOverlay.classList.add('active', 'show');
    if (paletteSearchInput) {
        paletteSearchInput.value = '';
        renderPaletteItems('');
        setTimeout(() => paletteSearchInput.focus(), 50);
    }
}

function closeSearchModal() {
    if (!searchModalOverlay) return;
    searchModalOverlay.style.display = 'none';
    searchModalOverlay.classList.remove('active', 'show');
}

paletteSearchInput?.addEventListener('input', (e) => {
    renderPaletteItems(e.target.value);
});

closeSearchModalBtn?.addEventListener('click', closeSearchModal);
searchModalOverlay?.addEventListener('click', (e) => {
    if (e.target === searchModalOverlay) closeSearchModal();
});

// --- Help & Shortcuts Modal Logic ---
const helpModalOverlay = document.getElementById('helpModalOverlay');
const closeHelpModalBtn = document.getElementById('closeHelpModalBtn');

function openHelpModal() {
    if (!helpModalOverlay) return;
    helpModalOverlay.style.display = 'flex';
    helpModalOverlay.classList.add('active', 'show');
}

function closeHelpModal() {
    if (!helpModalOverlay) return;
    helpModalOverlay.style.display = 'none';
    helpModalOverlay.classList.remove('active', 'show');
}

closeHelpModalBtn?.addEventListener('click', closeHelpModal);
helpModalOverlay?.addEventListener('click', (e) => {
    if (e.target === helpModalOverlay) closeHelpModal();
});

document.getElementById('btnGlobalSearch')?.addEventListener('click', openSearchModal);
document.getElementById('btnGlobalHelp')?.addEventListener('click', openHelpModal);

// Global Keyboard Navigation (Esc to close, Ctrl+K/Ctrl+F to search)
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
        closeSearchModal();
        closeHelpModal();
        if (addTaskOverlay) {
            addTaskOverlay.style.display = 'none';
            addTaskOverlay.classList.remove('active', 'show');
        }
        hideChatHistory();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f') && !e.shiftKey) {
        e.preventDefault();
        openSearchModal();
    }
});

document.getElementById('btnGlobalNotif')?.addEventListener('click', () => {
    switchTab('tabApprovals');
});

document.getElementById('moreOptionsBtn')?.addEventListener('click', () => {
    switchTab('tabTools');
});

quickActionChips.forEach(chip => {
    chip.addEventListener('click', () => {
        const actionText = chip.getAttribute('data-action') || chip.innerText.trim();
        if (actionText === 'Continue') {
            quickAction('Continue', true);
        } else if (actionText.includes('Explain')) {
            quickAction('Explain this code in a clear and detailed manner.', false);
        } else if (actionText.includes('Fix')) {
            quickAction('Please analyze and fix the errors or bugs in this code.', false);
        } else if (actionText.includes('Create Docs')) {
            quickAction('Please create or update documentation for this code.', false);
        } else if (actionText.includes('Run Tests')) {
            quickAction('Run tests and verify the current codebase status.', true);
        } else if (actionText.includes('Git Status')) {
            quickAction('Run git status and show current workspace diffs.', true);
        } else {
            quickAction(actionText, false);
        }
    });
});

// Delegation for dynamic history items
if (historyList) {
    historyList.addEventListener('click', (e) => {
        const newBtn = e.target.closest('.history-new-btn');
        const card = e.target.closest('.history-card');
        
        if (newBtn) {
            hideChatHistory();
            startNewChat();
        } else if (card) {
            const title = card.getAttribute('data-title');
            hideChatHistory();
            selectChat(title);
        }
    });
}

// Delegation for empty state & starter cards
chatContent.addEventListener('click', (e) => {
    if (e.target.closest('#newChatFromEmptyBtn')) {
        startNewChat();
        return;
    }
    const starter = e.target.closest('.starter-card');
    if (starter) {
        const action = starter.getAttribute('data-starter');
        if (action === 'run-tests') {
            switchTab('tabTools');
            document.getElementById('toolRunTests')?.click();
        } else if (action === 'git-status') {
            switchTab('tabTools');
            document.getElementById('toolGitStatus')?.click();
        } else if (action === 'approvals') {
            switchTab('tabApprovals');
        } else if (action === 'cloud-sync') {
            switchTab('tabTools');
            document.getElementById('toolCloudSync')?.click();
        }
    }
});

// --- Init ---
connectWebSocket();
// Sync state initially and periodically (reduced frequency to minimize network chatter)
fetchAppState();
setInterval(fetchAppState, 15000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 30000);

// --- File Upload Listeners ---
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');

if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => {
        fileInput.click();
    });
    
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        
        // Show status
        const originalText = statusText.textContent;
        statusText.textContent = 'Uploading...';
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const res = await fetch('/upload-file', {
                method: 'POST',
                body: formData,
                headers: {
                    'ngrok-skip-browser-warning': 'true'
                }
            });
            const data = await res.json();
            if (data.success) {
                // Show floating notification toast
                showToast(`Uploaded: ${file.name}`);
                
                // Append text reference in input box
                const prevVal = messageInput.value.trim();
                messageInput.value = (prevVal ? prevVal + ' ' : '') + `[File: ${file.name}]`;
                messageInput.style.height = 'auto';
                messageInput.style.height = messageInput.scrollHeight + 'px';
                messageInput.focus();
            } else {
                alert('Upload failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            console.error('Upload failed:', e);
            alert('Upload connection failed');
        } finally {
            statusText.textContent = originalText;
            fileInput.value = ''; // Reset input selection
        }
    });
}

// ==========================================
// Quanta IDE Multi-Tab Navigation & Views
// Authors: Akira-official & dark-yoddha
// ==========================================

// Tab Switching across Desktop left rail (.desktop-sidebar) and Mobile bottom bar (.bottom-nav)
const navTabs = document.querySelectorAll('.nav-item, .nav-tab, .rail-nav-item');
const tabPanels = document.querySelectorAll('.tab-view, .tab-panel');
const approvalsBadge = document.getElementById('approvalsBadge');

function switchTab(targetTabId) {
    const allNav = document.querySelectorAll('.nav-item, .nav-tab, .rail-nav-item');
    const allPanels = document.querySelectorAll('.tab-view, .tab-panel');

    allNav.forEach(t => {
        if (t.getAttribute('data-tab') === targetTabId) {
            t.classList.add('active');
            t.setAttribute('aria-selected', 'true');
        } else {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        }
    });

    allPanels.forEach(p => {
        if (p.id === targetTabId) {
            p.classList.add('active');
        } else {
            p.classList.remove('active');
        }
    });

    if (targetTabId === 'tabApprovals') fetchApprovals();
    else if (targetTabId === 'tabQueue') fetchQueue();
    else if (targetTabId === 'tabTimeline') fetchTimeline();
}

navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTab = tab.getAttribute('data-tab');
        if (targetTab) switchTab(targetTab);
    });
});

function updateApprovalsBadge(count) {
    const desktopBadge = document.getElementById('desktopApprovalsBadge');
    const mobileBadge = document.getElementById('approvalsBadge');
    const globalNotif = document.getElementById('globalNotifCount');

    const num = typeof count === 'number' ? count : (Array.isArray(count) ? count.length : 0);

    if (num > 0) {
        if (desktopBadge) {
            desktopBadge.style.display = 'inline-block';
            desktopBadge.textContent = num;
        }
        if (mobileBadge) {
            mobileBadge.style.display = 'block';
            mobileBadge.textContent = num;
        }
        if (globalNotif) {
            globalNotif.style.display = 'flex';
            globalNotif.textContent = num;
        }
    } else {
        if (desktopBadge) {
            desktopBadge.style.display = 'none';
            desktopBadge.textContent = '0';
        }
        if (mobileBadge) {
            mobileBadge.style.display = 'none';
            mobileBadge.textContent = '0';
        }
        if (globalNotif) {
            globalNotif.style.display = 'none';
            globalNotif.textContent = '0';
        }
    }
}

// Approvals Logic
async function fetchApprovals() {
    try {
        const res = await fetchWithAuth('/api/approvals');
        const approvals = await res.json();
        const listEl = document.getElementById('approvalsList');
        if (!listEl) return;

        updateApprovalsBadge(approvals);

        if (approvals.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; margin-top: 30px;">No pending approvals.</p>';
            return;
        }

        listEl.innerHTML = approvals.map(a => {
            const riskClass = a.risk === 'dangerous' ? 'risk-dangerous' : (a.risk === 'caution' ? 'risk-caution' : 'risk-safe');
            return `
                <div class="approval-card" id="approval-${a.id}">
                    <div class="approval-header">
                        <strong style="font-size: 14px;">${escapeHtml(a.action)}</strong>
                        <span class="risk-badge ${riskClass}">${escapeHtml(a.risk)}</span>
                    </div>
                    ${a.command ? `<div class="approval-command">${escapeHtml(a.command)}</div>` : ''}
                    <div style="font-size: 11px; color: var(--text-muted);">Target: ${escapeHtml(a.targetPath || 'workspace')}</div>
                    <div class="approval-actions">
                        <button class="btn-approve" onclick="resolveApproval('${a.id}', 'approve')">Approve</button>
                        <button class="btn-reject" onclick="resolveApproval('${a.id}', 'reject')">Reject</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.warn('Failed to fetch approvals:', e);
    }
}

window.resolveApproval = async function(id, decision) {
    try {
        const res = await fetchWithAuth(`/api/approvals/${id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Action ${decision}d`);
            fetchApprovals();
        } else {
            alert('Failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Connection error resolving approval');
    }
};

// Queue Logic
async function fetchQueue() {
    try {
        const res = await fetchWithAuth('/api/queue');
        const status = await res.json();
        const listEl = document.getElementById('queueList');
        if (!listEl) return;

        let html = '';
        if (status.activeTask) {
            html += `
                <div class="queue-card" style="border-color: var(--accent);">
                    <div style="font-weight: 600; font-size: 13px; color: var(--accent);">Active Task</div>
                    <div class="queue-prompt">${escapeHtml(status.activeTask.prompt)}</div>
                    <div class="queue-meta">
                        <span>ID: ${status.activeTask.id}</span>
                        <span>Started ${new Date(status.activeTask.startedAt).toLocaleTimeString()}</span>
                    </div>
                </div>
            `;
        }

        if (status.pending && status.pending.length > 0) {
            html += status.pending.map((t, idx) => `
                <div class="queue-card">
                    <div class="queue-prompt">#${idx + 1}: ${escapeHtml(t.prompt)}</div>
                    <div class="queue-meta">
                        <span>Priority: ${t.priority}</span>
                        <button style="background: none; border: none; color: var(--error); cursor: pointer;" onclick="cancelTask('${t.id}')">Cancel</button>
                    </div>
                </div>
            `).join('');
        }

        if (!status.activeTask && (!status.pending || status.pending.length === 0)) {
            html = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; margin-top: 30px;">Queue is currently empty.</p>';
        }

        listEl.innerHTML = html;
    } catch (e) {
        console.warn('Failed to fetch queue:', e);
    }
}

window.cancelTask = async function(id) {
    try {
        const res = await fetchWithAuth(`/api/queue/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Task cancelled');
            fetchQueue();
        }
    } catch (e) {
        alert('Failed to cancel task');
    }
};

// Timeline Logic
async function fetchTimeline() {
    try {
        const res = await fetchWithAuth('/api/timeline?limit=30');
        const events = await res.json();
        const listEl = document.getElementById('timelineList');
        if (!listEl) return;

        if (events.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; margin-top: 30px;">No timeline events recorded.</p>';
            return;
        }

        listEl.innerHTML = events.slice().reverse().map(e => `
            <div class="timeline-card">
                <div style="font-weight: 600; font-size: 12px; color: var(--accent);">${escapeHtml(e.event)}</div>
                <div class="timeline-desc">${escapeHtml(JSON.stringify(e.data))}</div>
                <div class="timeline-meta">
                    <span>${new Date(e.timestamp).toLocaleTimeString()}</span>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.warn('Failed to fetch timeline:', e);
    }
}

// Developer Tools Actions
const toolOutput = document.getElementById('toolsOutput');
const toolOutputTitle = document.getElementById('toolsOutputTitle');
const toolOutputContent = document.getElementById('toolsOutputContent');
const closeToolsOutputBtn = document.getElementById('closeToolsOutputBtn');

function showToolsOutput(title, content) {
    if (!toolOutput) return;
    toolOutputTitle.textContent = title;
    toolOutputContent.textContent = content;
    toolOutput.style.display = 'block';
}

if (closeToolsOutputBtn) {
    closeToolsOutputBtn.addEventListener('click', () => {
        if (toolOutput) toolOutput.style.display = 'none';
    });
}

document.getElementById('toolRunTests')?.addEventListener('click', async () => {
    showToolsOutput('Running Tests...', 'Executing `npm test` via quick action...');
    try {
        const res = await fetchWithAuth('/api/quick-actions/run-tests/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        showToolsOutput('Test Results', data.result?.stdout || data.result?.stderr || JSON.stringify(data, null, 2));
    } catch (e) {
        showToolsOutput('Test Execution Error', e.message);
    }
});

document.getElementById('toolGitStatus')?.addEventListener('click', async () => {
    showToolsOutput('Checking Git Status...', 'Executing `git status`...');
    try {
        const res = await fetchWithAuth('/api/quick-actions/git-status/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        showToolsOutput('Git Status', data.result?.stdout || JSON.stringify(data, null, 2));
    } catch (e) {
        showToolsOutput('Git Error', e.message);
    }
});

document.getElementById('toolCheckpoints')?.addEventListener('click', async () => {
    showToolsOutput('Loading Checkpoints...', 'Inspecting shadow checkpoints...');
    try {
        const res = await fetchWithAuth('/api/checkpoints');
        const list = await res.json();
        showToolsOutput('Shadow Checkpoints', JSON.stringify(list, null, 2));
    } catch (e) {
        showToolsOutput('Checkpoint Error', e.message);
    }
});

document.getElementById('toolDevices')?.addEventListener('click', async () => {
    showToolsOutput('Loading Connected Devices...', 'Fetching active sessions...');
    try {
        const res = await fetchWithAuth('/api/devices');
        const devices = await res.json();
        showToolsOutput('Connected Devices & Controller', JSON.stringify(devices, null, 2));
    } catch (e) {
        showToolsOutput('Devices Error', e.message);
    }
});

document.getElementById('refreshApprovalsBtn')?.addEventListener('click', fetchApprovals);
document.getElementById('refreshQueueBtn')?.addEventListener('click', fetchQueue);
document.getElementById('refreshTimelineBtn')?.addEventListener('click', fetchTimeline);

// Periodic polling for approvals badge count
setInterval(async () => {
    try {
        const res = await fetchWithAuth('/api/approvals');
        const approvals = await res.json();
        updateApprovalsBadge(approvals);
    } catch (e) {}
}, 5000);

// Global notification bell click handler (F-19)
document.getElementById('btnGlobalNotif')?.addEventListener('click', () => {
    switchTab('tabApprovals');
});



// switchTab is implemented above with dual desktop/mobile sync


// Extra Tools: File Browser & Cloud Sync
document.getElementById('toolFiles')?.addEventListener('click', async () => {
    showToolsOutput('Workspace File Tree', 'Loading workspace filesystem hierarchy...');
    try {
        const res = await fetchWithAuth('/api/files');
        const data = await res.json();
        showToolsOutput('Workspace Files', JSON.stringify(data, null, 2));
    } catch (e) {
        showToolsOutput('File Browser Error', e.message);
    }
});

// Real Cloud Sync Manifest Reading (F-17)
document.getElementById('toolCloudSync')?.addEventListener('click', async () => {
    showToolsOutput('Google Drive Cloud Sync', 'Fetching sync manifest from .quanta/sync-manifest.json...');
    try {
        const res = await fetchWithAuth('/api/sync-manifest');
        const manifest = await res.json();
        if (manifest.exists && manifest.status === 'synced') {
            const lastSync = manifest.lastSyncTimestamp ? new Date(manifest.lastSyncTimestamp).toLocaleString() : 'Never';
            const info = {
                provider: 'Google Drive (OAuth 2.0 PKCE)',
                status: 'Operational (Active)',
                manifestVersion: manifest.version,
                workspace: manifest.workspaceName,
                lastSyncTime: lastSync,
                trackedFiles: manifest.fileCount,
                files: manifest.files
            };
            showToolsOutput('Google Drive Sync State', JSON.stringify(info, null, 2));
        } else if (manifest.exists && manifest.status === 'corrupt') {
            showToolsOutput('Google Drive Sync State', JSON.stringify({
                provider: 'Google Drive (OAuth 2.0 PKCE)',
                status: 'Corrupt Manifest',
                error: manifest.error,
                trackedFiles: 0
            }, null, 2));
        } else {
            showToolsOutput('Google Drive Sync State', JSON.stringify({
                provider: 'Google Drive (OAuth 2.0 PKCE)',
                status: 'Uninitialized',
                message: 'No .quanta/sync-manifest.json found. Perform initial sync in Quanta-PC-Extension.',
                trackedFiles: 0
            }, null, 2));
        }
    } catch (e) {
        showToolsOutput('Cloud Sync Error', e.message);
    }
});

// Copy Output Button
document.getElementById('copyToolsOutputBtn')?.addEventListener('click', () => {
    const content = document.getElementById('toolsOutputContent')?.textContent;
    if (content) {
        navigator.clipboard.writeText(content).then(() => {
            showToast('Copied to clipboard!');
        }).catch(() => {
            copyToClipboard(content);
        });
    }
});

// Add Task Queue Modal Handlers
const addTaskOverlay = document.getElementById('addTaskOverlay');
const btnNewTask = document.getElementById('btnNewTask');
const cancelAddTaskBtn = document.getElementById('cancelAddTaskBtn');
const submitAddTaskBtn = document.getElementById('submitAddTaskBtn');
const taskPromptInput = document.getElementById('taskPromptInput');
const taskPrioritySelect = document.getElementById('taskPrioritySelect');

if (btnNewTask && addTaskOverlay) {
    btnNewTask.addEventListener('click', () => {
        addTaskOverlay.style.display = 'flex';
        taskPromptInput.value = '';
        taskPromptInput.focus();
    });
}

if (cancelAddTaskBtn && addTaskOverlay) {
    cancelAddTaskBtn.addEventListener('click', () => {
        addTaskOverlay.style.display = 'none';
    });
}

if (submitAddTaskBtn && addTaskOverlay) {
    submitAddTaskBtn.addEventListener('click', async () => {
        const prompt = taskPromptInput.value.trim();
        const priority = taskPrioritySelect.value || 'normal';
        if (!prompt) {
            alert('Please enter a task instruction.');
            return;
        }
        submitAddTaskBtn.disabled = true;
        submitAddTaskBtn.textContent = 'Enqueuing...';
        try {
            const res = await fetchWithAuth('/api/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, priority })
            });
            const data = await res.json();
            if (data.success || data.id) {
                showToast('Task added to queue!');
                addTaskOverlay.style.display = 'none';
                fetchQueue();
            } else {
                alert('Failed to enqueue: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Network error enqueuing task: ' + e.message);
        } finally {
            submitAddTaskBtn.disabled = false;
            submitAddTaskBtn.textContent = 'Enqueue Task';
        }
    });
}

// New chat from history button
document.getElementById('newChatFromHistoryBtn')?.addEventListener('click', () => {
    hideChatHistory();
    startNewChat();
});


// --- Ink & Paper Theme Controller ---
function initThemeController() {
    const themeButtons = document.querySelectorAll('[data-theme-select]');
    themeButtons.forEach(b => {
        b.addEventListener('click', () => {
            const theme = b.getAttribute('data-theme-select');
            switchTheme(theme);
        });
    });

    function switchTheme(theme) {
        writePreference('quanta_theme', theme);
        let effective = theme;
        if (theme === 'system') {
            effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'graphite' : 'paper';
        }
        document.documentElement.setAttribute('data-theme', effective);
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.setAttribute('content', effective === 'paper' ? '#F3EEE3' : (effective === 'ink' ? '#0B0B0A' : '#1A1A19'));
        }
        updateThemeButtons(theme);
    }

    function updateThemeButtons(activeTheme) {
        const buttons = document.querySelectorAll('[data-theme-select]');
        buttons.forEach(b => {
            const matches = b.getAttribute('data-theme-select') === activeTheme;
            b.classList.toggle('active', matches);
            if (matches) {
                b.classList.add('btn-primary');
                b.classList.remove('btn-secondary');
            } else {
                b.classList.remove('btn-primary');
                b.classList.add('btn-secondary');
            }
        });
    }

    window.switchTheme = switchTheme;

    const currentTheme = readPreference('quanta_theme') || 'system';
    updateThemeButtons(currentTheme);

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if ((readPreference('quanta_theme') || 'system') === 'system') {
                switchTheme('system');
            }
        });
    }
}
initThemeController();


// --- Demo Mode Fixtures (?demo=1) for Visual Verification ---
if (window.location.search.includes('demo=1')) {
    chatIsOpen = true;
    const chatBox = document.getElementById('chatContent');
    if (chatBox) {
        chatBox.innerHTML = `
            <div class="turn turn-user">
                <div class="turn-header">
                    <span class="turn-author">OPERATOR</span>
                    <span class="turn-time">T+00:12</span>
                </div>
                <div class="turn-body">
                    Please audit the authentication tokens and ensure zero-flash theme persistence across mobile and desktop viewports.
                </div>
            </div>

            <div class="turn turn-assistant">
                <div class="turn-header">
                    <span class="turn-author">QUANTA AGENT</span>
                    <span class="turn-time">T+00:15</span>
                </div>
                <div class="thought-block">
                    <div class="thought-header">Thought Process · 2.4s</div>
                    <div>Analyzing session cookies, CSP directives, and synchronous pre-paint head execution. Verified 28/28 unit tests pass without regressions.</div>
                </div>
                <div class="turn-body">
                    I have inspected the authentication token handlers and integrated a synchronous pre-paint theme bootstrap script in <code>&lt;head&gt;</code> that reads <code>quanta_theme</code> before layout construction.

                    <div class="ledger-row" style="margin: 12px 0;">
                        <span class="stamp stamp-safe">VERIFIED</span>
                        <span class="ledger-mono">quanta-pc-extension: 11 passed</span>
                        <span class="ledger-val">201ms</span>
                    </div>

                    <div class="diff-view" style="margin: 12px 0;">
                        <div class="diff-header">
                            <span>quanta_session.ts</span>
                            <span class="stamp stamp-safe">+4 / -1</span>
                        </div>
                        <pre><span class="diff-line diff-del">- const theme = localStorage.getItem('theme') || 'dark';</span>
<span class="diff-line diff-add">+ const theme = initThemeBootstrap();</span>
<span class="diff-line">  document.documentElement.setAttribute('data-theme', theme);</span></pre>
                    </div>
                </div>
            </div>
        `;
    }

    const pText = document.getElementById('projectText');
    if (pText) pText.textContent = 'quanta-ide';
    const sDot = document.getElementById('statusDot');
    if (sDot) {
        sDot.classList.remove('disconnected');
        sDot.classList.add('connected');
    }
    const dDot = document.getElementById('desktopStatusDot');
    if (dDot) {
        dDot.classList.remove('disconnected');
        dDot.classList.add('online');
    }
}

// --- Interactive User Avatar & Session Modal (F-20) ---
const userAvatarBadge = document.getElementById('userAvatarBadge') || document.querySelector('.user-avatar-badge');
const sessionModalOverlay = document.getElementById('sessionModalOverlay');
const closeSessionModalBtn = document.getElementById('closeSessionModalBtn');
const btnToggleElevation = document.getElementById('btnToggleElevation');
const btnLogout = document.getElementById('btnLogout');

let currentSessionData = null;

async function openSessionModal() {
    if (!sessionModalOverlay) return;
    sessionModalOverlay.style.display = 'flex';
    try {
        const res = await fetchWithAuth('/api/session');
        const data = await res.json();
        currentSessionData = data;

        const userEl = document.getElementById('sessionUser');
        const modeBadge = document.getElementById('sessionModeBadge');
        const fpEl = document.getElementById('sessionFingerprint');
        const connEl = document.getElementById('sessionConnectionLabel');

        if (userEl) userEl.textContent = data.user || 'Administrator';
        if (modeBadge) {
            modeBadge.textContent = data.mode === 'control' ? 'Control (Elevated)' : 'Read-Only';
            modeBadge.style.color = data.mode === 'control' ? 'var(--ok)' : 'var(--caution)';
        }
        if (fpEl) fpEl.textContent = data.deviceFingerprint || 'local-session';
        if (connEl) connEl.textContent = data.connection || (data.isTunnel ? 'Tunnel' : 'LAN');

        if (btnToggleElevation) {
            if (data.mode === 'control') {
                btnToggleElevation.textContent = 'Demote';
                btnToggleElevation.style.display = 'inline-block';
            } else {
                btnToggleElevation.textContent = 'Elevate';
                btnToggleElevation.style.display = 'inline-block';
            }
        }
    } catch (e) {
        console.error('Failed to load session details:', e);
    }
}

function closeSessionModal() {
    if (sessionModalOverlay) sessionModalOverlay.style.display = 'none';
}

userAvatarBadge?.addEventListener('click', openSessionModal);
closeSessionModalBtn?.addEventListener('click', closeSessionModal);

sessionModalOverlay?.addEventListener('click', (e) => {
    if (e.target === sessionModalOverlay) closeSessionModal();
});

btnToggleElevation?.addEventListener('click', async () => {
    if (!currentSessionData) return;
    if (currentSessionData.mode === 'control') {
        try {
            const res = await fetchWithAuth('/api/demote', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast('Session demoted to read-only mode');
                openSessionModal();
                fetchAppState();
            }
        } catch (e) {
            showToast('Failed to demote session: ' + e.message);
        }
    } else {
        const pass = prompt('Enter APP_PASSWORD to elevate session to control mode:');
        if (pass) {
            try {
                const res = await fetchWithAuth('/api/elevate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pass, totp: prompt('Authenticator code (leave blank if 2FA is disabled):') || '' })
                });
                const data = await res.json();
                if (data.success) {
                    showToast('Session elevated to control mode');
                    openSessionModal();
                    fetchAppState();
                } else {
                    alert('Elevation failed: ' + (data.error || 'Incorrect password'));
                }
            } catch (e) {
                alert('Elevation error: ' + e.message);
            }
        }
    }
});

btnLogout?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to log out of this Quanta session?')) {
        try {
            await window.QuantaOfflineQueue?.clear();
            await fetchWithAuth('/logout', { method: 'POST' });
        } catch {}
        window.location.href = '/login.html';
    }
});

// Toast notification helper
function showToast(msg, duration = 3200) {
    const toast = document.getElementById('quantaToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}
window.showToast = showToast;

// --- Voice Dictation Controller Integration (F-22) ---
function initVoiceInput() {
    if (window.voiceInputController) return;
    const micBtn = document.getElementById('btnVoiceInput');
    const msgInput = document.getElementById('messageInput');
    const langSelect = document.getElementById('voiceLangSelect');
    const VoiceClass = window.VoiceInputController || window.VoiceInputManager;

    if (micBtn && msgInput && VoiceClass) {
        window.voiceInputController = new VoiceClass(msgInput, micBtn, langSelect, {
            onError: (errCode, userMsg) => {
                showToast(userMsg || 'Voice input error');
            }
        });
        console.log('[VOICE] VoiceInputController initialized successfully');
    }
}

// --- Service Worker Registration (F-24) ---
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('[SW] ServiceWorker registered with scope:', reg.scope))
            .catch(err => console.warn('[SW] Registration failed:', err));
    });
}

// Initialize Voice Input on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoiceInput);
} else {
    initVoiceInput();
}
