# Project: Quanta IDE Workspace Audit & Enhancement

## Architecture
Quanta IDE comprises two symbiotic systems operating over a shared local workspace:
1. **Quanta-PC-Extension** (VS Code / Antigravity IDE Extension):
   - Language: TypeScript / Webpack
   - Responsibilities: Google Drive cloud sync (OAuth 2.0 PKCE loopback, 3-way delta sync manifest, safe trashing, ignore filtering), chat transcript extraction/redaction/encryption from Antigravity brain logs, in-extension updater, and VS Code sidebar webview.
2. **Remote-Control** (Mobile PWA & Remote Access Server):
   - Language: Node.js (ES Modules, Express, WebSockets, CDP bridge)
   - Responsibilities: Master password & TOTP authentication, rate limiting, session elevation/read-only enforcement, Chrome DevTools Protocol bridge to Antigravity Electron process (`127.0.0.1:9000`), shell risk classification, approval inbox, shadow git checkpoints, jailed file browser, and responsive PWA web client.
3. **Shared Artifacts & Interfaces**:
   - Filesystem directory: `.quanta/` (sync manifest, selective sync, shadow git checkpoints, uploaded images, file hashes).
   - Loopback endpoints: Port 8085 (OAuth callback), Port 3000 (Remote-Control HTTPS/WSS), Port 9000 (CDP Electron debug).

---

