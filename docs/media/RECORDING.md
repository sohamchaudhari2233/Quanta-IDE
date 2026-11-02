# Quanta IDE - Demo Recording Guide

This script describes the exact sequence for recording the hero demo GIF for the `README.md`.

---

## 🎬 Scene 1: Desktop IDE Setup & Sync
- **Resolution:** 1920x1080 (or 2560x1440 scaled)
- **Duration:** ~8 seconds
1. Open VS Code / Antigravity with a project workspace open.
2. Open the **Quanta IDE** activity bar sidebar.
3. Click **"Quanta: Connect Google Drive"** → Show rapid loopback authentication flow.
4. Click **"Quanta: Push to Google Drive"** → Show progress notification showing delta MD5 scan and fast upload.
5. In bottom-right status bar, highlight `$(cloud) Quanta: In Sync`.

---

## 📱 Scene 2: Mobile Remote Control Pairing & Live View
- **Resolution:** 1080x1920 (Mobile Viewport / iPhone / Android)
- **Duration:** ~12 seconds
1. In PC terminal, run `npm start` in `Remote-Control` → Terminal outputs QR Code with ephemeral pairing ticket.
2. Mobile phone scans QR code → Instantly logs in with clean full-screen PWA interface.
3. Show live visual snapshot updating in sub-100ms as Antigravity thinks and generates code.
4. Tap the **Microphone** icon → Dictate prompt: *"Fix layout overflow on mobile screen"*.
5. Tap **Send** → Show prompt instantly arriving in desktop Antigravity session.
6. Tap **Read-Only** badge → Show elevation modal with control protection.

---

## 🎞️ GIF Assembly
- Combine Scene 1 & Scene 2 side-by-side using `ffmpeg` or ScreenToGif.
- Optimize palette (max 256 colors, 30 fps) to keep file under 8MB.
- Place final output at `docs/media/hero_demo.gif`.

