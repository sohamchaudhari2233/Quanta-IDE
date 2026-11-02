import { createRequire } from 'module';
import type * as vscodeTypes from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';

// Safe runtime resolution for VS Code API (present in VS Code extension host, fallback for test suite)
let vscode: any;
try {
  const req = typeof require !== 'undefined' ? require : createRequire(path.resolve('package.json'));
  vscode = req('vscode');
} catch {
  vscode = {
    workspace: {
      workspaceFolders: undefined,
      createFileSystemWatcher: () => ({
        onDidChange: () => ({ dispose: () => {} }),
        onDidCreate: () => ({ dispose: () => {} }),
        onDidDelete: () => ({ dispose: () => {} }),
        dispose: () => {}
      })
    },
    commands: {
      executeCommand: async () => {}
    },
    Uri: {
      joinPath: (base: any, ...segments: string[]) => ({
        fsPath: path.join(base?.fsPath || '', ...segments),
        scheme: base?.scheme || 'file',
        path: path.join(base?.path || '', ...segments)
      })
    }
  };
}

export interface HealthCheckResponse {
  online: boolean;
  statusText: string;
  accessUrl: string;
  cdpConnected?: boolean;
  uptime?: number;
  https?: boolean;
  error?: string;
}

export interface WorkspaceSyncState {
  lastSyncFormatted: string;
  lastSyncTimestamp: number;
  fileCount: number;
  workspaceName: string;
  hasManifest: boolean;
}

/**
 * Discovers the preferred host LAN IPv4 address for remote mobile/PWA access.
 * Mirrors the logic from Remote-Control/server.js.
 */
export function getPreferredLanIp(): string {
  try {
    const interfaces = os.networkInterfaces();
    const candidates: { address: string; priority: number }[] = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const addr = iface.address;
          const priority = addr.startsWith('192.168.') ? 1
            : addr.startsWith('10.') ? 2
            : addr.startsWith('172.') ? 3 : 4;
          candidates.push({ address: addr, priority });
        }
      }
    }

    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

/**
 * Pings the Remote-Control server health endpoint on port 3000 (HTTPS with self-signed cert, fallback HTTP).
 */
export async function checkServerHealth(port: number = 3000, timeoutMs: number = 2000): Promise<HealthCheckResponse> {
  const lanIp = getPreferredLanIp();

  // 1. Try HTTPS first (Remote-Control default with self-signed cert)
  const httpsResult = await new Promise<HealthCheckResponse | null>((resolve) => {
    try {
      const req = https.get(
        `https://127.0.0.1:${port}/health`,
        {
          rejectUnauthorized: false, // Permit local self-signed certificates
          timeout: timeoutMs
        },
        (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const data = JSON.parse(body);
                const cdpText = data.cdpConnected ? 'CDP Linked' : 'CDP Idle';
                return resolve({
                  online: true,
                  statusText: `Running · HTTPS (Port ${port}) · ${cdpText}`,
                  accessUrl: `https://${lanIp}:${port}`,
                  cdpConnected: !!data.cdpConnected,
                  uptime: data.uptime,
                  https: true
                });
              }
            } catch {}
            resolve(null);
          });
        }
      );

      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });

  if (httpsResult) return httpsResult;

  // 2. Fallback to HTTP (if SSL is disabled or in development mode)
  const httpResult = await new Promise<HealthCheckResponse | null>((resolve) => {
    try {
      const req = http.get(
        `http://127.0.0.1:${port}/health`,
        { timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const data = JSON.parse(body);
                const cdpText = data.cdpConnected ? 'CDP Linked' : 'CDP Idle';
                return resolve({
                  online: true,
                  statusText: `Running · HTTP (Port ${port}) · ${cdpText}`,
                  accessUrl: `http://${lanIp}:${port}`,
                  cdpConnected: !!data.cdpConnected,
                  uptime: data.uptime,
                  https: false
                });
              }
            } catch {}
            resolve(null);
          });
        }
      );

      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });

  if (httpResult) return httpResult;

  // 3. Server offline
  return {
    online: false,
    statusText: `Stopped · Offline (Port ${port})`,
    accessUrl: `Unavailable (Start Remote Server)`,
    https: false,
    error: 'Connection refused or timed out'
  };
}

/**
 * Reads sync metadata from .quanta/sync-manifest.json in the current workspace root.
 */
