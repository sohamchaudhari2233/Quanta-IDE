# Quanta IDE - Security Policy & Hardening Guide

## 1. Threat Model

Quanta IDE connects an active developer workstation running **Antigravity AI / VS Code** to:
1. **A Real-Time Remote Controller (`Remote-Control`)** reachable across local Wi-Fi or public WAN tunnels (Cloudflare, Ngrok, etc.).
2. **A Cloud Workspace Synchronization Engine (`Quanta-PC-Extension`)** communicating with the Google Drive API.

Because the AI agent inside Antigravity is capable of executing terminal commands, modifying local files, and reading workspace data, **unauthorized control of the remote interface is equivalent to remote code execution on the host machine.**

---

## 2. Security Safeguards

### 2.1 Defense-in-Depth Authentication
- **Timing-Safe Comparison:** All password checks use constant-time `crypto.timingSafeEqual`.
- **Ephemeral Pairing:** Login QR codes use single-use ephemeral tickets (TTL: 120s) instead of embedding secrets in URL parameters.
- **Server-Side Session Invalidation:** Dynamic session tokens with idle timeout (2h) and absolute lifetime (24h).
- **Rate-Limiting & Lockout:** 5 failed attempts locks out an IP address for 15 minutes with exponential backoff.
- **WebSocket Verification:** Handshakes validate `Origin` against authorized hosts and tunnel domains.

### 2.2 Server-Enforced Read-Only Mode
- **Tunnel Default:** All external connections connect in `read-only` mode by default.
- **Enforced at Router Level:** All state-changing routes (`/send`, `/stop`, `/set-mode`, `/new-chat`, `/upload-file`) return `403 Forbidden` if the session is not explicitly elevated to `control` mode.
- **Elevation Timeout:** Elevated sessions automatically expire back to `read-only` after 30 minutes of inactivity.

### 2.3 Cloud Sync & Secret Isolation
- **Built-in Ignore Defaults:** `.env*`, `client_secret*.json`, certificates (`*.pem`, `*.key`), and `node_modules` are hard-blocked from upload by `.quantaignore`.
- **Non-Destructive Trashing:** Files removed from Drive are moved to Trash, preventing accidental permanent data loss.
- **Mass-Delete Guard:** Trashing >20 files or >30% of a workspace requires explicit modal confirmation.
- **Automatic Redaction:** Chat transcripts are scanned and masked for private keys, API keys, tokens, and assignments prior to cloud upload.

---

## 3. Tunnel Hardening Checklist

When running Quanta Remote-Control over a public tunnel:
- [ ] Set a strong, unique `APP_PASSWORD` in `.env` (at least 16 characters).
- [ ] Do **not** enable `ALLOW_LAN_AUTO_TRUST` on shared or untrusted networks (e.g. coffee shop Wi-Fi).
- [ ] Use `cloudflared` with authenticated Access policies where possible.
- [ ] Review `Remote-Control/logs/audit.jsonl` periodically for unexpected IP connections.
- [ ] Ensure Antigravity is started with `--remote-debugging-address=127.0.0.1` so CDP is never exposed.

---

## 4. Reporting a Vulnerability

If you discover a security vulnerability within Quanta IDE, please report it privately:
- **Security Contact:** `security@quanta-ide.dev` (or open a private security advisory on GitHub).
- **Response Target:** Initial response within 48 hours, patch release within 7 days.

