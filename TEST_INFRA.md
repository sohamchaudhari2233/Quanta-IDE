# Quanta IDE End-to-End Test Infrastructure Specification

**Document Version:** 1.0.0  
**Status:** Approved & Active  
**Scope:** Full Workspace (`Quanta-PC-Extension` & `Remote-Control`)  
**Directory:** `tests/e2e/`  

---

## 1. Test Philosophy & Design Principles

### 1.1 Opaque-Box, Requirement-Driven Testing
The Quanta IDE E2E test suite adheres to strict **opaque-box** testing principles. Tests validate externally observable behaviors, network protocols, filesystem state contracts, and security boundaries specified in `PROJECT.md`, `ORIGINAL_REQUEST.md`, and the system specification survey.

Key tenets:
1. **Zero Internal Module Dependencies**: Test suites must NOT import internal, unexported, or implementation-specific files from `Quanta-PC-Extension/src/` or `Remote-Control/`. This ensures the test suite remains authoritative, independent, and invariant during concurrent worker refactoring.
2. **Contract-Based Assertions**: Tests interact with public interfaces: HTTP endpoints, loopback sockets, RFC 7636 PKCE exchanges, `.quanta/` manifest structures, file jail boundaries, and risk classification rules.
3. **Deterministic & Isolated**: Each test case sets up its own state (e.g. isolated ephemeral ports, temporary sandbox directories in `os.tmpdir()`), executes without relying on shared global state, and tears down all resources upon completion.
4. **Standard Node.js Toolchain**: Tests are written in pure modern ES Modules utilizing Node's built-in `node:test` and `node:assert/strict` harnesses, requiring zero third-party testing dependencies.

---

## 2. Feature Inventory Mapping (F-01 through F-25)

The following matrix maps every feature defined in `PROJECT.md` to its corresponding E2E test coverage across all test tiers:

