# Quanta IDE - Feasibility Analysis & Scope Decisions

**Date:** November 2026  
**Status:** Complete  
**Engineers:** Akira-official & dark-yoddha

---

## 1. Feasibility Spikes Matrix

| # | Capability | Status | Evidence & Code Anchors | Proposed Technical Approach & Fallback |
|---|---|---|---|---|
| **1** | **Approval Prompt Detection** | **FEASIBLE** | DOM: `.interactive-item-container`, `button[aria-label*="Allow"]`, `button[aria-label*="Proceed"]`<br/>Transcript: `step.tool_calls`, `RequestFeedback: true` | Combined detector: CDP DOM inspector scrapes confirmation cards, cross-referenced with `transcript.jsonl` tool invocations. Generates SHA-256 fingerprint for race-safe resolution. |
| **2** | **Approve / Reject / Edit Actions** | **PARTIAL** | DOM: `clickElement` in `server.js:750` evaluates within chat context.<br/>IDE UI: No native inline edit field exists for modifying agent tool arguments prior to clicking Proceed. | **Approve & Reject:** Fully supported via CDP click bound to fingerprint.<br/>**Edit:** Implemented as "Reject & Send Correction" prompt flow. Clear documentation that inline command editing is not an IDE primitive. |
| **3** | **Agent State Detection** | **FEASIBLE** | DOM: `[data-tooltip-id="input-send-button-cancel-tooltip"]`, `svg.lucide-square`<br/>Transcript: `status: "DONE" / "ERROR"` | State machine tracking `idle`, `thinking`, `running_tool`, `waiting_approval`, `finished`, `errored`. Emits `agent.state` on event bus. |
| **4** | **Stop and Pause Controls** | **PARTIAL** | DOM: `stopGeneration` in `server.js:716` clicks cancel/square button.<br/>Antigravity: No pause/resume primitive exists for LLM token streaming. | **Stop:** Fully supported and audited.<br/>**Pause:** Not feasible in Antigravity. Feature is disabled with clear message explaining lack of pause primitive in LLM code generation. |
| **5** | **Token & Cost Tracking** | **PARTIAL** | Transcript: `step_index`, `content`, `thinking` (no token counts or pricing stored).<br/>UI: No cost counter in DOM. | Implemented as **Estimated Token & Cost Tracker** using standard model pricing ($3/M in, $15/M out) and character heuristics (~4 chars/token). Output is explicitly labeled `ESTIMATED`. |
| **6** | **Image / Attachment to Agent** | **FEASIBLE** | Multi-modal Antigravity supports relative and absolute image paths in prompts (`![desc](path)`). | Mobile uploads image → Server strips EXIF, validates MIME type and dimensions, stores in `.quanta/uploads/` → Inserts markdown reference into prompt input. |
| **7** | **Terminal Output Mirroring** | **PARTIAL** | VS Code API: `onDidWriteTerminalData` is a proposed API restricted from marketplace extensions.<br/>Remote-Control: Can stream stdout/stderr of Quick Actions and monitored tasks. | Quick Actions and background task outputs are streamed to mobile terminal viewer. Arbitrary interactive PTY scraping is documented as restricted by VS Code sandbox. |
| **8** | **Live-Tailing `transcript.jsonl`** | **FEASIBLE** | File: `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` is append-only JSONL. | Background file watcher tracks byte offsets, reads new lines, redacts sensitive tokens, and emits `timeline.entry` events over WebSocket. |

---

## 2. Updated Scope & Implementation Plan

### Tier P0 (Must Ship, Fully Tested)
- **Event Bus:** Typed in-memory event bus in `Remote-Control` with schema, timestamps, session scoping, bounded ring-buffer history.
- **Approval Inbox & Risk Classifier:** Pure shell parser classifying commands into `safe`, `caution`, `dangerous`. Strict race/spoof protection with prompt fingerprinting.
- **Auto-Approve Rules:** Deny-by-default rule engine with non-bypassable hard floor (`dangerous` actions can **never** be auto-approved).
- **Task Queue:** Persisted queue with idempotency keys, reorder, cancel, dispatching only when agent is `idle`.
- **Agent Timeline:** Live-tailed transcript + adapter events with collapsible tool inputs/outputs and secret redaction.
- **Stop & Rollback Checkpoints:** Stop execution control. Pre-task workspace checkpoints utilizing shadow git repository under `.quanta/checkpoints/` (separate `GIT_DIR`, zero modification to user's `.git`). Diff preview before rollback with pre-restore safety checkpoint.
- **Storage Provider Abstraction:** `StorageProvider` interface refactoring Google Drive behind it, with Mock provider for unit tests and S3-compatible provider.
- **Workspace Snapshots & Time Travel:** Content-addressed snapshots on push with retention policy and garbage collection.
- **Selective Sync:** Folder inclusion/exclusion tree picker persisted per workspace.
- **Tunnel Auto-Fallback:** Supervisor managing Cloudflare -> Ngrok -> Pinggy with health checks and hysteresis.
- **Offline Queue:** IndexedDB client-side queue in PWA with idempotency keys and stale prompt confirmation.
- **Setup Wizard & Dashboard:** Interactive `npm run setup` CLI and authenticated web dashboard.

### Tier P1 (Ship if Feasible)
- **Token & Cost Tracker:** Character-heuristic estimator clearly labeled `ESTIMATED`.
- **Git Context:** Sanitized branch/commit/dirty metadata in snapshots.
- **Settings Sync:** Opt-in sync for `settings.json`, `keybindings.json`, snippets, and extension IDs.
- **Phone Mini-IDE:** Workspace-jailed file browser, small safe edits with optimistic concurrency, and quick-actions allowlist.
- **Image-to-Agent:** EXIF-stripped photo upload with markdown prompt injection.
- **Telegram Bot:** Real-time push alerts for approvals and task completion.
- **Chat Search & Prompt Library:** Fast local search over redacted transcripts and reusable prompt templates.
- **Multi-Device View:** Read-only observers with single controller lock.
- **Webhooks:** HMAC-SHA256 signed payloads with retry backoff and SSRF protection.
- **Plugin System:** Sandboxed plugin worker threads with capability declarations.
- **S3-Compatible Provider:** Support for AWS S3, MinIO, and Cloudflare R2.

### Tier P2 (Design Documents)
- `docs/design/team-workspaces.md`: Architecture for shared cloud folders and presence hints.
- `docs/design/webrtc-p2p.md`: Analysis of WebRTC P2P direct connectivity, signaling, and TURN trade-offs.
- `docs/design/llm-chat-intelligence.md`: Design for opt-in LLM session summarization and digest generation.
- `docs/design/docker-deployment.md`: Containerization architecture and loopback CDP constraints.
- `docs/design/whatsapp-integration.md`: WhatsApp Business API limitations and webhook gateway design.

