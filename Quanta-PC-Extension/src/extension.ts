import * as vscode from 'vscode';
import { resolveWorkspacePath } from './safePath';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { authenticate, initAuth, disconnect, getCredentials } from './auth';
import { extractAndFormatChats } from './chatParser';
import {
  setupWorkspaceFolder,
  listDriveFilesRecursive,
  readDriveFile,
  writeDriveFile,
  getChatsFolder,
  trashDriveFile,
  findOrCreateFolder
} from './gdrive';
import { QuantaSidebarProvider } from './sidebar';
import { loadWorkspaceIgnore } from './ignoreRules';
import { loadManifest, saveManifest, computeThreeWayPlan, SyncPlanItem } from './manifest';
import { verifyDeletionSafety } from './safeDelete';
import { updateExtension } from './updater';

let statusBarItem: vscode.StatusBarItem;
let autoSyncDebounceTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('Quanta PC Extension is now active!');
  initAuth(context);

  const sidebarProvider = new QuantaSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QuantaSidebarProvider.viewType, sidebarProvider)
  );

  // Status Bar Integration
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'quanta.preview';
  statusBarItem.text = '$(cloud) Quanta: Ready';
  statusBarItem.tooltip = 'Click to preview Quanta Drive Sync';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Helper function to update status bar
  function setStatus(text: string, tooltip: string = '') {
    statusBarItem.text = text;
    if (tooltip) statusBarItem.tooltip = tooltip;
  }

  // 1. Login Command
  const loginDisposable = vscode.commands.registerCommand('quanta.login', async () => {
    const token = await authenticate();
    if (token) {
      sidebarProvider.updateAuthStatus(true);
      setStatus('$(cloud) Quanta: Connected', 'Google Drive connected');
      vscode.window.showInformationMessage('Successfully connected to Google Drive!');
    }
  });
  context.subscriptions.push(loginDisposable);

  // 2. Logout / Disconnect Command
  const logoutDisposable = vscode.commands.registerCommand('quanta.logout', async () => {
    await disconnect();
    sidebarProvider.updateAuthStatus(false);
    setStatus('$(cloud) Quanta: Disconnected', 'Disconnected from Google Drive');
    vscode.window.showInformationMessage('Disconnected from Google Drive.');
  });
  context.subscriptions.push(logoutDisposable);

  // Core Sync Engine: Scan, Plan & Conflict Resolution
  async function prepareSyncPlan(token: string, progress?: vscode.Progress<{ message?: string; increment?: number }>) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No active workspace open.');
      return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const projectName = workspaceFolders[0].name;

    if (progress) progress.report({ message: 'Applying .quantaignore rules...' });
    const ignoreMatcher = loadWorkspaceIgnore(rootPath);
    const manifest = loadManifest(rootPath, projectName);

    if (progress) progress.report({ message: 'Scanning local files...' });
    const localUris = await vscode.workspace.findFiles('**/*');
    const localFiles = new Map<string, string>(); // relPath -> md5

    for (const uri of localUris) {
      const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      if (ignoreMatcher.isIgnored(relPath, false)) continue;

      try {
        const fileData = await vscode.workspace.fs.readFile(uri);
        const md5 = crypto.createHash('md5').update(fileData).digest('hex');
        localFiles.set(relPath, md5);
      } catch (e) {
        console.warn(`Could not read local file ${relPath}:`, e);
      }
    }

    if (progress) progress.report({ message: 'Connecting to Google Drive...' });
    const targetFolderId = await setupWorkspaceFolder(token, projectName);
    const driveList = await listDriveFilesRecursive(token, targetFolderId);

    const remoteFiles = new Map<string, { id: string; md5: string; modifiedTime?: string }>();
    const remoteFolders = new Map<string, string>(); // path -> id

    for (const item of driveList) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        remoteFolders.set(item.name, item.id);
      } else {
        if (!ignoreMatcher.isIgnored(item.name, false)) {
          remoteFiles.set(item.name, {
            id: item.id,
            md5: item.md5Checksum || '',
            modifiedTime: item.modifiedTime
          });
        }
      }
    }

    const plan = computeThreeWayPlan(localFiles, remoteFiles, manifest);
    return {
      rootPath,
      projectName,
      targetFolderId,
      manifest,
      localFiles,
      remoteFiles,
      remoteFolders,
      plan,
      ignoreMatcher
    };
  }

  // 3. Preview Command
  const previewDisposable = vscode.commands.registerCommand('quanta.preview', async () => {
    const token = await authenticate();
    if (!token) return;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Quanta: Analyzing Workspace Differences...',
      cancellable: false
    }, async (progress) => {
      const context = await prepareSyncPlan(token, progress);
      if (!context) return;

      const uploads = context.plan.filter(i => i.type === 'upload');
      const downloads = context.plan.filter(i => i.type === 'download');
      const conflicts = context.plan.filter(i => i.type === 'conflict');
      const remoteDeletes = context.plan.filter(i => i.type === 'deleteRemote');
      const localDeletes = context.plan.filter(i => i.type === 'deleteLocal');

      const summary = `Quanta Sync Preview for [${context.projectName}]:\n` +
        `• Uploads: ${uploads.length}\n` +
        `• Downloads: ${downloads.length}\n` +
        `• Conflicts: ${conflicts.length}\n` +
        `• Remote Deletions: ${remoteDeletes.length}\n` +
        `• Local Deletions: ${localDeletes.length}`;

      const choice = await vscode.window.showInformationMessage(summary, 'Push Changes', 'Pull Changes', 'Close');
      if (choice === 'Push Changes') vscode.commands.executeCommand('quanta.push');
      if (choice === 'Pull Changes') vscode.commands.executeCommand('quanta.pull');
    });
  });
  context.subscriptions.push(previewDisposable);

  // 4. Push Command
  const pushDisposable = vscode.commands.registerCommand('quanta.push', async (dryRun = false) => {
    const token = await authenticate();
    if (!token) return;
    sidebarProvider.updateAuthStatus(true);
    setStatus('$(sync~spin) Quanta: Pushing...');

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Quanta: Pushing to Google Drive...',
      cancellable: false
    }, async (progress) => {
      try {
        const syncContext = await prepareSyncPlan(token, progress);
        if (!syncContext) return;

        const { rootPath, targetFolderId, manifest, remoteFolders, plan } = syncContext;

        const conflicts = plan.filter(p => p.type === 'conflict');
        let effectivePolicy = 'ask';
        if (conflicts.length > 0) {
          const config = vscode.workspace.getConfiguration('quanta');
          effectivePolicy = config.get<string>('conflictPolicy', 'ask');

          if (effectivePolicy === 'ask') {
            const conflictNames = conflicts.map(c => c.path).slice(0, 3).join(', ');
            const choice = await vscode.window.showWarningMessage(
              `Detected ${conflicts.length} conflict(s) (${conflictNames}): Both local and remote versions changed!`,
              'Overwrite Remote (Keep Local)',
              'Download Remote (Keep Remote)',
              'Keep Both (Upload Copy)',
              'Abort Push'
            );
            if (choice === 'Overwrite Remote (Keep Local)') {
              effectivePolicy = 'keepLocal';
            } else if (choice === 'Download Remote (Keep Remote)') {
              effectivePolicy = 'keepRemote';
            } else if (choice === 'Keep Both (Upload Copy)') {
              effectivePolicy = 'keepBoth';
            } else {
              vscode.window.showInformationMessage('Push aborted due to unresolved conflicts.');
              setStatus('$(cloud) Quanta: Conflict');
              return;
            }
          }
        }

        // Mass deletion safety check
        const deleteItems = plan.filter(p => p.type === 'deleteRemote');
        if (deleteItems.length > 0) {
          const isSafe = await verifyDeletionSafety(deleteItems.length, syncContext.remoteFiles.size, deleteItems.map(d => d.path));
          if (!isSafe) {
            vscode.window.showWarningMessage('Push cancelled: mass-deletion aborted by user.');
            setStatus('$(cloud) Quanta: Aborted');
            return;
          }
        }

        // Apply conflict policy to build uploads list and handle remote preservation
        let uploads: SyncPlanItem[] = plan.filter(p => p.type === 'upload');

        if (conflicts.length > 0) {
          if (effectivePolicy === 'keepLocal') {
            // Overwrite remote with local version
            uploads.push(...conflicts);
          } else if (effectivePolicy === 'keepRemote') {
            // Skip upload and download remote version to local workspace
            for (const item of conflicts) {
              if (item.remoteId) {
                try {
                  const content = await readDriveFile(token, item.remoteId);
                  const localFilePath = resolveWorkspacePath(rootPath, item.path);
                  const dir = path.dirname(localFilePath);
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                  fs.writeFileSync(localFilePath, content);
                  const localMd5 = crypto.createHash('md5').update(content).digest('hex');

                  manifest.files[item.path] = {
                    path: item.path,
                    localMd5,
                    remoteMd5: item.remoteMd5 || '',
                    remoteId: item.remoteId,
                    lastSyncedAt: Date.now()
                  };
                  progress.report({ message: `Kept remote version: ${item.path}` });
                } catch (err) {
                  console.error(`Failed to download remote conflict file ${item.path}:`, err);
                }
              }
            }
          } else if (effectivePolicy === 'keepBoth') {
            // Preserve remote file, upload local copy with timestamped suffix
            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

            for (const item of conflicts) {
              const ext = path.extname(item.path);
              const base = path.basename(item.path, ext);
              const dir = path.dirname(item.path);
              const conflictFileName = `${base}.conflict-${timestamp}${ext}`;
              const conflictRelPath = dir === '.' ? conflictFileName : `${dir}/${conflictFileName}`.replace(/\\/g, '/');

              const srcPath = resolveWorkspacePath(rootPath, item.path);
              const destPath = resolveWorkspacePath(rootPath, conflictRelPath);
              try {
                if (fs.existsSync(srcPath)) {
                  fs.copyFileSync(srcPath, destPath);
                }
              } catch (e) {
                console.warn(`Could not duplicate local file for keepBoth: ${conflictRelPath}`, e);
              }

              uploads.push({
                type: 'upload',
                path: conflictRelPath,
                localMd5: item.localMd5
              });
            }
          }
        }

        const config = vscode.workspace.getConfiguration('quanta');
        const concurrency = config.get<number>('syncConcurrency', 10);

        let completed = 0;
        const total = uploads.length + deleteItems.length;

        // Ensure folders exist
        const dirSet = new Set<string>();
        for (const item of uploads) {
          const parts = item.path.split('/');
          let cur = '';
          for (let i = 0; i < parts.length - 1; i++) {
            cur += parts[i] + '/';
            dirSet.add(cur);
          }
        }

        const sortedDirs = Array.from(dirSet).sort((a, b) => a.split('/').length - b.split('/').length);
        for (const dirPath of sortedDirs) {
          if (!remoteFolders.has(dirPath)) {
            const parts = dirPath.slice(0, -1).split('/');
            const folderName = parts.pop()!;
            let parentId = targetFolderId;
            if (parts.length > 0) {
              const parentPath = parts.join('/') + '/';
              if (remoteFolders.has(parentPath)) {
                parentId = remoteFolders.get(parentPath)!;
              }
            }
            const folderId = await findOrCreateFolder(token, folderName, parentId);
            remoteFolders.set(dirPath, folderId);
          }
        }

        // Chunked uploads
        for (let i = 0; i < uploads.length; i += concurrency) {
          const chunk = uploads.slice(i, i + concurrency);
          await Promise.all(chunk.map(async (item) => {
            try {
              const localUri = vscode.Uri.file(resolveWorkspacePath(rootPath, item.path));
              const fileData = await vscode.workspace.fs.readFile(localUri);

              const parts = item.path.split('/');
              const fileName = parts.pop()!;
              let parentId = targetFolderId;
              if (parts.length > 0) {
                const parentPath = parts.join('/') + '/';
                parentId = remoteFolders.get(parentPath) || targetFolderId;
              }

              const result: any = await writeDriveFile(token, fileName, fileData, item.remoteId || null, parentId);
              completed++;
              progress.report({ increment: (1 / (total || 1)) * 100, message: `Uploaded ${item.path}` });

              manifest.files[item.path] = {
                path: item.path,
                localMd5: item.localMd5 || crypto.createHash('md5').update(fileData).digest('hex'),
                remoteMd5: result.md5Checksum || '',
                remoteId: result.id,
                lastSyncedAt: Date.now()
              };
            } catch (err) {
              console.error(`Failed to upload ${item.path}:`, err);
            }
          }));
        }

        // Execute safe deletions
        for (const item of deleteItems) {
          if (item.remoteId) {
            try {
              await trashDriveFile(token, item.remoteId);
              delete manifest.files[item.path];
              completed++;
              progress.report({ increment: (1 / (total || 1)) * 100, message: `Moved to trash: ${item.path}` });
            } catch (err) {
              console.error(`Failed to trash remote file ${item.path}:`, err);
            }
          }
        }

        saveManifest(rootPath, manifest);
        setStatus('$(cloud) Quanta: In Sync', 'Workspace is synchronized with Google Drive');
        vscode.window.showInformationMessage(`Quanta: Successfully pushed ${uploads.length} files to Google Drive!`);
      } catch (err: any) {
        setStatus('$(alert) Quanta: Error', err.message);
        vscode.window.showErrorMessage(`Push failed: ${err.message}`);
      }
    });
  });
  context.subscriptions.push(pushDisposable);

  // 5. Pull Command
  const pullDisposable = vscode.commands.registerCommand('quanta.pull', async () => {
    const token = await authenticate();
    if (!token) return;
    sidebarProvider.updateAuthStatus(true);
    setStatus('$(sync~spin) Quanta: Pulling...');

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Quanta: Pulling from Google Drive...',
      cancellable: false
    }, async (progress) => {
      try {
        const syncContext = await prepareSyncPlan(token, progress);
        if (!syncContext) return;

        const { rootPath, manifest, plan } = syncContext;
        const downloads = plan.filter(p => p.type === 'download' || p.type === 'conflict');
        const localDeletes = plan.filter(p => p.type === 'deleteLocal');

        // Check local deletion safety guard
        if (localDeletes.length > 0) {
          const totalKnown = Object.keys(manifest.files).length || 1;
          const isSafe = await verifyDeletionSafety(localDeletes.length, totalKnown, localDeletes.map(d => d.path));
          if (!isSafe) {
            vscode.window.showWarningMessage('Pull cancelled: local deletions aborted by user.');
            setStatus('$(cloud) Quanta: Aborted');
            return;
          }
        }

        let completed = 0;
        let deleted = 0;
        const totalOps = downloads.length + localDeletes.length;

        for (const item of downloads) {
          if (item.remoteId) {
            try {
              const content = await readDriveFile(token, item.remoteId);
              const localFilePath = resolveWorkspacePath(rootPath, item.path);
              const dir = path.dirname(localFilePath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

              fs.writeFileSync(localFilePath, content);
              const localMd5 = crypto.createHash('md5').update(content).digest('hex');

              manifest.files[item.path] = {
                path: item.path,
                localMd5,
                remoteMd5: item.remoteMd5 || '',
                remoteId: item.remoteId,
                lastSyncedAt: Date.now()
              };

              completed++;
              progress.report({ increment: (1 / (totalOps || 1)) * 100, message: `Downloaded ${item.path}` });
            } catch (err) {
              console.error(`Failed to download ${item.path}:`, err);
            }
          }
        }

        // Process remote deletions on local disk
        for (const item of localDeletes) {
          try {
            const localFilePath = resolveWorkspacePath(rootPath, item.path);
            if (fs.existsSync(localFilePath)) {
              try {
                await vscode.workspace.fs.delete(vscode.Uri.file(localFilePath), { useTrash: true });
              } catch {
                fs.unlinkSync(localFilePath);
              }
            }
            delete manifest.files[item.path];
            deleted++;
            progress.report({ increment: (1 / (totalOps || 1)) * 100, message: `Deleted local ${item.path}` });
          } catch (err) {
            console.error(`Failed to delete local file ${item.path}:`, err);
          }
        }

        saveManifest(rootPath, manifest);
        setStatus('$(cloud) Quanta: In Sync', 'Workspace is synchronized with Google Drive');
        vscode.window.showInformationMessage(`Quanta: Pull completed! ${completed} downloaded, ${deleted} removed locally.`);
      } catch (err: any) {
        setStatus('$(alert) Quanta: Error', err.message);
        vscode.window.showErrorMessage(`Pull failed: ${err.message}`);
      }
    });
  });
  context.subscriptions.push(pullDisposable);

  // 6. Sync Chats Command (with redaction & optional encryption)
  const syncChatsDisposable = vscode.commands.registerCommand('quanta.syncChats', async () => {
    const token = await authenticate();
    if (!token) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const rootPath = workspaceFolders[0].uri.fsPath;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Quanta: Syncing & Redacting Antigravity Chats...',
      cancellable: false
    }, async () => {
      const formattedJson = await extractAndFormatChats(rootPath);
      if (!formattedJson) {
        vscode.window.showWarningMessage('No active Antigravity conversations found to sync.');
        return;
      }

      // Save sanitized local copy
      const localChatPath = path.join(rootPath, 'antigravity_chats.json');
      fs.writeFileSync(localChatPath, formattedJson, 'utf8');

      // Upload to Google Drive under Quanta/Chats
      const chatsFolderId = await getChatsFolder(token);
      const fileName = `${workspaceFolders[0].name}_chats.json`;
      await writeDriveFile(token, fileName, formattedJson, null, chatsFolderId);

      vscode.window.showInformationMessage('Quanta: Antigravity chats redacted and synced to Google Drive!');
    });
  });
  context.subscriptions.push(syncChatsDisposable);

  // 7. Quanta Doctor Command
  const doctorDisposable = vscode.commands.registerCommand('quanta.doctor', async () => {
    const checks: string[] = [];

    // Check Node version
    checks.push(`[PASS] Node Runtime: ${process.version}`);

    // Check credentials
    const creds = getCredentials();
    checks.push(creds.clientId ? `[PASS] OAuth Client ID Configured (${creds.clientId.slice(0, 12)}...)` : `[WARN] OAuth Client ID Missing`);

    // Check brain directory
    const brainDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'brain');
    checks.push(fs.existsSync(brainDir) ? `[PASS] Antigravity Brain Directory Detected` : `[WARN] Antigravity Brain Directory Not Found`);

    // Check workspace
    const ws = vscode.workspace.workspaceFolders;
    checks.push(ws ? `[PASS] Active Workspace: ${ws[0].name}` : `[WARN] No Workspace Open`);

    vscode.window.showInformationMessage(`Quanta Doctor Results:\n${checks.join('\n')}`, { modal: true });
  });
  context.subscriptions.push(doctorDisposable);

  // 8. Update Extension Command (In-Extension Auto Updater)
  const updateDisposable = vscode.commands.registerCommand('quanta.updateExtension', async () => {
    await updateExtension(context);
  });
  context.subscriptions.push(updateDisposable);

  // Auto-Sync Watcher
  vscode.workspace.onDidSaveTextDocument((doc) => {
    const config = vscode.workspace.getConfiguration('quanta');
    const mode = config.get<string>('autoSync', 'off');
    if (mode === 'onSave') {
      if (autoSyncDebounceTimer) clearTimeout(autoSyncDebounceTimer);
      autoSyncDebounceTimer = setTimeout(() => {
        vscode.commands.executeCommand('quanta.push');
      }, 3000);
    }
  });
}

export function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
  if (autoSyncDebounceTimer) clearTimeout(autoSyncDebounceTimer);
}
