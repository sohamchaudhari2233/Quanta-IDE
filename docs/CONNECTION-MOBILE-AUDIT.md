# Connection and mobile audit — 2 November 2026

Initial verification: Remote-Control 52/52 tests, extension 56/56 tests and TypeScript compilation, scenario suite 89/89. The scenario suite uses models in `tests/e2e/harness.mjs`; it does not demonstrate a live phone-to-IDE or Google Drive connection. Runtime npm audit: zero reported Remote-Control vulnerabilities.

## Issues found

| Priority | Issue | Remediation |
| --- | --- | --- |
| High | `?demo=1` accepts a caller-supplied localhost Host header as proof of local access | Require explicit opt-in, loopback socket and no forwarded headers |
| High | Startup force-kills arbitrary processes holding the configured port | Fail clearly on port conflict |
| High | Service worker caches arbitrary successful GET responses including session and chat state | Cache only an explicit static asset list; purge the previous cache |
| High | Composer clears drafts on rejected/failed sends | Preserve draft until delivery confirmation; explain uncertain delivery without automatic retry |
| Medium | Offline queue has a nonfunctional memory fallback and no composer integration | Store fallback records; explicitly queue offline sends and ask before dispatch after reconnect |
| Medium | WebSocket retries have no network/wake handling | Avoid duplicate sockets; reconnect on online/visibility changes |
| Medium | Setup treats commented variables as configured and misses example placeholders | Parse actual assignments and replace only missing/default values |
| Medium | Environment loading depends on current directory | Load the server-local env first and root env as fallback |
| Medium | TOTP auto-submit can race with form submit | Guard in-flight login attempts |
| Medium | Phone layout disables zoom, shrinks controls, clips short login screens and consumes bottom safe area | Restore zoom, increase touch targets, scroll login, fix safe area and viewport sizing |

## Verification limits

Live Antigravity CDP, Google OAuth consent, Drive upload/download and a physical phone over Wi-Fi/tunnel require those services/devices. Automated component tests alone do not establish those connections. Do not publish the CDP port; expose only the authenticated remote server. Existing credentials must stay out of logs and version control.

## Second pass: implemented and checked

- Protected legacy file uploads, chat selection and history mutation with control-mode checks. External logins retain the documented read-only default.
- Limited uploads to 10 MB, supported quoted multipart boundaries, retained binary bytes, corrected the missing path import, and placed uniquely named attachments in the active workspace's `.quanta/attachments` directory.
- Rate-limited elevation, required configured 2FA for elevation, handled malformed TOTP payloads, and enabled local-desktop approval/revocation of required device pairing.
- Rejected unrelated WebSocket origins, including other hosts on the same tunnel provider. Excluded unauthenticated/revoked sockets from broadcasts and disconnected expired sessions.
- Corrected private-network range matching and prevented direct clients from choosing rate-limit identities through forged forwarding headers.
- Wrapped all 24 asynchronous Express routes and installed JSON error handling. Failed async requests no longer escape the Express 4 error path.
- Restricted checkpoint requests to the active workspace; passed checkpoint Git arguments without a shell; released stale session controller locks.
- Prevented Drive sync reads/writes/deletions from following traversal paths or external directory links.
- Preserved newly typed drafts during offline storage commits; cleared the offline queue on logout; tolerated blocked preference storage; bounded client requests and CDP discovery; prevented stale WebSocket handlers changing the active connection state.
- Corrected mobile composer sizing and touch targets, removed invented telemetry fallback values, and stopped repeated CDP discovery from launching a PowerShell process every polling cycle.
- Replaced corrupted public PNG/ICO assets with valid icons derived from the Quanta header mark. Manifest dimensions now match decoded images, with a new service-worker cache version.
- Isolated `npm test` app data, device configuration and logs in a temporary directory.

Validation: **71 Remote-Control tests + 57 extension tests + 89 model/scenario tests = 217 passing tests**. The server suite includes a newly spawned real server with test credentials, exercising actual login, tunnel read-only mode, upload rejection, elevation lockout, WebSocket origins and logout. TypeScript compilation, the production Webpack extension build and `git diff --check` pass.

Diagnostics: 7 passes, 1 warning, 0 failures. The warning is real: Antigravity is not listening for CDP. The open IDE was not restarted. Physical-phone layout, browser interaction, Google OAuth consent and live Drive transfer remain unverified. Browser visual review was stopped by the computer-use URL policy check.

Some historical marketing images under `Remote-Control/assets` also contain irreversible UTF-8 binary corruption; the upstream original app-icon file has the same corruption. These historical illustrations need uncorrupted source artwork to restore. Public runtime icons have been replaced and tested.

## Run from the workspace root

```powershell
npm run setup
npm run doctor
npm start
```

When ready to restart Antigravity, launch it with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9000`. Keep debugging bound to loopback. The server reconnects when the IDE becomes available. Use `CDP_PORT` for a different debug port and `PORT` for a different phone-server port. `HOST` can restrict the HTTP listener, for example `127.0.0.1` for local-only testing.

`Remote-Control/.env` takes precedence over the root `.env`; explicit process environment variables take precedence over both. Setup preserves real credentials. Run `npm test`, `npm run check`, and `npm run test:scenarios` for verification. The extension production bundle is built with `npm --prefix Quanta-PC-Extension run package`; an existing installed extension does not update merely because this bundle was rebuilt.

## Research

- [MDN: service worker caching](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching) — informs static-only caching.
- [MDN: VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) — on-screen keyboards change the visible area independently of layout size.
- [Chrome: remote debugging security](https://developer.chrome.com/blog/remote-debugging-port) — explains the sensitivity of debugging access.
- [Express 4: error handling](https://expressjs.com/en/4x/guide/error-handling/) — async rejections need forwarding to Express.
- [ws: client authentication](https://github.com/websockets/ws#client-authentication) — documents authentication around WebSocket upgrades.
