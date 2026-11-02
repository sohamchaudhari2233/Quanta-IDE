import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';

export interface UpdateCheckResult {
  updated: boolean;
  source: 'workspace' | 'github' | 'local_vsix' | 'none';
  detail: string;
}

/**
 * Automatically checks for updates, compiles local changes if in development workspace,
 * pulls from git if available, or downloads latest release from GitHub, then hot-updates
 * the Antigravity IDE extension files and prompts the user to reload the window.
 */
export async function updateExtension(context: vscode.ExtensionContext): Promise<UpdateCheckResult> {
  return await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Quanta: Checking for updates...',
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: 'Scanning workspace and environment...' });

      const userHome = process.env.USERPROFILE || process.env.HOME || '';
      const targetDirs = [
        path.join(userHome, '.antigravity-ide', 'extensions', 'quanta-ide.quanta-pc-extension-0.1.0'),
        path.join(userHome, '.antigravity', 'extensions', 'quanta-ide.quanta-pc-extension-0.1.0')
      ];

      let workspaceRoot = '';
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }

      // Check if we are running inside the Quanta monorepo workspace
      const isQuantaWorkspace = workspaceRoot && (
        fs.existsSync(path.join(workspaceRoot, 'Quanta-PC-Extension')) ||
        (fs.existsSync(path.join(workspaceRoot, 'package.json')) && fs.existsSync(path.join(workspaceRoot, 'src', 'extension.ts')))
      );

      let updated = false;
      let updateSource: 'workspace' | 'github' | 'local_vsix' | 'none' = 'none';
      let updateDetail = '';

      if (isQuantaWorkspace) {
        progress.report({ message: 'Found local workspace. Checking git updates...' });

        // 1. Check if git can pull latest commits
        const gitDir = path.join(workspaceRoot, '.git');
        if (fs.existsSync(gitDir)) {
          try {
            await new Promise<void>((resolve) => {
              exec('git pull --ff-only', { cwd: workspaceRoot, timeout: 15000 }, (err, stdout) => {
                if (!err && stdout && !stdout.includes('Already up to date')) {
                  console.log('Git pull output:', stdout);
                }
                resolve();
              });
            });
          } catch {
            // Ignore git pull issues
          }
        }

        // 2. Identify extension directory and compile production package
        const extensionDir = fs.existsSync(path.join(workspaceRoot, 'Quanta-PC-Extension'))
          ? path.join(workspaceRoot, 'Quanta-PC-Extension')
          : workspaceRoot;

        const distFile = path.join(extensionDir, 'dist', 'extension.js');
        const pkgFile = path.join(extensionDir, 'package.json');

        progress.report({ message: 'Compiling latest extension bundle...' });
        await new Promise<void>((resolve) => {
          exec('npm run package', { cwd: extensionDir, timeout: 35000 }, (err) => {
            if (err) {
              console.warn('npm run package notice:', err.message);
            }
            resolve();
          });
        });

        // 3. Hot-update Antigravity extensions directory
        if (fs.existsSync(distFile) && fs.existsSync(pkgFile)) {
          progress.report({ message: 'Synchronizing update into Antigravity IDE...' });

          for (const targetDir of targetDirs) {
            try {
              if (fs.existsSync(targetDir)) {
                const targetDist = path.join(targetDir, 'dist');
                if (!fs.existsSync(targetDist)) fs.mkdirSync(targetDist, { recursive: true });

                fs.copyFileSync(distFile, path.join(targetDist, 'extension.js'));
                const mapFile = distFile + '.map';
                if (fs.existsSync(mapFile)) {
                  fs.copyFileSync(mapFile, path.join(targetDist, 'extension.js.map'));
                }
                fs.copyFileSync(pkgFile, path.join(targetDir, 'package.json'));
                updated = true;
              }
            } catch (copyErr) {
              console.warn('Could not copy to targetDir:', targetDir, copyErr);
            }
          }

          // Also install local VSIX if present
          const vsixPath = path.join(workspaceRoot, 'quanta-pc-extension.vsix');
          if (fs.existsSync(vsixPath)) {
            try {
              await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
            } catch {
              // Best effort
            }
          }

          updateSource = 'workspace';
          updateDetail = 'Built and synchronized latest workspace features directly into Antigravity.';
        }
      }

      // If not updated via workspace, check GitHub releases
      if (!updated) {
        progress.report({ message: 'Checking GitHub for releases...' });
        try {
          const response = await fetch('https://api.github.com/repos/dark-yoddha/Quanta-IDE/releases/latest', {
            headers: { 'User-Agent': 'Quanta-IDE-Extension' }
          });
          if (response.ok) {
            const data: any = await response.json();
            const assets: any[] = data.assets || [];
            const vsixAsset = assets.find((a: any) => a.name && a.name.endsWith('.vsix'));
            if (vsixAsset && vsixAsset.browser_download_url) {
              progress.report({ message: `Downloading ${vsixAsset.name}...` });
              const tmpVsix = path.join(os.tmpdir(), vsixAsset.name);
              const downloadRes = await fetch(vsixAsset.browser_download_url);
              const buffer = await downloadRes.arrayBuffer();
              fs.writeFileSync(tmpVsix, Buffer.from(buffer));

              progress.report({ message: 'Installing downloaded release...' });
              await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tmpVsix));
              updated = true;
              updateSource = 'github';
              updateDetail = `Downloaded and installed release ${data.tag_name || ''} from GitHub.`;
            }
          }
        } catch (netErr) {
          console.warn('GitHub update check exception:', netErr);
        }
      }

      // Fallback: check if local vsix in workspace exists
      if (!updated && workspaceRoot) {
        const vsixPath = path.join(workspaceRoot, 'quanta-pc-extension.vsix');
        if (fs.existsSync(vsixPath)) {
          progress.report({ message: 'Reinstalling workspace VSIX package...' });
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
          updated = true;
          updateSource = 'local_vsix';
          updateDetail = 'Reinstalled latest local quanta-pc-extension.vsix.';
        }
      }

      if (updated) {
        const action = await vscode.window.showInformationMessage(
          `Quanta Extension updated! (${updateDetail}) Reload window to apply changes?`,
          'Reload Window',
          'Later'
        );
        if (action === 'Reload Window') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        vscode.window.showInformationMessage('Quanta Extension is already running the latest version.');
      }

      return { updated, source: updateSource, detail: updateDetail };
    } catch (err: any) {
      vscode.window.showErrorMessage(`Update failed: ${err.message}`);
      return { updated: false, source: 'none', detail: err.message };
    }
  });
}

