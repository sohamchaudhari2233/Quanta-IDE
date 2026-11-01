import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function extractAndFormatChats(workspacePath: string): Promise<string | null> {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
    
    if (!fs.existsSync(brainDir)) {
      return null;
    }

    const folders = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => ({
        name: dirent.name,
        path: path.join(brainDir, dirent.name),
        mtime: fs.statSync(path.join(brainDir, dirent.name)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime) // Most recent first
      .slice(0, 20); // Only check top 20 recent conversations

    let targetTranscriptPath = null;
    const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/');
    const backslashWorkspacePath = workspacePath.replace(/\//g, '\\');

    for (const folder of folders) {
      const transcriptPath = path.join(folder.path, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcriptPath)) {
        // Read the first chunk of the file to see if it belongs to this workspace
        const fd = fs.openSync(transcriptPath, 'r');
        const buffer = Buffer.alloc(100000); // Read first 100kb
        const bytesRead = fs.readSync(fd, buffer, 0, 100000, 0);
        fs.closeSync(fd);
        
        const content = buffer.toString('utf8', 0, bytesRead);
        if (content.includes(normalizedWorkspacePath) || content.includes(backslashWorkspacePath) || content.includes(path.basename(workspacePath))) {
          targetTranscriptPath = transcriptPath;
          break;
        }
      }
    }

    if (!targetTranscriptPath) {
      return null;
    }

    // Now parse the chosen transcript
    const fileContent = fs.readFileSync(targetTranscriptPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
    
    const formattedChats = [];
    
    for (const line of lines) {
      try {
        const step = JSON.parse(line);
        if (step.type === 'USER_INPUT' && step.content) {
          // Extract text from <USER_REQUEST> if present
          let text = step.content;
          const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match && match[1]) {
            text = match[1].trim();
          }
          
          formattedChats.push({
            role: 'user',
            parts: [{ text: text }]
          });
        } else if (step.type === 'PLANNER_RESPONSE' && step.content) {
          formattedChats.push({
            role: 'model',
            parts: [{ text: step.content }]
          });
        }
      } catch (e) {
        // Ignore parse errors on individual lines
      }
    }

    if (formattedChats.length === 0) return null;
    
    return JSON.stringify(formattedChats, null, 2);
  } catch (error) {
    console.error('Error extracting chats:', error);
    return null;
  }
}