| ID | Feature Name | Primary Contract / Observable Behavior | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Workflows) |
|---|---|---|---|---|---|---|
| **F-01** | OAuth 2.0 PKCE Hardening | Port 8085 listener mutex, IPv4/IPv6 loopback binding, S256 verifier/challenge verification, state token validation, manual code paste fallback. | `tier1: OAuth PKCE Exchange` | `tier2: Port Collision & Ephemeral Fallback` | `tier3: OAuth + Drive Sync Session` | `tier4: Scenarios 1 & 3` |
| **F-02** | Three-Way Delta Sync Engine | Computes delta plan between local tree, remote Drive tree, and base manifest (`upload`, `download`, `conflict`, `deleteRemote`, `deleteLocal`, `noChange`). Conflict policies `keepLocal`, `keepRemote`, `downloadRemote`. | `tier1: Three-Way Sync Plan` | `tier2: Empty Manifests & Truncated Trees` | `tier3: Drive Sync + Ignore Rules` | `tier4: Scenario 3` |
| **F-03** | Ignore Rule Trailing Slash Fix | Directory trailing slash rule (e.g. `vendor/`) matches all nested files. Immutable defaults protect `.env*`, `client_secret*.json`, `*.pem`, `*.key`. Negation with `!` rejected for defaults. | `tier1: Ignore Engine & Trailing Slash` | `tier2: Nested Slashes & Negation Bypass` | `tier3: Drive Sync + Ignore Rules` | `tier4: Scenario 3` |
| **F-04** | Binary Sync & MIME Detection | Binary buffers handled without UTF-8 corruption. Magic byte sniffing detects PNG (`89 50 4E 47`) and JPEG (`FF D8 FF`). Safe trashing flags `trashed: true`. | `tier1: Binary Buffer & Safe Trashing` | `tier2: Zero-Length Buffers & Spoofed MIME` | `tier3: Selective Sync + Blob Snapshots` | `tier4: Scenario 3` |
| **F-05** | Drive Query Injection & Pagination | Single quotes escaped in Drive queries (`name = 'foo\'bar'`). Pagination token handling loop over multi-page results. | `tier1: Drive Query & Pagination` | `tier2: Single Quotes & Injection Payloads` | `tier3: Drive Sync + Query Escaping` | `tier4: Scenario 3` |
| **F-06** | Extension Dependency & Config | Package manifest validity, ES Module type configuration, clean entry points without unneeded weight. | `tier1: Package Config & Resolution` | `tier2: Malformed package.json Handling` | `tier3: Dependency Resolution Flow` | `tier4: Scenario 1` |
| **F-07** | WebSocket Tunnel Auth & Redirect | Signed cookie `ag_auth_token` verified during WS handshake. Validates session in `SessionManager`. Rejects unauthorized handshakes with 401/403. | `tier1: WebSocket Cookie Auth` | `tier2: Invalid / Expired Session Cookies` | `tier3: Session Elevation + WS Messages` | `tier4: Scenario 1` |
| **F-08** | WebSocket LAN Zero-Trust | `sessionManager.allowLanAutoTrust` checked before granting auto-authentication to local callers. External callers default to zero-trust read-only. | `tier1: LAN Zero-Trust Enforcement` | `tier2: Spoofed Localhost IP Headers` | `tier3: Rate Limiter + Zero-Trust Mode` | `tier4: Scenario 1` |
| **F-09** | Checkpoints API Integration | `workspaceRoot` passed correctly. Rollback signature strictly `(workspaceRoot, checkpointId)`. Shadow git creates commit snapshots under `.quanta/checkpoints/`. | `tier1: Checkpoints List & Rollback` | `tier2: Non-Existent Checkpoint IDs` | `tier3: Checkpoints Rollback + Task Queue` | `tier4: Scenario 2` |
| **F-10** | CDP Script Sanitization | Escapes `selector` and `scrollPercent` before string interpolation in `Runtime.evaluate`. Prevents DOM script breakout. | `tier1: CDP Script Sanitization` | `tier2: Injected Script Tags & Quotes` | `tier3: Quick Actions + CDP Dispatch` | `tier4: Scenario 2` |
| **F-11** | AuditLogger Subsystem Normalization | Append-only structured JSONL logging. Normalizes signatures across image uploads, webhooks, tunnels, and quick actions. Secret redaction on log summaries. | `tier1: AuditLogger Structured JSONL` | `tier2: Control Characters & Max Log Sizes` | `tier3: Audit Logger + SSRF Guard` | `tier4: Scenario 2` |
| **F-12** | EventBus Dot/Colon Listener Alignment | Normalizes event names across webhooks, bot notifications, and approvals (`approval.requested`). Ring buffer history recall. | `tier1: EventBus Dot/Colon Alignment` | `tier2: Unregistered Events & Max Ring Cap` | `tier3: Telemetry Reporting + EventBus` | `tier4: Scenario 4` |
| **F-13** | QuickActions Allowlist Matching | Safe command allowlist. Supports `run-tests` alias matching registered `act-npm-test`. Enforces 30s timeout and 512KB buffer cap. | `tier1: QuickActions Execution & Aliases` | `tier2: Unregistered Commands & Timeouts` | `tier3: Quick Actions + Risk Classifier` | `tier4: Scenario 2` |
| **F-14** | Live System Telemetry Computation | Dynamically calculates OS CPU percent, used/total RAM, and real disk percentage. Eliminates hardcoded `46%` disk value. | `tier1: Live Telemetry Metrics` | `tier2: Division by Zero & Negative Bounds` | `tier3: Telemetry Reporting + EventBus` | `tier4: Scenarios 1 & 5` |
| **F-15** | Extension Sidebar Live Telemetry | Probes `https://127.0.0.1:<port>/health` dynamically. Updates Last Sync timestamp and eliminates static `192.168.1.2:3000`. | `tier1: Dynamic Health Probing` | `tier2: Offline Port & Network Timeouts` | `tier3: Sidebar State + Server Telemetry` | `tier4: Scenario 1` |
| **F-16** | Extension Sidebar State & Buttons | Responds to webview `init` message with live auth/sync state. Supports "Preview Sync" dry-run action. | `tier1: Webview State Handshake` | `tier2: Malformed Webview Messages` | `tier3: Preview Sync + Three-Way Plan` | `tier4: Scenario 3` |
| **F-17** | Web UI Elimination of Dummy Content | Replaces mock Drive Sync status with real `.quanta/sync-manifest.json` file inspection. | `tier1: Real Manifest Sync Inspection` | `tier2: Missing or Corrupt .quanta Manifest`| `tier3: Web Client State + Manifest Sync` | `tier4: Scenario 3` |
| **F-18** | Web Client Connection Status & Dot | Dynamic connection status dot toggles (`status-dot-green`, `status-dot-amber`, `status-dot-red`) based on WebSocket lifecycle. | `tier1: Connection State Dot Toggling` | `tier2: Rapid Reconnection Cycles` | `tier3: Offline Queue + WS Lifecycle` | `tier4: Scenario 5` |
| **F-19** | Web Client Badges & Counter Sync | Synchronizes both `desktopApprovalsBadge` and mobile `approvalsBadge` to pending approvals count. | `tier1: Desktop & Mobile Badge Sync` | `tier2: Zero Approvals & Large Counts` | `tier3: Approval Inbox + Badge Counter` | `tier4: Scenario 4` |
| **F-20** | Interactive User Avatar & Session Menu | Avatar badge triggers interactive dropdown showing session mode (`read-only` vs `control`), fingerprint, and Logout action. | `tier1: Session Avatar & Mode Dropdown` | `tier2: Session Expiration During Interaction` | `tier3: Session Elevation + Avatar Mode` | `tier4: Scenario 1` |
| **F-21** | Inspector Connection Dynamic Label | Inspector dynamically displays "LAN" or "Tunnel (<provider>)" based on session metadata. | `tier1: Dynamic Connection Labeling` | `tier2: Unknown Provider Fallback` | `tier3: Tunnel Supervisor + Label State` | `tier4: Scenario 1` |
| **F-22** | Web Speech Voice Input Integration | Web Speech API dictation supporting Indian and US locales (`en-IN`, `hi-IN`, `en-US`). | `tier1: Voice Input Engine & Locales` | `tier2: Unsupported Audio & Speech Errors` | `tier3: Voice Dictation + Prompt Queue` | `tier4: Scenario 5` |
| **F-23** | Login 2FA TOTP Input Field | RFC 6238 TOTP verification with Base32 secret. Requires 6-digit numeric code when `ENABLE_TOTP=true`. | `tier1: RFC 6238 TOTP Authentication` | `tier2: Invalid TOTP Codes & Clock Drift` | `tier3: TOTP Engine + Session Manager` | `tier4: Scenario 1` |
| **F-24** | Service Worker & Asset Route Fix | Valid Web App Manifest (`manifest.webmanifest`), offline service worker cache (`sw.js`), and accessible app icon assets. | `tier1: PWA Manifest & Asset Caching` | `tier2: Missing Icons & Cache Invalidation` | `tier3: Service Worker + Offline Queue` | `tier4: Scenario 5` |
| **F-25** | Automated Regression & Integration Pass | 100% pass across all unit, integration, and E2E test suites with zero failures. | `tier1: Core Regression Baseline` | `tier2: Edge Regression Invariants` | `tier3: Integration Regressions` | `tier4: Full Scenarios Pass` |

