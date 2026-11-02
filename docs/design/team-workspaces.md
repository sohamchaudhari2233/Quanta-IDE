# Team Workspaces & Multi-Developer Collaboration Design Document (P2 Feature)

**Authors:** Akira-official & dark-yoddha  
**Status:** Proposed / Draft (P2)  
**Target:** Quanta IDE Enterprise & Team Architecture

---

## 1. Executive Summary

Quanta IDE was initially conceived for individual developers pairing with AI agents and controlling workflows remotely from mobile devices. As development teams adopt agentic pair programming, multiple developers require shared visibility into agent activities, collaborative review of high-risk actions, synchronized workspace snapshots, and centralized audit compliance.

This document details the architecture for multi-developer Team Workspaces in Quanta IDE.

---

## 2. Role-Based Access Control (RBAC)

Every paired device or API client is assigned a cryptographic identity associated with one of three roles:

| Role | Permissions | Approval Rights | File Editing |
| :--- | :--- | :--- | :--- |
| **Admin** | Full control, add/revoke team members, override lockouts, modify security policies | Any risk (Safe, Caution, Dangerous) | Unrestricted |
| **Operator** | Run prompts, execute approved quick actions, pull/push snapshots | Safe & Caution actions only | Restricted to assigned files |
| **Spectator** | View live agent timeline, read-only file browser, view logs | None (Read-only) | Read-only |

---

## 3. Shared Workspace Snapshots & Cloud Manifests

### 3.1 Content-Addressed Object Store
- Team workspaces share a common cloud backend (Google Cloud Storage, AWS S3, or shared Google Drive root).
- Blob storage (`.quanta/blobs/<sha256>`) deduplicates identical files across all team members, saving up to 80% bandwidth.
- Snapshots reference blob manifests with author metadata and cryptographic signatures.

### 3.2 Concurrent Edit Protection & File Leases
- When an operator or agent begins modifying a file via `FileBrowser.writeFile`, an ephemeral file lease is registered on the workspace coordinator:
  ```json
  {
    "path": "src/auth/jwt.ts",
    "leasedBy": "akira-laptop",
    "expiresAt": 1709420000000,
    "leaseToken": "lease_9a2f7c..."
  }
  ```
- Other team members attempting to modify the same file receive a soft conflict warning with an option to request release.

---

## 4. Centralized Audit Log & Compliance Streaming

- Local JSONL audit logs (`.quanta/logs/audit.jsonl`) are automatically batched and streamed to the team's central SIEM / compliance bucket (e.g. Datadog, CloudWatch, or Google Cloud Logging).
- Every log entry includes:
  - `operatorId` (developer or subagent)
  - `deviceFingerprint`
  - `action` (e.g. `FILE_WRITE`, `CHECKPOINT_RESTORE`, `APPROVAL_RESOLVE`)
  - `riskTier` and `hash`

---

## 5. Security & Threat Mitigation

1. **Privilege Escalation:** Spectators and Operators cannot elevate themselves to Admin without multi-factor authorization signed by an existing Admin.
2. **Untrusted Sync Protection:** When pulling snapshots created by another team member, executable binaries and `.env` files are excluded by `.quantaignore` and require explicit operator confirmation before local extraction.
3. **Audit Immutability:** Remote log shipping uses append-only credentials.

