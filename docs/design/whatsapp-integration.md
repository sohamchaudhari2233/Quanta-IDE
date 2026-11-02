# WhatsApp Integration Design Document (P2 Feature)

**Authors:** Akira-official & dark-yoddha  
**Status:** Proposed / Draft (P2)  
**Target:** Quanta IDE Remote-Control Mobile Notification & Control Bridge

---

## 1. Executive Summary

Quanta IDE enables developers to monitor long-running AI agent tasks and safely approve/reject privileged terminal actions and file modifications. While the web interface and Telegram bot provide instant feedback, developers frequently request WhatsApp notifications due to its ubiquity and reliable push notifications.

This document details the architectural design, security requirements, and protocol trade-offs for integrating WhatsApp into Quanta IDE.

---

## 2. Protocol & Architecture Comparison

| Dimension | Meta WhatsApp Cloud API (Recommended) | Web-Session Scraping (Baileys / WA-Web) |
| :--- | :--- | :--- |
| **Official Support** | Fully supported by Meta Graph API | Reverse-engineered WebSockets |
| **Ban Risk** | Zero (Official API) | High risk of number banning |
| **Proactive Messages** | Requires approved HSM templates | Unrestricted free-form messaging |
| **Interactive Buttons** | Native Quick Reply buttons | Native buttons (frequently broken by WA updates) |
| **Setup Complexity** | Requires Meta Developer App & Token | Requires scanning QR code in terminal |
| **Local Isolation** | HTTPS webhooks & outbound REST | Runs headless Chromium or Node crypto session |
| **Verdict** | **Preferred for production** | Alternative for development-only disposable numbers |

---

## 3. Architecture & Data Flow (Cloud API)

```
[ Antigravity Agent ]
        │
        ▼ (EventBus: approval:requested)
[ Quanta Remote-Control ]
        │
        ▼ (POST /v18.0/{phone_number_id}/messages)
[ Meta Graph API ]
        │
        ▼ (Push Notification)
[ Developer WhatsApp ]
        │
        ▼ (User taps "Approve" button)
[ Meta Cloud Webhook ]
        │
        ▼ (POST /api/webhooks/whatsapp)
[ Quanta Webhook Handler (HMAC-SHA256 verified) ]
        │
        ▼ (ApprovalManager.resolve)
[ Agent Resumes Execution ]
```

---

## 4. Threat Model & Security Controls

Because approving actions gives terminal execution rights, WhatsApp message processing must satisfy strict security guarantees:

1. **Sender Phone Whitelisting:**
   - Every inbound webhook payload contains `entry[0].changes[0].value.messages[0].from`.
   - The handler checks this against `WHATSAPP_ALLOWED_NUMBERS` (comma-separated E.164 strings). Messages from unauthorized numbers are discarded immediately with a warning audit log.

2. **Webhook Cryptographic Verification:**
   - Inbound webhook requests from Meta must carry the `X-Hub-Signature-256` header.
   - The server verifies `crypto.timingSafeEqual(hmac(rawBody, META_APP_SECRET), signature)`. If invalid, HTTP 401 is returned.

3. **Challenge Verification (GET /api/webhooks/whatsapp):**
   - Implements `hub.mode === 'subscribe'` and verifies `hub.verify_token === WHATSAPP_VERIFY_TOKEN`.

4. **Action Expiry & Replay Prevention:**
   - Every approval request includes a unique nonce/ID with a 15-minute TTL.
   - Replay attempts for expired or already-decided approvals return "Action already resolved".

5. **Approval Hard Floor:**
   - As enforced by the Quanta Rule Engine, commands categorized as `dangerous` still require manual confirmation and cannot be triggered by automated reply bots.

---

## 5. Interactive Message Templates

### Approval Alert (Interactive Button Message)
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+1234567890",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "text", "text": "Quanta IDE Approval Request" },
    "body": { "text": "Action: terminal_command\nCommand: npm test\nRisk: CAUTION" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "approve_req_123", "title": "Approve" } },
        { "type": "reply", "reply": { "id": "reject_req_123", "title": "Reject" } }
      ]
    }
  }
}
```

---

## 6. Implementation Checklist for Phase P2

- [ ] Register Quanta IDE Developer App on Meta Developer Portal.
- [ ] Implement `Remote-Control/notifications/whatsappClient.js` with exponential backoff.
- [ ] Mount `/api/webhooks/whatsapp` endpoint in `Remote-Control/server.js` with signature verification.
- [ ] Add configuration variables to `.env.example`:
  - `WHATSAPP_CLOUD_TOKEN`
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_VERIFY_TOKEN`
  - `WHATSAPP_ALLOWED_NUMBERS`
- [ ] Add integration test suite with mock Meta webhook payloads.