---

## 3. Test Architecture & Directory Layout

### 3.1 Directory Layout
```
d:\quanta-ide\
├── tests/
│   └── e2e/
│       ├── harness.mjs                        # Opaque-box contract fixtures & protocol models
│       ├── runner.mjs                         # Standalone Node.js test runner & summary reporter
│       ├── tier1-feature-coverage.test.mjs    # Tier 1: Category-partition feature tests (F-01..F-25)
│       ├── tier2-boundary-corner.test.mjs     # Tier 2: Boundary value analysis & stress limits
│       ├── tier3-cross-feature.test.mjs       # Tier 3: Pairwise cross-feature interactions
│       └── tier4-application-scenarios.test.mjs # Tier 4: Multi-step realistic developer workflows
├── TEST_INFRA.md                              # This specification document
└── TEST_READY.md                              # Test suite publication report & verification log
```

### 3.2 Invocation & Runner Semantics
- **Command**: `node tests/e2e/runner.mjs`
- **Runner Behavior**:
  - Automatically loads and executes all 4 tiers in sequential order.
  - Pipes real-time test progress using Node's native test reporter.
  - Formats an executive summary banner upon completion with:
    - Suite counts & test counts
    - Passed / Failed / Skipped totals
    - Overall execution duration
  - **Exit Code 0**: 100% of executed tests passed cleanly.
  - **Exit Code 1**: Any test failure or unhandled rejection occurred.

---

## 4. Coverage Thresholds & Quality Gates

The test suite enforces the following quantitative and qualitative coverage thresholds:

1. **Tier 1 (Feature Coverage / Category-Partition)**:
   - ≥ 5 test cases per core feature / functional group.
   - Target: ≥ 50 comprehensive tests covering all equivalence classes for OAuth, Drive Sync, Ignore Rules, Rate Limiting, Password Auth, Risk Classification, Approvals, Checkpoints, Telemetry, and PWA UI controls.
2. **Tier 2 (Boundary & Corner Conditions / BVA)**:
   - ≥ 5 test cases per boundary dimension.
   - Target: ≥ 45 rigorous stress tests covering empty inputs, max sizes, port collisions, zero/negative timeouts, unescaped characters, single quotes, network timeouts, and invalid JSON.
