import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { redactSensitiveText } from './redaction';
import { encryptTranscript, decryptTranscript } from './encryption';

/**
 * Locate active Antigravity brain directories using multi-path probing.
 */
export function getBrainDirectories(workspacePath?: string): string[] {
  const candidates: string[] = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain')
  ];

  if (workspacePath) {
    candidates.push(path.join(workspacePath, '.gemini', 'brain'));
    candidates.push(path.join(workspacePath, '.brain'));
  }

  return candidates.filter(dir => fs.existsSync(dir));
}

export async function extractAndFormatChats(workspacePath: string): Promise<string | null> {
  try {
    const brainDirs = getBrainDirectories(workspacePath);
    if (brainDirs.length === 0) {
      console.warn('No Antigravity brain directory located.');
      return null;
    }

    // Collect recent conversations from all found brain directories
    const allFolders: { name: string; path: string; mtime: number }[] = [];
    for (const brainDir of brainDirs) {
      try {
        const folders = fs.readdirSync(brainDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => ({
            name: dirent.name,
            path: path.join(brainDir, dirent.name),
            mtime: fs.statSync(path.join(brainDir, dirent.name)).mtimeMs
          }));
        allFolders.push(...folders);
      } catch (e) {
        console.warn(`Failed to scan brain dir ${brainDir}:`, e);
      }
    }

    allFolders.sort((a, b) => b.mtime - a.mtime);
    const topFolders = allFolders.slice(0, 25);

    let targetTranscriptPath: string | null = null;
    const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/');
    const backslashWorkspacePath = workspacePath.replace(/\//g, '\\');
    const workspaceBase = path.basename(workspacePath);

    for (const folder of topFolders) {
      const transcriptPath = path.join(folder.path, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcriptPath)) {
        try {
          const fd = fs.openSync(transcriptPath, 'r');
          const buffer = Buffer.alloc(120000);
          const bytesRead = fs.readSync(fd, buffer, 0, 120000, 0);
          fs.closeSync(fd);

          const content = buffer.toString('utf8', 0, bytesRead);
          if (
            content.includes(normalizedWorkspacePath) ||
            content.includes(backslashWorkspacePath) ||
            content.includes(workspaceBase)
          ) {
            targetTranscriptPath = transcriptPath;
            break;
          }
        } catch {}
      }
    }

    if (!targetTranscriptPath) {
      // Fallback: pick the latest transcript if any exists
      for (const folder of topFolders) {
        const fallback = path.join(folder.path, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(fallback)) {
          targetTranscriptPath = fallback;
          break;
        }
      }
    }

    if (!targetTranscriptPath) return null;

    const fileContent = fs.readFileSync(targetTranscriptPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
    const formattedChats = [];

    for (const line of lines) {
      try {
        const step = JSON.parse(line);
        if (step.type === 'USER_INPUT' && step.content) {
          let text = step.content;
          const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match && match[1]) {
            text = match[1].trim();
          }

          formattedChats.push({
            role: 'user',
            timestamp: step.created_at || new Date().toISOString(),
            parts: [{ text: redactSensitiveText(text) }]
          });
        } else if (step.type === 'PLANNER_RESPONSE' && (step.content || step.thinking)) {
          const parts: { text: string }[] = [];
          if (step.thinking) {
            parts.push({ text: `*Thinking:*\n${redactSensitiveText(step.thinking)}` });
          }
          if (step.content) {
            parts.push({ text: redactSensitiveText(step.content) });
          }

          formattedChats.push({
            role: 'model',
            timestamp: step.created_at || new Date().toISOString(),
            parts
          });
        }
      } catch {}
    }

    if (formattedChats.length === 0) return null;

    const jsonString = JSON.stringify(formattedChats, null, 2);

    // Check optional client-side encryption
    const config = vscode.workspace.getConfiguration('quanta');
    const encryptionEnabled = config.get<boolean>('encryption.enabled', false);

    if (encryptionEnabled) {
      const passphrase = await vscode.window.showInputBox({
        prompt: 'Enter passphrase for chat encryption',
        password: true,
        ignoreFocusOut: true
      });
      if (passphrase) {
        return encryptTranscript(jsonString, passphrase);
      }
    }

    return jsonString;
  } catch (error) {
    console.error('Error extracting chats:', error);
    return null;
  }
}

/**
 * Export conversation to human-readable Markdown format.
 */
export function exportChatToMarkdown(formattedChatsJson: string): string {
  try {
    const chats = JSON.parse(formattedChatsJson);
    if (!Array.isArray(chats)) return '# Invalid Conversation Format';

    let md = `# Quanta IDE - Conversation Export\n*Exported on ${new Date().toLocaleString()}*\n\n---\n\n`;

    for (const msg of chats) {
      const isUser = msg.role === 'user';
      const header = isUser ? `### User` : `### Assistant`;
      const time = msg.timestamp ? ` *(${msg.timestamp})*` : '';
      md += `${header}${time}\n\n`;

      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          md += `${p.text}\n\n`;
        }
      }
      md += `---\n\n`;
    }
    return md;
  } catch (e) {
    return `# Failed to Export Conversation: ${e}`;
  }
}