export function readWorkspaceSyncState(workspaceRoot?: string): WorkspaceSyncState {
  const result: WorkspaceSyncState = {
    lastSyncFormatted: 'Never',
    lastSyncTimestamp: 0,
    fileCount: 0,
    workspaceName: '',
    hasManifest: false
  };

  if (!workspaceRoot) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      workspaceRoot = folders[0].uri.fsPath;
      result.workspaceName = folders[0].name;
    }
  }

  if (!workspaceRoot) return result;

  const manifestPath = path.join(workspaceRoot, '.quanta', 'sync-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);
      if (manifest) {
        result.hasManifest = true;
        result.workspaceName = manifest.workspaceName || result.workspaceName;
        result.lastSyncTimestamp = manifest.lastSyncTimestamp || 0;
        result.fileCount = manifest.files ? Object.keys(manifest.files).length : 0;

        if (result.lastSyncTimestamp > 0) {
          const d = new Date(result.lastSyncTimestamp);
          result.lastSyncFormatted = d.toLocaleString();
        }
      }
    }
  } catch (err) {
    console.warn('Could not read .quanta/sync-manifest.json:', err);
  }

  return result;
}

export class QuantaSidebarProvider implements vscodeTypes.WebviewViewProvider {
  public static readonly viewType = 'quanta-sidebar-view';

  private readonly _extensionUri: vscodeTypes.Uri;
  private readonly _context?: vscodeTypes.ExtensionContext;
  private _view?: vscodeTypes.WebviewView;
  private _manifestWatcher?: vscodeTypes.FileSystemWatcher;
  private _lastAuthStatus: boolean = false;
  private _lastServerOnline: boolean = false;

  constructor(
    extensionUri: vscodeTypes.Uri,
    context?: vscodeTypes.ExtensionContext
  ) {
    this._extensionUri = extensionUri;
    this._context = context;
  }

  public resolveWebviewView(
    webviewView: vscodeTypes.WebviewView,
    _context: vscodeTypes.WebviewViewResolveContext,
    _token: vscodeTypes.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Watch for .quanta/sync-manifest.json updates
    this._manifestWatcher = vscode.workspace.createFileSystemWatcher('**/.quanta/sync-manifest.json');
    this._manifestWatcher.onDidChange(() => this._refreshSyncState());
    this._manifestWatcher.onDidCreate(() => this._refreshSyncState());
    this._manifestWatcher.onDidDelete(() => this._refreshSyncState());

    webviewView.onDidDispose(() => {
      if (this._manifestWatcher) {
        this._manifestWatcher.dispose();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'init':
          await this._sendInitialState();
          break;
        case 'checkServerHealth':
          await this._checkAndPostServerHealth();
          break;
        case 'preview':
        case 'previewSync':
          vscode.commands.executeCommand('quanta.preview');
          break;
        case 'push':
          vscode.commands.executeCommand('quanta.push');
          break;
        case 'pull':
          vscode.commands.executeCommand('quanta.pull');
          break;
        case 'syncChats':
          vscode.commands.executeCommand('quanta.syncChats');
          break;
        case 'login':
          vscode.commands.executeCommand('quanta.login');
          break;
        case 'logout':
          vscode.commands.executeCommand('quanta.logout');
          break;
        case 'update':
          vscode.commands.executeCommand('quanta.updateExtension');
          break;
        case 'doctor':
          vscode.commands.executeCommand('quanta.doctor');
          break;
      }
    });
  }

  public updateAuthStatus(isConnected: boolean) {
    this._lastAuthStatus = isConnected;
    if (this._view) {
      this._view.webview.postMessage({ type: 'setAuthStatus', isConnected });
      this._updateCompositeBadge();
    }
  }