## Feature Inventory
| # | Feature / Remediation Item | Description | Milestone | Source |
|---|---|---|---|---|
| F-01 | OAuth 2.0 PKCE Hardening | Port 8085 listener mutex, IPv4/IPv6 localhost binding, manual code exchange try/catch | M1 | Survey (Explorer 1) |
| F-02 | Three-Way Delta Sync Engine | Correct conflict policies (`keepRemote` doesn't overwrite remote, `downloadRemote` downloads), implement `deleteLocal` on pull | M1 | Survey (Explorer 1) |
| F-03 | Ignore Rule Trailing Slash Fix | Fix `IgnoreMatcher` so directory rules with `/` (e.g. `vendor/`) match files inside | M1 | Survey (Explorer 1) |
| F-04 | Binary Sync Support & MIME Detection | Handle Buffers in `writeDriveFile`/`readDriveFile`, avoid UTF-8 text corruption on binary files | M1 | Survey (Explorer 1) |
| F-05 | Drive Query Injection & Pagination | Escape single quotes in Drive search queries, handle `nextPageToken` in recursive listing | M1 | Survey (Explorer 1) |
| F-06 | Extension Dependency Pruning & Config | Prune unused `googleapis` (150MB), remove scratch `test.js`, fix typeless package.json | M1 | Survey (Explorer 1, 3) |
| F-07 | WebSocket Tunnel Auth & Redirect Fix | Fix `token === AUTH_TOKEN` bug in WS handshake using `sessionManager.getSession` | M2 | Survey (Explorer 2) |
| F-08 | WebSocket LAN Zero-Trust Enforcement | Check `sessionManager.allowLanAutoTrust` in WebSocket connection handler | M2 | Survey (Explorer 2) |
| F-09 | Checkpoints API Integration Fix | Pass `workspaceRoot` to `listCheckpoints` and fix argument order in `rollback` in `server.js` | M2 | Survey (Explorer 2, 3) |
| F-10 | CDP Script Injection Sanitization | Escape `selector` and `scrollPercent` before string interpolation in `Runtime.evaluate` | M2 | Survey (Explorer 2) |
| F-11 | AuditLogger Multi-Subsystem Signature Fix | Normalize `auditLogger.log` calls across imageUpload, webhooks, tunnels, telegram, plugins | M2 | Survey (Explorer 2) |
| F-12 | EventBus Dot/Colon Listener Alignment | Align `eventBus` event names across webhooks and telegram bot (`approval.requested`) | M2 | Survey (Explorer 2) |
| F-13 | QuickActions Allowlist Matching Fix | Support `run-tests` alias matching `act-npm-test` in `store.js` / `quickActions.js` | M2 | Survey (Explorer 2, 3) |
| F-14 | Live System Telemetry Computation | Replace hardcoded `diskPercent: 46` with dynamic OS disk calculation | M2 | Survey (Explorer 2, 3) |
| F-15 | Extension Sidebar Live Telemetry & UI | Remove static `192.168.1.2:3000`, wire dynamic port 3000 check, update Last Sync timestamp | M3 | Survey (Explorer 1, 3) |
| F-16 | Extension Sidebar State & Buttons | Hook `init` message on webview load for auth/sync state, add "Preview Sync" button | M3 | Survey (Explorer 1) |
| F-17 | Remote-Control Web UI Elimination of Dummy Content | Replace mock Drive Sync status with real `.quanta` manifest inspection | M3 | Survey (Explorer 2, 3) |
| F-18 | Web Client Connection Status & Dot | Wire `desktopStatusText` and dynamic green/amber/red status dot to WebSocket lifecycle | M3 | Survey (Explorer 2, 3) |
| F-19 | Web Client Badges & Notification Indicator | Wire `desktopApprovalsBadge` and `.notif-badge-dot` to live pending approvals count | M3 | Survey (Explorer 2, 3) |
| F-20 | Interactive User Avatar & Session Menu | Make `user-avatar-badge` clickable with session dropdown (mode, fingerprint, logout) | M3 | Survey (Explorer 2, 3) |
| F-21 | Inspector Connection Dynamic Label | Dynamically update `inspectorConnection` ("LAN" vs "Tunnel (provider)") | M3 | Survey (Explorer 2, 3) |
| F-22 | Web Speech Voice Input UI Integration | Add microphone button and language picker to chat composer, wire `voiceInput.js` | M3 | Survey (Explorer 2, 3) |
| F-23 | Login 2FA TOTP Input Field | Add TOTP input field to `login.html` and `login.js` when 2FA enabled | M3 | Survey (Explorer 2, 3) |
| F-24 | Service Worker & Asset Route Fix | Fix missing `/assets/antigravity.png` route or bundle icon for PWA installability | M3 | Survey (Explorer 2) |
| F-25 | 100% Automated Regression & Integration Pass | Pass all existing (11 Extension + 17 Remote) and newly authored unit/integration tests | M4 | Survey (Spec Miner) |
| F-26 | Opaque-Box E2E Testing Suite (Tiers 1-4) | Systematic Category-Partition, BVA, Pairwise, and Workload tests | E2E Track | Requirements |
| F-27 | Adversarial Coverage Hardening (Tier 5) | White-box adversarial testing and gap elimination | M4 | Project Pattern |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | Quanta-PC-Extension Core Engine & OAuth Remediation | Fix IgnoreMatcher trailing slash, OAuth loopback concurrency mutex, binary file buffers, Drive query escaping, conflict policies, deleteLocal on pull, dependency cleanup | None | DONE |
| M2 | Remote-Control Backend Server, Security & Protocol Fixes | Fix WebSocket tunnel auth loop, WebSocket LAN zero-trust, Checkpoints argument ordering, CDP script sanitization, auditLogger signatures, eventBus naming, quick action alias, dynamic disk telemetry | None | DONE |
| M3 | Workspace UI/UX Enhancement & Elimination of Dummy Content | Extension sidebar real status & sync timestamps, web client real sync status, live badges & status dots, interactive avatar menu, voice dictation UI, TOTP login field, PWA asset fix | M1, M2 | DONE |
| M4 | Final Milestone: 100% E2E Test Suite Validation & Adversarial Hardening | Phase 1: Pass 100% of E2E test suite (Tiers 1-4) from E2E Track; Phase 2: Tier 5 Adversarial Coverage Hardening | M1, M2, M3, TEST_READY | IN_PROGRESS |
| E2E | E2E Testing Track | Independent opaque-box test runner & comprehensive test suite (Tiers 1-4) published via TEST_READY.md | None (Requirements-driven) | DONE |

---

## Interface Contracts

### 1. Extension OAuth Loopback ↔ Browser / Google Identity
- **Loopback Binding**: Listens on `127.0.0.1:8085` (or preferred port). Concurrency guard: single active server promise.
- **Redirect URI**: `http://localhost:8085` or `http://127.0.0.1:8085` (must strictly match authorized URIs in Google Cloud Console).
- **Fallback**: If port 8085 occupied and cannot bind, prompt manual authorization code paste input box with try/catch.

### 2. Remote-Control Server ↔ PWA Web Client
- **Authentication**: Signed HTTP-only cookie `ag_auth_token` holding session UUID.
- **WebSocket Handshake**:
  - `cookie: ag_auth_token` unsign-verified using `sessionSecret`.
  - Lookup via `sessionManager.getSession(sessionId)`.
  - Check `isLocalRequest(req) && sessionManager.allowLanAutoTrust` before granting auto-authentication.
  - Return `{ type: 'error', message: 'Unauthorized' }` only when session invalid.
- **Telemetry Contract (`GET /api/system-telemetry` & `/app-state`)**:
  - `{ cpuPercent: number, memUsedGb: string, memTotalGb: string, diskPercent: number }` (real computed disk percentage).

### 3. Remote-Control ↔ Quanta-PC-Extension State Sync
- **Shared Manifest Path**: `.quanta/sync-manifest.json`.
- **Contract**:
  - `Quanta-PC-Extension` writes manifest updates with timestamp, file count, and remote folder ID.
  - `Remote-Control` reads `.quanta/sync-manifest.json` for "Drive Sync" status rather than generating synthetic mock objects.
  - `Quanta-PC-Extension` sidebar probes `https://127.0.0.1:<port>/health` to display live server status instead of hardcoding `192.168.1.2:3000`.

### 4. Remote-Control Server ↔ CheckpointManager
- `checkpointManager.listCheckpoints(workspaceRoot, limit)`: `workspaceRoot` defaults to active workspace or `process.cwd()`.
- `checkpointManager.rollback(workspaceRoot, checkpointId, options)`: 1st param is workspace directory, 2nd param is commit SHA.

---

## Code Layout & Worker Exclusive Boundaries

| Milestone / Track | Exclusive File Boundaries (Workers MUST NOT cross boundaries) |
|---|---|
| **M1 Worker** | `Quanta-PC-Extension/src/auth.ts`, `Quanta-PC-Extension/src/gdrive.ts`, `Quanta-PC-Extension/src/ignoreRules.ts`, `Quanta-PC-Extension/src/manifest.ts`, `Quanta-PC-Extension/src/extension.ts`, `Quanta-PC-Extension/package.json`, `Quanta-PC-Extension/test/` |
| **M2 Worker** | `Remote-Control/server.js`, `Remote-Control/agent/`, `Remote-Control/ide/`, `Remote-Control/security/`, `Remote-Control/webhooks/`, `Remote-Control/notifications/`, `Remote-Control/connectivity/`, `Remote-Control/core/`, `Remote-Control/test/` |
| **M3 Worker** | `Quanta-PC-Extension/src/sidebar.ts`, `Quanta-PC-Extension/media/`, `Remote-Control/public/` (`index.html`, `login.html`, `js/`, `css/`, `sw.js`, `manifest.webmanifest`) |
| **E2E Testing Track** | `tests/e2e/`, `TEST_INFRA.md`, `TEST_READY.md` |
