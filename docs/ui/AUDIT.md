# Quanta IDE UI/UX Comprehensive Audit (`docs/ui/AUDIT.md`)

**Date**: 2026-11-01  
**Scope**: `Remote-Control/public/**`, `Quanta-PC-Extension/src/sidebar.ts`, `Quanta-PC-Extension/package.json`, `Remote-Control/package.json`

---

## 1. Inventory of UI Surfaces & Code Seams

### Surface A: Remote-Control Web & Mobile Client (`Remote-Control/public/`)
| Component / View | File / Location | Responsibility | Current State / Flaws |
| :--- | :--- | :--- | :--- |
| **App Shell** | `index.html`, `style.css` | Header, settings bar, main container, bottom nav | Stretched to 100% on desktop (1920px); lack of responsive two-pane architecture; bottom nav takes vertical space on PC. |
| **Header Bar** | `index.html` lines 21–53 | Brand, agent connection dot, chat controls, STOP button | STOP pill is always visible even when agent is idle; icon buttons have no visible labels on desktop; status dot lacks textual explanation. |
| **Settings / Context Strip** | `index.html` lines 55–90 | Mode, model, project, sync stats, support heart | "Loading Project..." gets stuck indefinitely on network delays; "Syncing..." has no timestamp; heart button is unexplained. |
| **Chat Feed (Tab 1)** | `index.html` lines 100–146, `app.js` | Snapshot streaming, user messages, empty state, composer | Empty state previously had minimal guidance; composer needs dynamic height adjustment without layout jump; missing hold-to-send voice review. |
| **Approvals (Tab 2)** | `index.html` lines 148–158, `app.js` | Pending tool/action approvals | Basic cards; dangerous actions (`rm -rf`, force push) have standard tap buttons with no hold-to-confirm safety net. |
| **Task Queue (Tab 3)** | `index.html` lines 159–169, `app.js` | Background task list | List rendering without drag-and-drop or accessible up/down reorder buttons. |
| **Timeline (Tab 4)** | `index.html` lines 170–180, `app.js` | Audit event timeline | Simple card list rather than a continuous vertical ledger timeline with connecting hairlines. |
| **Tools Hub (Tab 5)** | `index.html` lines 181–213, `app.js` | Diagnostics, quick actions, checkpoints | Flat grid; lacks honest "unavailable" state indicators for missing backend capabilities. |
| **Login / Pairing** | `login.html` | Password gate for remote client | Basic password prompt; lacked lockout countdown and clear LAN vs. tunnel context. |

### Architectural Seams in `app.js` (1,740+ Lines)
Analysis reveals 4 distinct seams in `app.js`:
1. **Network & State Sync** (lines 1–250, 1400–1450): `fetchWithAuth`, `fetchAppState`, `connectWebSocket`, reconnect scheduler.
2. **Snapshot & Chat Rendering** (lines 250–850): DOM parser, markdown formatter, copy button injector, scroll lock.
3. **Modal & Navigation Controllers** (lines 850–1350): Option dialogs, history drawer, support overlay.
4. **Feature Handlers** (lines 1450–1740): Approvals resolution, task queue management, timeline polling, quick actions execution.

---

## 2. Surface B: VS Code / Antigravity Sidebar Webview (`sidebar.ts`)

| Section | Current Implementation | Issues Identified |
| :--- | :--- | :--- |
| **Architecture** | 281 lines with embedded HTML/CSS/JS template string | Violates nonce-based CSP; difficult to test; no modular stylesheet. |
| **Drive Connection** | Button showing "Connected" (misleading button-as-status) | Needs a dedicated status row with masked account name and quiet Disconnect text action. |
| **Workspace Sync** | "Pull" and "Push" buttons side by side in identical blue | No visual distinction between download vs. upload; lacks file counts, conflict warnings, and last sync timestamp. |
| **Version Display** | Hardcoded `v0.1.0` in footer line 239 | Out of sync with `package.json` and project documentation; needs single source of truth. |
| **Inline Scripts** | Inline `onclick="sendCommand('...')"` | Triggers CSP warnings; needs external event listener binding. |

---

## 3. Prioritized Problem Matrix

| Severity | Issue Description | User Impact | Fix Location |
| :--- | :--- | :--- | :--- |
| **CRITICAL** | **Desktop Stretch**: Remote client stretches to 100% width on 1080p/1440p displays. | Empty voids, unreadable text length, poor ergonomics. | `Remote-Control/public/css/layouts.css` |
| **CRITICAL** | **Accidental STOP Mis-Tap**: STOP button always active adjacent to top controls. | Users accidentally kill active agent tasks on mobile taps. | `header` component & `hold-to-confirm` pattern |
| **HIGH** | **Unclear & Endless Loading**: "Loading Project..." and "Syncing..." lack timeouts and timestamps. | Users assume the application is frozen. | `app.js` state renderers with 5s fallback |
| **HIGH** | **Sidebar Template Monolith**: Inline scripts and styles in `sidebar.ts`. | CSP vulnerabilities, maintenance overhead. | `Quanta-PC-Extension/media/` split |
| **MEDIUM** | **Version Mismatch**: Sidebar shows `v0.1.0` while `Remote-Control` is `1.0.0`. | User confusion regarding version currency. | Reconciled from `package.json` |
| **MEDIUM** | **Color Contrast (Light Mode)**: Light muted text on cream backgrounds did not meet WCAG AA (4.5:1). | Readability failure in direct sunlight. | `tokens.css` with verified 5.2:1 ratios |
| **LOW** | **Indic Script Clipping**: Hindi/Odia vowel diacritics cut off in narrow monospace boxes. | Degraded multilingual developer experience. | Font stack fallbacks & `line-height: 1.55` |

---

## 4. Remediation Plan
- **Phase 1**: Define `tokens.css`, `base.css`, `components.css`, `layouts.css` under "Ink & Paper" rules; build living styleguide.
- **Phase 2**: Overhaul `Remote-Control` app shell, header, chat feed, approvals, queue, timeline, and tools with 3 themes (Paper, Graphite, Ink).
- **Phase 3**: Decouple `sidebar.ts` into clean HTML + `media/sidebar.css` + `media/sidebar.js` with nonce CSP and dynamic versioning.
- **Phase 4**: Refine `login.html`, error pages, and verify WCAG 2.2 AA contrast across all surfaces.

