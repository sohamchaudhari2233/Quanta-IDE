# Quanta IDE - Architectural Decision Records (ADR)

## ADR-001: Google Drive OAuth Scope (`drive.file` vs `drive`)
- **Status:** Accepted
- **Context:** `Quanta-PC-Extension` previously requested full `https://www.googleapis.com/auth/drive` scope, which gives full access to all files in the user's personal Google Drive.
- **Decision:** Default to `https://www.googleapis.com/auth/drive.file`, allowing users to optionally configure full `drive` scope in VS Code settings (`quanta.driveScope: "drive.file" | "drive"`).
- **Trade-offs:** 
  - `drive.file` limits the extension to only files and folders it creates or opens. It cannot see pre-existing external files created outside Quanta.
  - For projects uploaded by Quanta, this is completely transparent and infinitely more secure.
  - If a user needs to link to an existing shared team folder created outside Quanta, they can switch to `drive` with re-consent.

## ADR-002: Ephemeral Port for OAuth Loopback Listener
- **Status:** Accepted
- **Context:** Port 3000 was hardcoded in `Quanta-PC-Extension/src/auth.ts`, causing port collision with `Remote-Control` running on port 3000.
- **Decision:** Bind OAuth callback server to `127.0.0.1:0` (ephemeral OS-allocated port). Dynamically construct `http://127.0.0.1:<port>/oauth2callback` and pass to Google authorization server. Use single-use listener with 120s timeout, PKCE (S256), and cryptographically random `state` parameter validation.

## ADR-003: Server-Enforced Read-Only Mode on Remote-Control
- **Status:** Accepted
- **Context:** Remote-Control connects to an AI agent capable of running terminal commands and deleting/modifying source code. Tunnel or external connections had full access by default.
- **Decision:** Enforce `read-only` mode at the Express router and WebSocket dispatcher level. All external/tunnel connections connect in `read-only` mode by default. Elevating to `control` mode requires an explicit desktop authorization action or one-time control passcode, auto-expiring back to `read-only` after 30 minutes of inactivity.

## ADR-004: In-Memory Device Pairing & Session Registry
- **Status:** Accepted
- **Context:** Previously, a static hashed token was shared across all clients, allowing replay attacks and indefinite access with no way to revoke a single device.
- **Decision:** Implement a server-side session registry storing random cryptographically strong UUID session tokens with:
  1. Absolute session lifetime (default: 24h).
  2. Idle timeout (default: 2h).
  3. Device pairing approval queue (desktop terminal/notification must approve new fingerprints).
  4. Immediate server-side session invalidation on `/logout`.

## ADR-005: Safe Deletion via Google Drive Trashing
- **Status:** Accepted
- **Context:** `gdrive.ts` was calling HTTP `DELETE /files/{id}`, which permanently destroys files without ability to restore.
- **Decision:** Call `PATCH /files/{id}` with body `{"trashed": true}`. In addition, implement a safety threshold: if a push action detects more than 20 deletions or >30% of the workspace tree marked for deletion, require explicit modal confirmation.


## ADR-006: Event Bus Architecture in Remote-Control
- **Status:** Accepted
- **Context:** Multiple asynchronous components (CDP bridge, transcript tailer, approval manager, task queue, tunnel supervisor) need to publish and subscribe to state updates without tight coupling.
- **Decision:** Implement a typed in-memory `EventBus` in `Remote-Control` that publishes structured JSON events over WebSockets and keeps a bounded ring buffer (default 500 events) for replaying recent state on mobile reconnection.

## ADR-007: Shadow Git Repository for Checkpoints
- **Status:** Accepted
- **Context:** Users require instant rollback and checkpoints before AI agent tasks run. Modifying the user's primary repository (`.git`) by creating stash or commits interferes with their branches and commit history.
- **Decision:** Create an isolated shadow Git repository under `<workspace>/.quanta/checkpoints/` using `--git-dir=<workspace>/.quanta/checkpoints/.git --work-tree=<workspace>`. All checkpoint operations strictly operate in the shadow git directory, leaving the user's `.git` 100% untouched.

## ADR-008: Shell Command Risk Classification & Auto-Approve Hard Floor
- **Status:** Accepted
- **Context:** Users want to auto-approve safe, routine commands (e.g. `ls`, `git status`, test runs) from their phone while preventing catastrophic operations from running unreviewed.
- **Decision:** Implement a conservative shell parser decomposing compound commands (handling `;`, `&&`, `||`, pipes `|`, redirects, subshells). A hard floor is enforced: any command classified as `dangerous` (e.g. `rm -rf`, `git push -f`, format, sudo, writing to `.env`/secrets) can **never** be auto-approved, regardless of user-configured rules.

## ADR-009: Provider-Agnostic Storage Architecture
- **Status:** Accepted
- **Context:** `Quanta-PC-Extension` was hardcoded to Google Drive. Users need options for S3-compatible storage (AWS S3, MinIO, Cloudflare R2).
- **Decision:** Introduce a clean TypeScript `StorageProvider` interface (`list`, `stat`, `get`, `put`, `trash`, `ensureFolder`, `changesFeed`, etc.). Refactor Google Drive into `GoogleDriveStorageProvider` and implement `S3StorageProvider` and `MockStorageProvider` for unit testing.

## ADR-010: Webhook SSRF Guard
- **Status:** Accepted
- **Context:** Webhooks send event payloads to user-defined URLs. Malicious or compromised webhook configurations could target internal loopback or cloud metadata services (`http://169.254.169.254`, `http://127.0.0.1`).
- **Decision:** Implement strict SSRF validation rejecting IPv4/IPv6 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`) unless explicitly allowed in development mode.

## ADR-011: Multi-Device Spectator & Single Controller Lock
- **Status:** Accepted
- **Context:** Multiple developers or multiple devices (phone + tablet + laptop) may monitor an AI session simultaneously. Allowing multiple devices to execute prompts and approve actions simultaneously creates race conditions and unpredictable state in the IDE.
- **Decision:** Support unlimited concurrent connected devices as read-only spectators, but enforce a single controller lock (`SessionManager.isController`). Only one authorized device at a time holds write and control execution capability, with explicit handover or takeover workflows.

## ADR-012: Inverted Index & Token-Based Local Chat Search
- **Status:** Accepted
- **Context:** Developers need fast search across lengthy Antigravity chat history without transmitting confidential code to third-party search APIs.
- **Decision:** Implement a client-side in-memory inverted index (`ChatSearchIndex`) over redacted transcripts with token-based scoring and dynamic snippet extraction. All indexing and queries run 100% locally on the developer's PC.
