# Quanta IDE "Ink & Paper" Design System Specification (`docs/ui/DESIGN.md`)

## 1. Design Philosophy

Quanta IDE is a professional instrument that commands an autonomous AI agent capable of running terminal commands and modifying file trees. It must look and feel **calm, precise, tactile, and trustworthy** — reminiscent of quality editorial stationery, fine bookbinding, and a printed financial ledger.

### Non-Negotiable Tenets
1. **Solid, not shiny**: Flat, solid surfaces, hairline rules (`1px` and `double` rules), clear typographic hierarchy. No gradients on buttons or text, no glow shadows, no neon, no glassmorphism/backdrop blur.
2. **One accent, used rarely**: Primary actions are ink on paper (monochrome inversion per theme). A single warm signal color (Vermilion `#B8402A` / `#E0705A`) carries urgency and risk. Muted semantic colors (moss, ochre, ink blue) are always paired with icons or text labels.
3. **Typography carries the weight**: Refined serif for headings and key numerals, clean humanist sans for UI labels, precise monospace for commands and paths.
4. **Authentic Paper Texture**: Page canvases utilize authentic Chinese/Japanese minimalist ink landscape artwork (`bg-paper.png` in Paper, `bg-graphite.png` in Graphite) as subtle background textures. Text-holding cards are always solid to guarantee 100% legibility.
5. **Calm under risk**: Destructive and dangerous actions (e.g., emergency Stop, `rm -rf`, force push) require **900ms hold-to-confirm** with a filling progress rule or explicit keyboard confirmation.

---

## 2. Themes Contract

| Token | Paper (Light) | Graphite (Dark) | Ink (OLED Dark) |
| :--- | :--- | :--- | :--- |
| `--bg` | `#F3EEE3` | `#1A1A19` | `#0B0B0A` |
| `--surface` | `#FBF8F1` | `#222221` | `#121211` |
| `--surface-sunken` | `#EAE4D6` | `#161615` | `#070706` |
| `--surface-raised` | `#FFFDF8` | `#2A2A28` | `#1A1A18` |
| `--text` | `#1F1D1A` | `#E9E5DA` | `#ECE8DE` |
| `--text-2` | `#5C574E` | `#A9A498` | `#A39E92` |
| `--text-3` | `#847E72` | `#7C786E` | `#77736A` |
| `--rule` | `#D9D1BF` | `#3A3935` | `#2A2926` |
| `--rule-strong` | `#B9AF98` | `#55534C` | `#3E3C37` |
| `--signal` | `#B8402A` | `#E0705A` | `#E8785F` |
| `--ok` | `#4F6B3A` | `#8DB071` | `#93B677` |
| `--caution` | `#9A6B14` | `#D9A441` | `#DEAA48` |
| `--info` | `#2F4A6B` | `#86A4C9` | `#8BA9CE` |
| `--bg-artwork` | `url('../assets/bg-paper.png')` | `url('../assets/bg-graphite.png')` | `none` (OLED black) |

### Theme Persistence & Zero-Flash Pre-Paint
Theme selection (`System`, `Paper`, `Graphite`, `Ink`) is stored in `localStorage.getItem('quanta_theme')`. An inline blocking script in `<head>` sets `data-theme` on the root `<html>` element before first paint, preventing any white/dark flash.

---

## 3. Typography & Multilingual Support

```
Display / Headings:    'Literata', 'Source Serif 4', 'Georgia', serif
UI Text:               'Inter', 'IBM Plex Sans', -apple-system, sans-serif
Multilingual Fallbacks: 'Noto Sans Devanagari', 'Noto Sans Oriya', 'Nirmala UI'
Code / Monospace:      'JetBrains Mono', 'IBM Plex Mono', Consolas, monospace
```
- **Indic Script Support**: Explicitly supports Hindi (Devanagari) and Odia scripts with `line-height: 1.55` and optical diacritic clearance to eliminate clipping on vowel signs (`matras`).
- **Ligatures**: Explicitly disabled (`font-variant-ligatures: none;`) for code and terminal displays to prevent misleading character merging in flags (`--`) and operators.

---

## 4. Component Catalog

### 4.1 Buttons
- **Primary (`.btn-primary`)**: Solid ink fill (`var(--accent)`), paper text (`var(--accent-contrast)`).
- **Secondary (`.btn-secondary`)**: 1px hairline border (`var(--rule-strong)`), transparent background.
- **Hold-to-Confirm (`.btn-hold-confirm`)**: Requires a continuous 900ms press (or Enter double-tap). Shows an advancing progress rule. Used for emergency STOP and dangerous operations.
- **Danger (`.btn-danger`)**: Vermilion hairline border.

### 4.2 Status Primitives
- **Connection Badge**: Dot + exact words (`Connected · LAN`, `Connected · Tunnel`, `Offline`).
- **Stamp Badges**: Double-bordered small caps stamps for risk classification (`SAFE`, `CAUTION`, `DANGEROUS`).
- **Mode Chip**: Clear toggle for `Read-only` vs `Control`.

### 4.3 Ledger Rows
Data pairs are laid out as ledger rows with dotted leader rules:
```
Session ID ............................................ ses_8829f0a
Google Drive Workspace ................................ Synced 2m ago
```

---

## 5. Responsive Dual Layout

- **Mobile (<600px)**: 100dvh, edge-to-edge layout, bottom navigation bar with text labels, safe area insets.
- **Tablet (600–1023px)**: Centered column (max 760px).
- **Desktop (≥1024px)**: Two-pane layout:
  - **Left Rail (250px)**: Brand, connection state, navigation tabs, session history, and theme switcher.
  - **Main Viewport (flex: 1, max 760px content column)**: Editorial conversation transcript, approvals inbox, task queue, timeline, or tools hub.

---

## 6. Anti-Slop Checklist

- [x] No purple/indigo/violet gradients; no neon or rainbow accents.
- [x] No glow shadows, glassmorphism, or backdrop blur.
- [x] No emoji used as icons; all icons are 1.5px stroke hairline SVGs.
- [x] No "AI sparkle", robot, or magic wand clichés.
- [x] No nested card-in-card clutter; sections divided by hairline rules.
- [x] Primary actions are solid ink on paper; vermilion signal color used only for alerts and risk.
- [x] Dangerous actions (STOP, deletions) require hold-to-confirm.
- [x] Every status communicates in explicit human-readable words, not just colored dots.
- [x] High-contrast WCAG 2.2 AA verified across Paper, Graphite, and Ink.
- [x] The interface looks stunning and readable even as a pure grayscale screenshot.

