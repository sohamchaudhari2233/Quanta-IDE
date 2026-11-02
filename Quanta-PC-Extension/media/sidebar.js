// Quanta IDE Sidebar Webview Controller (Zero-Inline-Script, Strict CSP Compliant)
(function() {
  const vscode = acquireVsCodeApi();

  // Attach command dispatchers to all buttons with data-cmd attribute
  document.querySelectorAll('button[data-cmd]').forEach(button => {
    button.addEventListener('click', () => {
      const type = button.getAttribute('data-cmd');
      if (type) {
        vscode.postMessage({ type });
      }
    });
  });

  // Listen for state messages from the extension host
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;

    if (message.type === 'setAuthStatus') {
      const driveStatus = document.getElementById('drive-status-val');
      const connectBtn = document.getElementById('connect-drive-btn');
      const disconnectBtn = document.getElementById('disconnect-drive-btn');
      const driveDesc = document.getElementById('drive-desc');

      if (message.isConnected) {
        if (driveStatus) {
          driveStatus.textContent = 'Connected (Google Drive)';
          driveStatus.style.color = 'var(--ok)';
        }
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
        if (driveDesc) driveDesc.textContent = 'Account authenticated via OAuth PKCE.';
      } else {
        if (driveStatus) {
          driveStatus.textContent = 'Disconnected';
          driveStatus.style.color = 'var(--text-2)';
        }
        if (connectBtn) connectBtn.style.display = 'flex';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
        if (driveDesc) driveDesc.textContent = 'Connect Google Drive to enable workspace synchronization.';
      }
    } else if (message.type === 'setSyncStatus') {
      const lastSyncVal = document.getElementById('last-sync-val');
      if (lastSyncVal && message.lastSync) {
        lastSyncVal.textContent = message.lastSync;
      }
      const syncFileCountVal = document.getElementById('sync-file-count-val');
      if (syncFileCountVal && message.fileCount !== undefined) {
        syncFileCountVal.textContent = `${message.fileCount} file${message.fileCount === 1 ? '' : 's'}`;
      }
    } else if (message.type === 'setServerHealth') {
      const serverStatusVal = document.getElementById('server-status-val');
      const serverAccessVal = document.getElementById('server-access-val');

      if (serverStatusVal) {
        serverStatusVal.textContent = message.statusText || (message.online ? 'Running' : 'Offline');
        serverStatusVal.style.color = message.online ? 'var(--ok)' : 'var(--signal)';
      }
      if (serverAccessVal) {
        serverAccessVal.textContent = message.accessUrl || '—';
      }
    } else if (message.type === 'setCompositeStatus') {
      const healthStamp = document.getElementById('system-health-stamp');
      if (healthStamp && message.text) {
        healthStamp.textContent = message.text;
        healthStamp.className = `health-stamp ${message.statusClass || 'ok'}`;
      }
    }
  });

  // Request initial state hydration on webview load
  vscode.postMessage({ type: 'init' });
})();
