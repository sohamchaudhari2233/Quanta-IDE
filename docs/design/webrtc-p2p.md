# WebRTC Direct Peer-to-Peer Streaming Design Document (P2 Feature)

**Authors:** Akira-official & dark-yoddha  
**Status:** Proposed / Draft (P2)  
**Target:** Quanta IDE Remote-Control Low-Latency Connectivity Layer

---

## 1. Executive Summary

Quanta IDE currently streams screen snapshots (JPEG/PNG) and DOM representations over WebSockets, routed through an HTTPS tunnel (Cloudflare, Ngrok, Pinggy, or LocalXpose). While this works across arbitrary NATs, streaming high-frame-rate UI updates through external HTTP tunnels introduces noticeable latency (150–500ms) and consumes external tunnel bandwidth.

This document presents the architectural design for a direct WebRTC peer-to-peer connection between the developer's desktop and the mobile client, utilizing `MediaStream` for hardware-accelerated video and `RTCDataChannel` for sub-50ms control events.

---

## 2. Architecture & Data Flow

```
[ Developer Desktop (Remote-Control) ]                     [ Mobile Client Phone ]
         │                                                            │
         │ 1. Signaling (SDP Offer / Answer over Authenticated WS)     │
         │◄──────────────────────────────────────────────────────────►│
         │                                                            │
         │ 2. ICE Candidate Gathering (STUN: stun.l.google.com:19302) │
         │◄──────────────────────────────────────────────────────────►│
         │                                                            │
         │ 3. Direct DTLS-SRTP PeerConnection Established             │
         ├════════════════════════════════════════════════════════════┤
         │ === Video Stream (H.264 / VP8 Desktop Capture) ===========>│
         │ <== RTCDataChannel 'control' (Touch, Clicks, Prompts) =====│
         │ === RTCDataChannel 'terminal' (Live Terminal Stream) =====>│
         └════════════════════════════════════════════════════════════┘
```

---

## 3. Key Components

### 3.1 Signaling Server
- Embedded into the existing Express WebSocket server.
- Clients exchange SDP Offers, SDP Answers, and ICE candidates.
- **Security Check:** WebRTC signaling is only permitted if the WebSocket connection has passed:
  1. Valid signed session cookie (`quanta_session`).
  2. Approved device fingerprint.

### 3.2 Video Pipeline (Desktop to Phone)
- Desktop captures Antigravity window or CDP screencast frames (`Page.startScreencast`).
- Frames are fed into a Node-native WebRTC video track (using `@krisp/node-webrtc` or lightweight GStreamer pipeline) or canvas stream.
- Video codec: H.264 (hardware-accelerated on mobile iOS/Android) or VP8.
- Target latency: **< 60ms** on LAN, **< 120ms** on P2P WAN.

### 3.3 Data Channels
- **`control` Channel (Ordered, Reliable):**
  - Sends user prompts, quick action triggers, and approval decisions.
  - Sends touch/click coordinates with viewport scaling.
- **`terminal` Channel (Ordered, Reliable):**
  - Streams ANSI terminal output directly from spawned subshells to the mobile xterm-lite viewer.

### 3.4 NAT Traversal & Fallback
- Default STUN servers: `stun:stun.l.google.com:19302`.
- Symmetric NAT handling: If direct P2P connection fails after 8 seconds (ICE failure), gracefully degrade to the existing WebSocket + HTTP tunnel transport.

---

## 4. Threat Model & Security Controls

1. **Mandatory DTLS-SRTP:**
   - All media and data channels are encrypted end-to-end with ephemeral DTLS keys. Even if the signaling channel were intercepted, peer data cannot be read in transit.
2. **Controller Mutual Exclusion:**
   - The desktop enforces that only the verified controller session can send messages across the `control` data channel. Spectators receive read-only data channels.
3. **No Unauthenticated TURN Relay:**
   - To avoid running an open relay, any optional TURN server must use time-limited HMAC credentials (`turn:user?transport=udp`).

---

## 5. Milestone & Implementation Plan

- **Phase P2.1:** Implement signaling message schema (`webrtc:offer`, `webrtc:answer`, `webrtc:candidate`) on the WebSocket bridge.
- **Phase P2.2:** Build mobile WebRTC client in `Remote-Control/public/js/webrtcClient.js`.
- **Phase P2.3:** Integrate headless desktop frame source and evaluate native dependency size versus WebCodecs polyfill.
- **Phase P2.4:** Automated fallback test ensuring seamless switch to WebSocket when UDP is blocked by corporate firewall.

