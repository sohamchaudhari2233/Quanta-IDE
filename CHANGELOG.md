# Changelog

All notable changes to **Quanta IDE** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-11-01

### 🤖 Agent Control & Safety Architecture
- **Conservative Shell Risk Classifier:** Decomposes compound command lines (`&&`, `||`, `;`, `|`, subshells) and classifies actions into `safe`, `caution`, and `dangerous`.
- **Auto-Approval Rule Engine with Hard Floor:** Pattern-based rule evaluation with an immutable safety floor (`dangerous` commands can never be auto-approved, regardless of rules).
- **Mobile Approval Inbox:** Dedicated approval queue with prompt fingerprinting (`sha256(action|cmd|dir)`), duplicate deduplication, and approve/reject resolution.
- **Priority-Ordered Task Queue:** Client and server task queue with FIFO priority dispatching, idempotency key deduplication, and cancelation.
- **Shadow Git Checkpoints:** Isolated checkpointing system under `.quanta/checkpoints/` using `--git-dir` and `--work-tree`, enabling instant rollbacks without touching the developer's normal `.git` repository.

### 🔄 Sync+ & Storage Abstraction
- **Storage Provider Interface:** Provider-agnostic storage abstraction (`StorageProvider`) supporting Google Drive, S3, and in-memory test mocks (`MockStorageProvider`).
- **Content-Addressed Workspace Snapshots:** Deduplicated file blob storage in `.quanta/blobs/<sha256>` with metadata snapshots and garbage collection (`gcSnapshots`).
- **Selective Sync Manager:** Path-based inclusion and exclusion rules stored in `.quanta/selective-sync.json`.

### 📱 Phone Mini-IDE & Notifications
- **Jailed File Browser:** Safe remote file inspection and safe editing bounded within the workspace root, blocking path traversal and sensitive patterns (`.env`, `.pem`, `client_secret`).
- **Optimistic Concurrency Editing:** Base hash validation prevents overwriting changes made on desktop while viewing files on mobile.
- **Allowlisted Quick Actions:** Pre-approved fast operations (`git status`, `git diff`, `run tests`) executed safely in workspace root.
- **Privacy-Preserving Image Upload:** Camera and gallery image uploads stored in `.quanta/uploads/` with MIME magic byte sniffing, JPEG EXIF stripping, and automatic Markdown injection.
- **Telegram Bot Control Gateway:** Out-of-band notification dispatcher and interactive command runner (`/status`, `/approvals`, `/approve`, `/reject`, `/queue`) with strict user whitelist.

### 💡 Chat Intelligence & Knowledge
- **Local Transcript Search Engine:** Inverted index with BM25-lite keyword scoring over redacted transcripts with dynamic snippet extraction running 100% locally.
- **Prompt Template Library:** Reusable prompt catalog with built-in templates and `{{variable}}` substitution.

### 🌐 Connectivity & Reliability
- **Tunnel Supervisor & Auto-Fallback:** Dynamic supervisor (Cloudflare -> Ngrok -> Pinggy -> LocalXpose) with health probes and hysteresis.
- **Client-Side Offline Queue:** IndexedDB-backed prompt queue automatically retrying prompts on reconnect, with staleness confirmation for prompts older than 5 minutes.
- **Multi-Device Spectator & Controller Lock:** Unlimited read-only device watching with a single active controller lock.

### 🛠️ Developer Experience & Extensibility
- **Interactive Setup Wizard:** `node setup.js` CLI guiding environment validation, SSL generation, secrets configuration, and CDP connectivity.
- **HMAC-SHA256 Webhooks with SSRF Guard:** Webhook event dispatcher blocking loopback and private IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`).
- **Plugin Architecture:** Isolated plugin host (`PluginHost`) with event bus hooks, custom quick action registration, and example Slack notifier.

### 🎨 Mobile Web Interface
- **Five-Tab Bottom Navigation:** Responsive navigation tabs for `Live`, `Approvals` (with badge counter), `Queue`, `Timeline`, and `Tools`.

---

## [1.0.0] - 2026-11-01

### 🛡️ Security Hardening
- **Constant-Time Password Comparison:** Implemented `crypto.timingSafeEqual` with SHA-256 input hashing across all authentication flows.
- **Brute-Force Rate Limiting & Lockout:** Added in-memory token-bucket rate limiter with exponential backoff on `/login` and WebSocket handshakes.
- **Server-Enforced Read-Only Mode:** External and tunnel connections now default to `read-only`. Action routes (`/send`, `/stop`, `/set-mode`, etc.) strictly reject non-elevated sessions with `403 Forbidden`.
- **Ephemeral QR Code Pairing:** Eliminated insecure query-string passwords (`?key=...`) in favor of 120-second one-time pairing tickets.
- **Server-Side Session Store:** Replaced single shared static auth token with unique cryptographically random session IDs, absolute expiry (24h), idle timeout (2h), and server-side revocation on `/logout`.
- **WebSocket Origin Validation:** Strict origin verification in `WebSocketServer.verifyClient` against host and authorized tunnel headers.
- **CDP Loopback Self-Check:** Added startup probe testing if Chrome DevTools Protocol (port 9000) is reachable over LAN/external interfaces, warning developers of network exposure.
- **OAuth Loopback Port Allocation:** Migrated from hardcoded port 3000 to ephemeral OS port `127.0.0.1:0` with RFC 7636 PKCE (`S256`) and cryptographically random `state` parameter validation.
- **Token Vaulting in `SecretStorage`:** Migrated Google Drive tokens from memory to `vscode.SecretStorage` with silent refresh handling.
- **Structured JSONL Audit Logging:** Append-only structured audit log in `Remote-Control/logs/audit.jsonl` with automatic secret redaction and 5MB rotation.

### 🔄 Workspace Synchronization
- **`.quantaignore` Support:** Added custom `.quantaignore` parser with built-in un-overridable defaults (`.env*`, secrets, certificates, `node_modules/`, `.git/`).
- **Three-Way Conflict Resolution:** Implemented base state tracking via `.quanta/sync-manifest.json` preventing silent overwrites on concurrent edits.
- **Dry-Run Sync Preview:** Added interactive preview command (`quanta.preview`) summarizing additions, updates, deletions, and conflicts before execution.
- **Safe Trashing:** Replaced destructive Google Drive `DELETE` with non-destructive Drive Trash (`PATCH` with `{"trashed": true}`).
- **Mass-Deletion Safety Guard:** Added modal confirmation requirement when deletions exceed 20 files or 30% of workspace.
- **Incremental Drive Changes API:** Integrated `startPageToken` for delta-based Drive scans.

### 🧠 AI & Transcripts
- **Multi-Path Brain Discovery:** Auto-detects Antigravity brain directories across `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-ide/brain`, and local workspace paths.
- **Sensitive Data Redaction:** Comprehensive regex filter masking API keys, JWTs, Bearer headers, private keys, and `.env` assignments before transcript export.
- **Optional Client-Side Encryption:** Added AES-256-GCM encryption with `scrypt` key derivation for chat transcripts.
- **Markdown Export:** Formatted conversation export to readable Markdown.

### 📱 Remote Mobile Experience
- **Progressive Web App (PWA):** Added `manifest.webmanifest` and Service Worker (`sw.js`) for full-screen standalone installation on Android and iOS.
- **Voice-to-Text Input:** Added speech-to-prompt capability using Web Speech API with multilingual support (`en-IN`, `hi-IN`, `en-US`).
- **System Doctor (`quanta doctor`):** Standalone diagnostic CLI checking runtime, credentials, ports, and permissions.

