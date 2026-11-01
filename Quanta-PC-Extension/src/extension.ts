import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { authenticate } from './auth';
import { extractAndFormatChats } from './chatParser';
import { setupWorkspaceFolder, listDriveFilesRecursive, readDriveFile, writeDriveFile, getChatsFolder, deleteDriveFile, ensurePathInDrive, findOrCreateFolder } from './gdrive';
import { QuantaSidebarProvider } from './sidebar';

export function activate(context: vscode.ExtensionContext) {
  console.log('Quanta PC Extension is now active!');

  const sidebarProvider = new QuantaSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QuantaSidebarProvider.viewType, sidebarProvider)
  );

  let loginDisposable = vscode.commands.registerCommand('quanta.login', async () => {
    const token = await authenticate();
    if (token) {
      sidebarProvider.updateAuthStatus(true);
      vscode.window.showInformationMessage('Successfully connected to Google Drive!');
    }
  });

  let pushDisposable = vscode.commands.registerCommand('quanta.push', async () => {
    const token = await authenticate();
    if (!token) return;
    sidebarProvider.updateAuthStatus(true);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace open');
      return;
    }

    const projectName = workspaceFolders[0].name;
    const rootPath = workspaceFolders[0].uri.fsPath;

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Pushing ${projectName} to Google Drive...`,
      cancellable: false
    }, async (progress) => {
      try {
        const targetFolderId = await setupWorkspaceFolder(token, projectName);
        const driveFiles = await listDriveFilesRecursive(token, targetFolderId);
        const driveMap = new Map(driveFiles.map((f: any) => [f.name, f]));

        // Read all local files, skipping node_modules, .git, chats, etc.
        const localUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,antigravity_chats.json}');
        const relativePaths = localUris.map(uri => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'));

        // 1. Gather all unique directory paths
        const dirSet = new Set<string>();
        for (const relPath of relativePaths) {
          const parts = relPath.split('/');
          let current = '';
          for (let i = 0; i < parts.length - 1; i++) {
            current += parts[i] + '/';
            dirSet.add(current);
          }
        }

        // 2. Sort directories by depth (shallowest first) to ensure parents are created before children
        const sortedDirs = Array.from(dirSet).sort((a, b) => a.split('/').length - b.split('/').length);

        // 3. Sequentially pre-create/find directories to prevent duplicate folder race conditions
        for (const dirPath of sortedDirs) {
          if (!driveMap.has(dirPath)) {
            const parts = dirPath.slice(0, -1).split('/');
            const folderName = parts.pop()!;
            let parentId = targetFolderId;
            if (parts.length > 0) {
              const parentPath = parts.join('/') + '/';
              if (driveMap.has(parentPath)) {
                parentId = driveMap.get(parentPath).id;
              }
            }
            const folderId = await findOrCreateFolder(token, folderName, parentId);
            driveMap.set(dirPath, { id: folderId, name: dirPath });
          }
        }

        // Helper for concurrency
        const chunkArray = (arr: any[], size: number) => 
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const fileItems = localUris.map((uri, index) => ({ uri, relativePath: relativePaths[index] }));
        const chunks = chunkArray(fileItems, 10);
        let completed = 0;

        for (const chunk of chunks) {
          await Promise.all(chunk.map(async (item: any) => {
            const { uri, relativePath } = item;
            
            const fileData = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(fileData);
            
            const remoteFile = driveMap.has(relativePath) ? driveMap.get(relativePath) : null;
            
            // Check MD5 checksum
            if (remoteFile && remoteFile.md5Checksum) {
              const localMd5 = crypto.createHash('md5').update(fileData).digest('hex');
              if (localMd5 === remoteFile.md5Checksum) {
                completed++;
                progress.report({ increment: (100 / localUris.length) * 0.9, message: `Skipped ${relativePath} (no changes)` });
                return;
              }
            }
            
            const fileId = remoteFile ? remoteFile.id : null;
            
            // Get folder ID from cached driveMap
            const folderParts = relativePath.split('/');
            let folderId = targetFolderId;
            if (folderParts.length > 1) {
              const folderPath = folderParts.slice(0, -1).join('/') + '/';
              if (driveMap.has(folderPath)) {
                folderId = driveMap.get(folderPath).id;
              }
            }

            const fileName = folderParts.pop() || relativePath;
            await writeDriveFile(token, fileName, content, fileId, folderId);
            
            completed++;
            progress.report({ increment: (100 / localUris.length) * 0.9, message: `Uploaded ${completed}/${localUris.length}` });
          }));
        }

        // Delete orphans from Google Drive
        progress.report({ increment: 0, message: `Checking for deleted files...` });
        const localPathSet = new Set(relativePaths);
        
        // Find deleted folders
        const localFolderSet = new Set(sortedDirs);
        for (const [remotePath, remoteItem] of driveMap.entries()) {
          if (remoteItem.mimeType === 'application/vnd.google-apps.folder') {
            if (!localFolderSet.has(remotePath)) {
              try {
                await deleteDriveFile(token, remoteItem.id);
              } catch(e) {
                console.error(`Failed to delete remote folder ${remotePath}`, e);
              }
            }
          } else {
            // Find deleted files
            if (!localPathSet.has(remotePath) && remotePath.includes('.')) {
              try {
                await deleteDriveFile(token, remoteItem.id);
              } catch(e) {
                console.error(`Failed to delete remote file ${remotePath}`, e);
              }
            }
          }
        }
        // Auto-sync Antigravity Chats
        try {
          progress.report({ increment: 0, message: `Syncing Antigravity Chats...` });
          const chatFileUri = vscode.Uri.joinPath(vscode.Uri.file(rootPath), 'antigravity_chats.json');
          try {
            const chatData = await vscode.workspace.fs.readFile(chatFileUri);
            const chatsJson = new TextDecoder().decode(chatData);
            if (chatsJson) {
              const chatsFolderId = await getChatsFolder(token);
              const chatFiles = await listDriveFilesRecursive(token, chatsFolderId);
              const chatFile = chatFiles.find((f: any) => f.name === `${projectName}_chats.json`);
              await writeDriveFile(token, `${projectName}_chats.json`, chatsJson, chatFile ? chatFile.id : null, chatsFolderId);
            }
          } catch(e) {
            console.log("No local antigravity_chats.json found to sync.");
          }
        } catch (chatErr) {
          console.error("Failed to auto-sync chats:", chatErr);
        }

        vscode.window.showInformationMessage('Push complete!');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Push failed: ${e.message}`);
      }
    });
  });

  let pullDisposable = vscode.commands.registerCommand('quanta.pull', async () => {
    const token = await authenticate();
    if (!token) return;
    sidebarProvider.updateAuthStatus(true);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace open');
      return;
    }

    const projectName = workspaceFolders[0].name;

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Pulling ${projectName} from Google Drive...`,
      cancellable: false
    }, async (progress) => {
      try {
        const targetFolderId = await setupWorkspaceFolder(token, projectName);
        const driveFiles = await listDriveFilesRecursive(token, targetFolderId);

        const chunkArray = (arr: any[], size: number) => 
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const filesToDownload = driveFiles.filter((f: any) => f.mimeType !== 'application/vnd.google-apps.folder' && (f.mimeType === 'text/plain' || f.name.includes('.')));
        const chunks = chunkArray(filesToDownload, 10);
        let completed = 0;

        for (const chunk of chunks) {
          await Promise.all(chunk.map(async (f: any) => {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, f.name);
            
            // Check MD5 checksum if file exists locally
            try {
              const fileData = await vscode.workspace.fs.readFile(fileUri);
              if (f.md5Checksum) {
                const localMd5 = crypto.createHash('md5').update(fileData).digest('hex');
                if (localMd5 === f.md5Checksum) {
                  completed++;
                  progress.report({ increment: 100 / filesToDownload.length, message: `Skipped ${f.name} (no changes)` });
                  return;
                }
              }
            } catch (e) {
              // File doesn't exist locally, proceed to download
            }
            
            const content = await readDriveFile(token, f.id);
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
            
            completed++;
            progress.report({ increment: 100 / filesToDownload.length, message: `Downloaded ${completed}/${filesToDownload.length}` });
          }));
        }
        vscode.window.showInformationMessage('Pull complete!');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
      }
    });
  });

  let syncChatsDisposable = vscode.commands.registerCommand('quanta.syncChats', async () => {
    const token = await authenticate();
    if (!token) return;
    sidebarProvider.updateAuthStatus(true);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace open');
      return;
    }

    const projectName = workspaceFolders[0].name;

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Syncing Chats for ${projectName}...`,
      cancellable: false
    }, async () => {
      try {
        const chatsFolderId = await getChatsFolder(token);
        const chatFiles = await listDriveFilesRecursive(token, chatsFolderId);
        const chatFile = chatFiles.find((f: any) => f.name === `${projectName}_chats.json`);
        
        if (chatFile) {
          const chatContent = await readDriveFile(token, chatFile.id);
          const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'antigravity_chats.json');
          await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(chatContent));
          
          vscode.workspace.openTextDocument(fileUri).then(doc => {
            vscode.window.showTextDocument(doc);
          });
          vscode.window.showInformationMessage('Chats synced and opened!');
        } else {
          vscode.window.showInformationMessage('No chats found for this project on Drive.');
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Chat sync failed: ${e.message}`);
      }
    });
  });

  context.subscriptions.push(loginDisposable, pushDisposable, pullDisposable, syncChatsDisposable);
}

export function deactivate() {}