3. **Tier 3 (Cross-Feature Interactions / Pairwise)**:
   - Orthogonal feature pairs tested in combination.
   - Target: ≥ 25 interaction tests covering auth + rate limiting, risk classifier + approvals, sync + ignore engine, session elevation + file browser, checkpoints + task queue, telemetry + eventBus, TOTP + session manager, quick actions + risk classifier, and selective sync + snapshots.
4. **Tier 4 (Real-World Application Scenarios)**:
   - 5 multi-step, stateful, realistic developer workflows.
   - Target: Complete end-to-end operational scenarios validating user journeys from start to finish.

---

## 5. Real-World Application Scenarios (Tier 4)

### Scenario 1: Initial Developer Onboarding & Device Pairing
- **Persona**: Mobile developer connecting to workstation for the first time.
- **Workflow Steps**:
  1. Admin requests pairing ticket via server API. Server generates 120s ephemeral single-use ticket.
  2. Mobile client submits pairing ticket and validates master password + RFC 6238 TOTP 2FA.
  3. Server signs `ag_auth_token` cookie; WebSocket connection established.
  4. Client receives `/app-state` showing `read-only` session mode (zero-trust external client).
  5. User submits elevation password via `/api/elevate`.
  6. Server promotes session to `control` mode, unlocking state-changing APIs.
  7. Telemetry loop broadcasts live CPU, RAM, and real disk metrics.

### Scenario 2: Remote Emergency Code Fix Workflow
- **Persona**: Developer troubleshooting a production issue remotely from phone.
- **Workflow Steps**:
  1. Developer authenticates with elevated permissions.
  2. Navigates directory tree within jailed file browser (attempt to escape workspace via `../../` is blocked).
  3. Reads `src/index.ts` along with current SHA-256 base hash.
  4. Submits patch payload with matching base hash; file safely written.
  5. A second concurrent edit with stale base hash is rejected with conflict error.
  6. Shadow git checkpoint created before and after edits under `.quanta/checkpoints/`.
  7. Developer dispatches `run-tests` quick action; command validated against safe allowlist and executes within 30s timeout.

### Scenario 3: Multi-File Workspace Sync with Conflicts
- **Persona**: Quanta-PC-Extension syncing local workspace with Google Drive.
- **Workflow Steps**:
  1. Workspace contains local modifications, remote modifications, concurrent edits on same file, binary PNG asset, and `.env` secret.
  2. Ignore matcher strips `.env` completely from sync plan.
  3. Binary PNG read as raw Buffer and verified for MIME type `image/png`.
  4. Three-way sync engine calculates action plan: `upload`, `download`, `conflict`.
  5. Conflict policy `keepLocal` preserves local edits; `keepRemote` replaces with remote copy.
  6. Mass-delete threshold (>20 files or >30%) prompts modal confirmation; deletions execute safe trashing (`trashed: true`).
  7. Base manifest updated in `.quanta/sync-manifest.json`.

### Scenario 4: Bulk Command Approval & Background Task Orchestration
- **Persona**: AI agent proposing multiple automated actions during refactoring.
- **Workflow Steps**:
  1. Agent enqueues 6 commands: 2 safe (`git status`, `npm test`), 2 caution (`npm run build`, `git checkout`), and 2 dangerous (`rm -rf dist`, `git push --force`).
  2. Shell risk classifier decomposes compound commands and detects dangerous operations.
  3. Rule engine auto-approves safe commands, queues caution commands, and diverts dangerous commands to Approval Inbox.
  4. Approval manager fingerprints requests via `sha256(action|cmd|dir)`; duplicate submissions deduplicated.
  5. Mobile developer approves `rm -rf dist` and rejects `git push --force`.
  6. Approved command executes in Priority Task Queue with idempotency key guard; rejected command is discarded.

### Scenario 5: Offline Resilience & Reconnection Synchronization
- **Persona**: Mobile user moving between network zones with intermittent connectivity.
- **Workflow Steps**:
  1. WebSocket connection drops unexpectedly; status dot turns from green to red.
  2. User enters speech dictation prompt; offline queue buffers prompt in IndexedDB simulation.
  3. Network restores after 90 seconds (< 5 minute staleness limit); status dot turns amber then green.
  4. Offline queue flushes buffered prompts to server sequentially.
  5. A stale prompt older than 5 minutes prompts for confirmation before execution.
