# Quanta IDE UI/UX Architecture Decisions Log (`docs/ui/DECISIONS.md`)

This log records every significant design, front-end architecture, and interaction decision made during the "Ink & Paper" redesign.

---

## Decision 1: Design Identity — "Ink & Paper" over Tech/AI Clichés
- **Context**: The existing interface had floating neon/purple gradients, generic chatbot buttons, and glow shadows that felt like an "AI novelty" rather than a precision developer tool controlling real machines and file systems.
- **Decision**: Adopt the "Ink & Paper" design system:
  1. Flat solid surfaces, hairline rules (`1px` and `double` rules), clear editorial hierarchy.
  2. Depth achieved through tone shifts and rules rather than blur or glow.
  3. Single vermilion signal accent (`#B8402A` in Paper, `#E0705A` in Graphite/Ink) reserved for danger, stop, and pending approvals.
  4. Primary actions are ink on paper (inverted per theme).
- **Consequences**: Calmer interface, zero visual distraction, immediate credibility, fast rendering without GPU compositing lag.

---

## Decision 2: Three First-Class Themes & Zero-Flash Pre-Paint Bootstrapping
- **Context**: Users switch between daylight coding, dim office work, and late-night mobile monitoring.
- **Decision**: Provide three distinct themes:
  1. **Paper** (light): Cream paper (`#F3EEE3`) with warm near-black ink (`#1F1D1A`), utilizing the user's authentic minimalist sepia landscape paper background.
  2. **Graphite** (dark): Warm charcoal (`#1A1A19`) with bone-white text (`#E9E5DA`), utilizing the golden contour pagoda landscape paper background.
  3. **Ink** (dark OLED): True black (`#0B0B0A`) with bone text (`#ECE8DE`) for maximum battery savings on mobile OLED screens.
  - Implement a synchronous inline `<script>` in `<head>` that inspects `localStorage.getItem('quanta_theme')` and `window.matchMedia('(prefers-color-scheme: dark)')` to set `data-theme` on `<html>` before first render, eliminating flash of unstyled content (FOUC).

---

## Decision 3: Honest States & Elimination of Ambiguous UI
- **Context**: The existing header had an endless "Loading Project..." chip when project inspection lagged, an ambiguous "Syncing..." label with no timestamp, an unexplained heart icon, and an omnipresent emergency `STOP` button.
- **Decision**:
  1. **Project Name**: Timeout after 5 seconds with a retry button ("Workspace unavailable · Retry") instead of an endless spinner.
  2. **Sync State**: Human-readable words ("Synced 2m ago", "Sync idle", "Pushing 3 files…").
  3. **Heart Icon**: Removed from header; moved to Tools → Support Developer modal with clear text.
  4. **Emergency Stop**: Visible **only** while the agent is actively executing. Requires a **900ms hold-to-confirm** (or double-press Enter on keyboard) to prevent accidental mis-taps.

---

## Decision 4: Responsive Breakpoints & Intentional Desktop Architecture
- **Context**: Opening the mobile web app on a 1920×1080 desktop browser resulted in stretched 100% width inputs and vast empty black voids.
- **Decision**:
  - **Phone (<600px)**: Single column, 100dvh, bottom navigation with text labels.
  - **Tablet (600–1023px)**: Centered column (max 720px), bottom nav with side rail support.
  - **Desktop (≥1024px)**: Two-pane ledger layout with left rail (navigation + sessions) and centered content column (max ~760px). Never edge-to-edge stretching.

---

## Decision 5: Nonce-Based CSP & Modularized VS Code Sidebar
- **Context**: `Quanta-PC-Extension/src/sidebar.ts` contained a 280-line inline HTML template string with inline CSS, inline SVG, and inline JS handlers (`onclick="sendCommand('pull')"`).
- **Decision**:
  - Move styles to `media/sidebar.css` and scripts to `media/sidebar.js`.
  - Enforce a strict nonce-based Content Security Policy with `webview.cspSource`.
  - Reconcile version string from `package.json` dynamically instead of hardcoding `v0.1.0`.

---

## Decision 6: Indic Script & Typography Stack
- **Context**: Many users write Hinglish, Hindi, and Odia prompt instructions. Standard monospace and sans stacks often render Indian scripts with broken diacritics or cramped line-height.
- **Decision**:
  - Headings / Numerals: Serif display (`Literata`, `Georgia`, serif).
  - UI Sans: `Inter`, `IBM Plex Sans`, `-apple-system`, `BlinkMacSystemFont`, with explicit fallbacks `Noto Sans Devanagari`, `Noto Sans Oriya`, `Nirmala UI`.
  - Code: `JetBrains Mono`, `IBM Plex Mono`, monospace with ligatures disabled in terminal/command views.
  - Generous `line-height: 1.55` to prevent Indic vowel mark clipping.

---

## Decision 7: Google OAuth PKCE Port 80 & Loopback RFC 8252 Reconciliation
- **Context**: Desktop OAuth client secrets downloaded from Google Cloud Console specify `redirect_uris: ["http://localhost"]` without a port. When the extension sent `redirect_uri=http://localhost:8085`, Google strictly rejected the request with `Error 400: redirect_uri_mismatch`.
- **Decision**:
  - When credentials contain `http://localhost` without an explicit port, attempt to bind loopback on standard HTTP port 80.
  - If port 80 binds, format the redirect URI exactly as `http://localhost`, satisfying Google's exact string matching.
  - If port 80 is unavailable (`EACCES`/`EADDRINUSE`), fallback to port 8085, provide a one-click button to copy `http://localhost:8085` to clipboard for Google Cloud Console registration, and simultaneously prompt with a manual authorization code input box (`vscode.window.showInputBox`).

---

## Decision 8: Transparent Session Elevation for Authenticated Clients
- **Context**: External network and tunnel requests defaulted to `read-only` mode for safety, but entering the master password on mobile/LAN was not automatically promoting the session to `control` mode, leading to 403 Forbidden errors when triggering actions or sending messages.
- **Decision**:
  - Valid master password authentication on `/login` automatically elevates the session to `control` mode for 24 hours.
  - Client-side `fetchWithAuth` intercepts 403 `read-only` errors and provides an in-place elevation password prompt, automatically retrying the request upon successful verification.

---

## Decision 9: Resilient Standby State when CDP is Offline
- **Context**: When Antigravity IDE is launched without `--remote-debugging-port=9000`, Chrome DevTools Protocol calls fail with ECONNREFUSED, causing the UI context bar to remain indefinitely on "Loading Project..." and "Syncing...".
- **Decision**:
  - `/app-state` returns `{ cdpConnected: false, mode: 'Standby', model: 'Antigravity (Local)', project: 'quanta-ide' }`.
  - The client displays honest, calm standby status without blocking the UI, rendering an informative empty state with instructions on how to start Antigravity with `--remote-debugging-port=9000`.

---

## Decision 10: Interactive Layer Visibility Contracts
- **Context**: Modal popups (`#modalOverlay`) and History drawers (`#historyLayer`) were hidden via `display: none`, but lacked corresponding flex display overrides when their active classes (`.show`, `.active`) were toggled.
- **Decision**:
  - Explicit CSS rules `.sheet-overlay.show, .sheet-overlay.active, .modal-overlay.show, .modal-overlay.active, .history-layer.show { display: flex !important; }` enforce reliable opening across desktop and mobile.
  - Quick action chips immediately trigger appropriate agent execution (e.g. "Continue", "Run Tests", "Git Status").