  public updateSyncStatus(lastSync: string, fileCount?: number) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'setSyncStatus', lastSync, fileCount });
    }
  }

  public async refreshSyncState() {
    this._refreshSyncState();
  }

  private _refreshSyncState() {
    if (!this._view) return;
    const syncState = readWorkspaceSyncState();
    this._view.webview.postMessage({
      type: 'setSyncStatus',
      lastSync: syncState.lastSyncFormatted,
      fileCount: syncState.fileCount
    });
  }

  private async _checkAndPostServerHealth() {
    if (!this._view) return;
    const health = await checkServerHealth(3000);
    this._lastServerOnline = health.online;
    this._view.webview.postMessage({
      type: 'setServerHealth',
      online: health.online,
      statusText: health.statusText,
      accessUrl: health.accessUrl,
      cdpConnected: health.cdpConnected
    });
    this._updateCompositeBadge();
  }

  private async _sendInitialState() {
    if (!this._view) return;

    // 1. Auth Status
    this._view.webview.postMessage({ type: 'setAuthStatus', isConnected: this._lastAuthStatus });

    // 2. Sync Manifest State
    this._refreshSyncState();

    // 3. Server Health Check
    await this._checkAndPostServerHealth();
  }

  private _updateCompositeBadge() {
    if (!this._view) return;

    let badgeText = 'ALL SYSTEMS NORMAL';
    let badgeClass: 'ok' | 'caution' | 'offline' = 'ok';

    if (this._lastAuthStatus && this._lastServerOnline) {
      badgeText = 'ALL SYSTEMS NORMAL';
      badgeClass = 'ok';
    } else if (this._lastAuthStatus && !this._lastServerOnline) {
      badgeText = 'SERVER OFFLINE';
      badgeClass = 'caution';
    } else if (!this._lastAuthStatus && this._lastServerOnline) {
      badgeText = 'DRIVE OFFLINE';
      badgeClass = 'caution';
    } else {
      badgeText = 'STANDBY';
      badgeClass = 'offline';
    }

    this._view.webview.postMessage({
      type: 'setCompositeStatus',
      text: badgeText,
      statusClass: badgeClass
    });
  }

  private _getHtmlForWebview(webview: vscodeTypes.Webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'));
    const nonce = crypto.randomBytes(16).toString('base64');

    let version = '1.0.0';
    try {
      const pkgPath = path.join(this._extensionUri.fsPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) version = pkg.version;
      }
    } catch {}

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quanta Control Panel</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <!-- 1. Header with Live Composite Health Badge -->
  <header class="sidebar-header">
    <div class="brand-title">Quanta</div>
    <div class="health-stamp" id="system-health-stamp">Checking...</div>
  </header>

  <!-- 2. Google Drive Account -->
  <div class="panel-section">
    <div class="section-header">
      <span class="section-title">Google Drive</span>
      <button class="text-action" id="disconnect-drive-btn" data-cmd="logout" style="display: none;">Disconnect</button>
    </div>
    <div class="ledger-list">
      <div class="ledger-row">
        <span class="ledger-key">Status</span>
        <span class="ledger-val" id="drive-status-val">Disconnected</span>
      </div>
    </div>
    <p id="drive-desc" style="font-size: 11.5px; color: var(--text-2); margin: 2px 0 6px;">Connect Google Drive to enable workspace synchronization.</p>
    <button class="primary" id="connect-drive-btn" data-cmd="login">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      Connect Google Drive
    </button>
  </div>

  <!-- 3. Workspace Sync with Preview Sync Button -->
  <div class="panel-section">
    <div class="section-header">
      <span class="section-title">Workspace Sync</span>
    </div>
    <div style="display: flex; gap: 6px; margin-bottom: 6px;">
      <button class="primary" data-cmd="push" title="Upload local workspace changes to Google Drive">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
        Push to Drive
      </button>
      <button class="secondary" data-cmd="pull" title="Download latest workspace changes from Google Drive">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Pull
      </button>
    </div>
    <button class="secondary" id="preview-sync-btn" data-cmd="previewSync" title="Preview workspace differences before syncing (dry-run)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      Preview Sync (Dry Run)
    </button>
    <div class="ledger-list" style="margin-top: 8px;">
      <div class="ledger-row">
        <span class="ledger-key">Last Sync</span>
        <span class="ledger-val" id="last-sync-val">Never</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-key">Tracked Files</span>
        <span class="ledger-val" id="sync-file-count-val">0 files</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-key">Policy</span>
        <span class="ledger-val">Three-Way Merge</span>
      </div>
    </div>
  </div>

  <!-- 4. Chat Transcripts -->
  <div class="panel-section">
    <div class="section-header">
      <span class="section-title">Chat Intelligence</span>
    </div>
    <button class="secondary" data-cmd="syncChats">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      Redact & Sync Chats
    </button>
  </div>

  <!-- 5. Remote Control with Live Telemetry & Check Health Action -->
  <div class="panel-section">
    <div class="section-header">
      <span class="section-title">Remote Control</span>
      <button class="text-action" id="refresh-server-btn" data-cmd="checkServerHealth" title="Ping port 3000 server health">Check Health</button>
    </div>
    <div class="ledger-list">
      <div class="ledger-row">
        <span class="ledger-key">Server</span>
        <span class="ledger-val" id="server-status-val">Checking port 3000...</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-key">Access</span>
        <span class="ledger-val" id="server-access-val">—</span>
      </div>
    </div>
  </div>

  <!-- 6. Diagnostics & Maintenance -->
  <div class="panel-section">
    <div class="section-header">
      <span class="section-title">Diagnostics & Maintenance</span>
    </div>
    <div style="display: flex; gap: 6px;">
      <button class="secondary" data-cmd="doctor">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
        Quanta Doctor
      </button>
      <button class="secondary" data-cmd="update">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
        Update
      </button>
    </div>
  </div>

  <!-- Footer with Dynamic Version -->
  <div class="version-footer">
    <span>Quanta IDE • v${version}</span>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
