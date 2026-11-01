import * as vscode from 'vscode';

export class QuantaSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'quanta-sidebar-view';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
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
      }
    });
  }

  public updateAuthStatus(isConnected: boolean) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'setAuthStatus', isConnected });
    }
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quanta Panel</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 15px 10px;
      background-color: var(--vscode-sideBar-background);
    }
    .panel-section {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 18px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
      margin-top: 0;
      margin-bottom: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button {
      width: 100%;
      padding: 10px;
      margin-bottom: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s ease;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.success {
      background: #10B981;
      color: #ffffff;
      pointer-events: none;
    }
    .info-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 14px;
      line-height: 1.4;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #EF4444;
      display: inline-block;
    }
    .status-dot.connected {
      background-color: #10B981;
    }
  </style>
</head>
<body>
  
  <div class="panel-section">
    <h3 class="section-title"><span class="status-dot" id="auth-dot"></span> Drive Connection</h3>
    <p class="info-text" id="auth-desc">Connect to Google Drive to sync your Quanta IDE workspace.</p>
    <button id="auth-btn" onclick="sendCommand('login')">🔑 Connect Google Drive</button>
  </div>

  <div class="panel-section">
    <h3 class="section-title">☁️ Workspace Sync</h3>
    <button onclick="sendCommand('pull')">↓ Pull from Drive</button>
    <button onclick="sendCommand('push')">↑ Push to Drive</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    function sendCommand(type) {
      vscode.postMessage({ type });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'setAuthStatus') {
        const btn = document.getElementById('auth-btn');
        const dot = document.getElementById('auth-dot');
        const desc = document.getElementById('auth-desc');
        if (message.isConnected) {
          btn.className = 'success';
          btn.innerHTML = '✅ Connected';
          dot.className = 'status-dot connected';
          desc.innerHTML = 'Securely linked to your Google Drive account.';
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
