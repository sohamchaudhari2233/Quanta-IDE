# Quanta IDE - Security, Reliability, Sync & Product Audit

**Audit Date:** November 2026  
**Auditor:** Quanta Security & Core Engineering  
**Scope:** `Quanta-PC-Extension` & `Remote-Control`

---

## 1. Executive Summary

An exhaustive security, sync, and reliability audit was conducted across the Quanta IDE codebase. The audit evaluated the threat model where `Remote-Control` grants an external client access to an AI agent capable of executing terminal commands and modifying source code, and where `Quanta-PC-Extension` synchronizes entire workspaces and sensitive chat transcripts with Google Drive.

All items flagged in the master prompt were verified against the real codebase. **17 out of 17 issues are CONFIRMED** present in the codebase. Additionally, **4 critical undisclosed vulnerabilities** were identified during code inspection (including credentials exposed in query parameters, arbitrary file upload paths, and hardcoded user profile paths).

---

## 2. Issue Verification Table

| # | Master Prompt Item | Status | Evidence (File : Line) | Risk Level | Planned Fix |
|---|--------------------|--------|------------------------|------------|-------------|
| **3.1a** | Rate limiting & Lockout | **CONFIRMED** | `Remote-Control/server.js:2042-2054` | **CRITICAL** | Implement in-memory token-bucket rate limiter with IP tracking, exponential backoff, and temporary lockout on `/login` and WebSocket upgrades. Configurable trust-proxy headers per tunnel. |
| **3.1b** | Constant-Time Password Comparison | **CONFIRMED** | `Remote-Control/server.js:2044` (`password === APP_PASSWORD`) | **HIGH** | Replace with `crypto.timingSafeEqual` over SHA-256 hashes of input and target. Refuse startup on empty or default password (`antigravity`). |
| **3.1c** | Password in Query String | **CONFIRMED** | `Remote-Control/server.js:2004` (`req.query.key === APP_PASSWORD`) | **HIGH** | Deprecate plaintext query password. Require short-lived ephemeral one-time pairing tickets for QR code login. |
| **3.1d** | Session Expiry & Server-Side Revocation | **CONFIRMED** | `Remote-Control/server.js:1970, 2005-2009, 2045-2049` | **CRITICAL** | Static shared `AUTH_TOKEN` for all clients. Replace with dynamic per-device session IDs in server-side memory registry with absolute and idle timeouts, rotation on login, and server-side revocation on `/logout`. |
| **3.1e** | Device Pairing Approval | **CONFIRMED** | `Remote-Control/server.js:1999, 2483` (`isLocalRequest`) | **CRITICAL** | Require desktop authorization (terminal prompt / VS Code notification) for unrecognized devices. Maintain approved device fingerprint store with revocation support. |
| **3.1f** | Optional TOTP 2FA (RFC 6238) | **CONFIRMED** | `Remote-Control/server.js` (Entire file lacks 2FA) | **MEDIUM** | Implement RFC 6238 TOTP using Node `crypto` HMAC-SHA1. Add terminal CLI command to generate TOTP secret and QR code. |
| **3.1g** | CSRF Protection & WebSocket Origin Check | **CONFIRMED** | `Remote-Control/server.js:1966, 2463` | **CRITICAL** | Add `verifyClient` to `WebSocketServer` checking `Origin` against allowed host headers. Add CSRF token validation to state-changing HTTP endpoints. |
| **3.2** | Structured JSONL Audit Log | **CONFIRMED** | `Remote-Control/server.js` (No structured audit logging) | **HIGH** | Implement append-only `Remote-Control/logs/audit.jsonl` (gitignored) logging timestamps, device IDs, IP, event types, and redacted action summaries with size rotation. |
| **3.3** | Server-Enforced Read-Only Mode | **CONFIRMED** | `Remote-Control/server.js:2124, 2132, 2233, 2616` | **CRITICAL** | Enforce session role (`read-only` vs `control`) at router and WebSocket dispatcher level. Default external/tunnel connections to `read-only`. Require explicit desktop elevation to `control`. |
| **3.4** | CDP Exposure & Self-Check | **CONFIRMED** | `Remote-Control/server.js:152-178` | **HIGH** | Verify Chromium binds only to `127.0.0.1`. Add startup probe testing if port 9000 responds on LAN/external interfaces; emit loud alert if exposed. |
| **3.5** | OAuth Port 3000 Conflict | **CONFIRMED** | `Quanta-PC-Extension/src/auth.ts:88` (`const port = 3000;`) | **HIGH** | Bind OAuth loopback listener to `127.0.0.1:0` (ephemeral free port). Build dynamic redirect URI and enforce single-use short timeout with `state` validation. |
| **3.6a** | PKCE (S256) & State in Drive OAuth | **CONFIRMED** | `Quanta-PC-Extension/src/auth.ts:88-137` | **HIGH** | Implement RFC 7636 PKCE (`code_verifier`, SHA-256 `code_challenge`, `state` parameter). |
| **3.6b** | Token Storage in SecretStorage | **CONFIRMED** | `Quanta-PC-Extension/src/auth.ts:78, 112` (`let cachedToken`) | **HIGH** | Migrate token storage to `context.secrets` (`vscode.SecretStorage`). Implement silent refresh token rotation and explicit disconnect command. |
| **3.6c** | Drive Scope & Privacy | **CONFIRMED** | `Quanta-PC-Extension/src/auth.ts:134` (Requests full `auth/drive`) | **MEDIUM** | Provide configurable scope option (`drive.file` vs `drive`), document trade-offs in `DECISIONS.md`, and support re-consent migration. |
| **4.1** | `.quantaignore` Support | **CONFIRMED** | `Quanta-PC-Extension/src/extension.ts:49` (Hardcoded string) | **HIGH** | Implement `.quantaignore` parser with built-in un-overridable defaults (`.env*`, secrets, keys, `node_modules/`, `.git/`). Apply to push, pull, and orphan detection. |
| **4.2** | Three-Way Conflict Detection | **CONFIRMED** | `Quanta-PC-Extension/src/extension.ts:103-110, 223-230` | **HIGH** | Maintain persistent sync manifest (`.quanta/sync-manifest.json`). Detect concurrent local and remote modifications since base state. Provide interactive UI (`Keep local`, `Keep remote`, `Keep both`, `Diff`). |
| **4.3a** | Dry-Run Preview | **CONFIRMED** | `Quanta-PC-Extension/src/extension.ts:24, 185` | **MEDIUM** | Add interactive diff/preview quick-pick modal showing additions, updates, deletions, and conflicts before executing sync. |
| **4.3b** | Safe Deletes (Drive Trash & Threshold) | **CONFIRMED** | `Quanta-PC-Extension/src/gdrive.ts:200-207`, `extension.ts:140-155` | **CRITICAL** | `deleteDriveFile` issues HTTP `DELETE` (permanent deletion). Replace with `PATCH /files/{id}` with `trashed: true`. Add mass-delete guard (abort if >20 files or >30% of tree). |
| **4.4a** | Chat Transcript Redaction | **CONFIRMED** | `Quanta-PC-Extension/src/chatParser.ts:50-80` | **HIGH** | Add comprehensive regex redaction filter masking API keys, JWTs, Bearer tokens, private keys, `.env` assignments, and high-entropy secrets before output. |
| **4.4b** | Chat Client-Side Encryption | **CONFIRMED** | `Quanta-PC-Extension/src/chatParser.ts` | **MEDIUM** | Implement optional AES-256-GCM encryption with `scrypt` key derivation stored in `SecretStorage`. |
| **4.4c** | Antigravity Brain Directory Probe | **CONFIRMED** | `Quanta-PC-Extension/src/chatParser.ts:8` | **HIGH** | Multi-directory fallback resolver checking `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-ide/brain`, and local workspace brain paths. |
| **4.5** | Concurrency, Progress & Changes API | **CONFIRMED** | `Quanta-PC-Extension/src/extension.ts:83-93`, `gdrive.ts:30-80` | **MEDIUM** | Make concurrency configurable, provide granular cancellable progress, and utilize Google Drive Changes API `startPageToken` for incremental delta scans. |

