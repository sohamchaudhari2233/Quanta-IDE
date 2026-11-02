# Quanta PC Extension

**Quanta PC Extension** seamlessly connects your desktop IDE (Google Antigravity / VS Code) with Quanta IDE cloud synchronization, agent control, and mobile pairing.

Developed by **Akira-official** & **dark-yoddha**.

---

## Features

- **Google Drive & Cloud Storage Sync:** Bidirectional workspace delta sync with three-way conflict detection and content-addressed snapshots.
- **Antigravity Chat Integration:** Automatically captures, redacts, and exports AI pairing sessions with client-side encryption.
- **Local Transcript Search:** Instant keyword search and snippet extraction across all Antigravity session history.
- **Prompt Library:** Built-in and user-customizable prompt templates with parameter substitution (`{{file}}`, `{{error}}`).
- **Interactive Sidebar Panel:** Connect, sync, and preview changes with one click.

---

## Installation

1. In VS Code or Antigravity IDE, open the **Extensions** view (`Ctrl+Shift+X`).
2. Click the `...` menu in the top right of the Extensions panel.
3. Select **Install from VSIX...**
4. Choose the `quanta-pc-extension-0.1.0.vsix` file.

---

## Commands

- `Quanta: Connect Google Drive` (`quanta.login`)
- `Quanta: Push to Google Drive` (`quanta.push`)
- `Quanta: Pull from Google Drive` (`quanta.pull`)
- `Quanta: Preview Sync Changes` (`quanta.preview`)
- `Quanta: Sync Antigravity Chats` (`quanta.syncChats`)
- `Quanta: Run System Doctor` (`quanta.doctor`)