---

## 3. Additional Discovered Vulnerabilities

During deep code analysis, four additional security issues were uncovered:

1. **`EXTRA-01`: Password Exposure via URL Query Parameter (`Remote-Control/server.js:2004`)**
   - *Risk:* Passwords in URL query strings (`?key=...`) leak into proxy logs, browser history, terminal outputs, and `Referer` headers.
   - *Fix:* Replace static key parameter with temporary one-time cryptographically random pairing tokens (TTL: 120s).

2. **`EXTRA-02`: Arbitrary File Upload Traversal (`Remote-Control/server.js:2207-2228`)**
   - *Risk:* The `/upload-file` route accepts uploaded files and writes them directly to the user's Downloads folder without filename sanitization, allowing potential directory traversal or file overwrite.
   - *Fix:* Strict basename sanitization, extension validation, and workspace directory boundary enforcement.

3. **`EXTRA-03`: Hardcoded Fallback User Profile Path (`Remote-Control/server.js:2207`)**
   - *Risk:* `const downloadsDir = path.join(process.env.USERPROFILE || 'C:\\Users\\hshdh', 'Downloads');` exposes developer environment artifacts and breaks on non-Windows/other users.
   - *Fix:* Use `os.homedir()` exclusively.

4. **`EXTRA-04`: Insecure Default Secrets across Runtime**
   - *Risk:* Hardcoded fallback secrets (`antigravity`, `antigravity_secret_key_1337`, `antigravity_default_salt_99`).
   - *Fix:* Enforce cryptographic random generation on first boot if unconfigured, storing securely in local environment files.

---

## 4. Architecture Summary & Security Boundary Map

```
[Mobile Device / WAN]  <-- Untrusted Input Boundary
        │ (TLS / WSS)
        ▼
[Remote-Control Server]
  ├── Rate Limiter & Lockout (In-Memory Token Bucket)
  ├── Origin & CSRF Validator
  ├── Constant-Time Authenticator & Session Store
  ├── Mode Enforcer (Read-Only vs Control)
  ├── Audit Logger (JSONL Append-Only)
  └── CDP Bridge Adapter (127.0.0.1 Loopback Only)
        │
        ▼ (Loopback CDP Port 9000)
[Antigravity IDE / Electron Process]
        ▲
        │ (Internal Plugin API)
[Quanta-PC-Extension]
  ├── Loopback Ephemeral OAuth + PKCE (S256)
  ├── SecretStorage Token Vault
  ├── .quantaignore Delta Hash Engine (MD5 + 3-Way Manifest)
  ├── Transcript Redactor & AES-GCM Encryptor
  └── Google Drive API v3 (Trashed Safe Deletions)
```

With the audit complete, execution advances immediately to **Phase 1 & 2: Security and Safety Hardening**.

