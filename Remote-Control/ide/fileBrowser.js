import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { auditLogger } from '../security/auditLogger.js';

const BLOCKED_PATTERNS = [
  /^\.env/i,
  /client_secret/i,
  /\.(pem|key|cert|crt)$/i,
  /id_rsa/i,
  /\.git/i,
  /^api[ _-]?keys?/i,
  /^devices\.json$/i
];

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

export class FileBrowser {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  setWorkspaceRoot(root) {
    this.workspaceRoot = path.resolve(root);
  }

  resolveSafePath(relativePath = '') {
    const resolved = path.resolve(this.workspaceRoot, relativePath);

    const isOutside = (root, target) => {
      const relative = path.relative(root, target);
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };
    if (isOutside(this.workspaceRoot, resolved)) {
      throw new Error('Path traversal rejected: Attempt to access outside workspace root');
    }

    const segments = path.relative(this.workspaceRoot, resolved).split(path.sep);
    if (segments.some(segment => BLOCKED_PATTERNS.some(pattern => pattern.test(segment)))) {
      throw new Error('Access denied: Sensitive file pattern blocked');
    }

    // Check the real existing ancestor too, including when creating a new file
    // beneath a directory junction or symlink.
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Workspace path does not exist');
      ancestor = parent;
    }
    const realRoot = fs.realpathSync(this.workspaceRoot);
    if (isOutside(realRoot, fs.realpathSync(ancestor))) {
      throw new Error('Path traversal rejected: Symlink leaves workspace root');
    }

    return resolved;
  }

  listDirectory(relativeDir = '') {
    const safeDir = this.resolveSafePath(relativeDir);
    if (!fs.existsSync(safeDir)) throw new Error('Directory does not exist');

    const entries = fs.readdirSync(safeDir, { withFileTypes: true });
    const results = [];

    for (const ent of entries) {
      const isBlocked = BLOCKED_PATTERNS.some(p => p.test(ent.name));
      if (isBlocked) continue;
      if (ent.isSymbolicLink()) continue;

      const fullPath = path.join(safeDir, ent.name);
      const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

      results.push({
        name: ent.name,
        path: relPath,
        isDirectory: ent.isDirectory(),
        size: ent.isFile() ? fs.statSync(fullPath).size : 0
      });
    }

    return results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  readFile(relativePath) {
    const safePath = this.resolveSafePath(relativePath);
    if (!fs.existsSync(safePath)) throw new Error('File not found');

    const stat = fs.statSync(safePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File exceeds maximum readable size (${(MAX_FILE_SIZE / 1024).toFixed(0)} KB)`);
    }

    const buf = fs.readFileSync(safePath);

    // Simple binary check: look for null bytes
    const isBinary = buf.slice(0, 1024).includes(0);
    if (isBinary) {
      return { isBinary: true, content: '[Binary content cannot be viewed on mobile]' };
    }

    const content = buf.toString('utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    return {
      isBinary: false,
      content,
      hash,
      size: stat.size
    };
  }

  writeFile(relativePath, newContent, expectedHash = null, deviceId = 'unknown') {
    if (typeof relativePath !== 'string' || !relativePath || typeof newContent !== 'string') throw new Error('A file path and text content are required');
    if (Buffer.byteLength(newContent, 'utf8') > MAX_FILE_SIZE) throw new Error('File exceeds maximum writable size (500 KB)');
    const safePath = this.resolveSafePath(relativePath);

    // Optimistic Concurrency check
    if (expectedHash && !fs.existsSync(safePath)) throw new Error('Conflict: File was deleted on desktop. Please refresh and review.');
    if (expectedHash && fs.existsSync(safePath)) {
      const currentBuf = fs.readFileSync(safePath, 'utf8');
      const currentHash = crypto.createHash('sha256').update(currentBuf).digest('hex');
      if (currentHash !== expectedHash) {
        throw new Error('Conflict: File was modified on desktop since you opened it. Please refresh and review.');
      }
    }

    // Safety backup before overwriting
    if (fs.existsSync(safePath)) {
      const backupDir = this.resolveSafePath('.quanta/backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${path.basename(safePath)}.${Date.now()}.bak`);
      fs.copyFileSync(safePath, backupPath);
    }

    fs.writeFileSync(safePath, newContent, 'utf8');

    auditLogger.log({
      type: 'MOBILE_FILE_EDIT',
      deviceId,
      summary: `Edited file from mobile: ${relativePath}`,
      details: { size: newContent.length }
    });

    const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
    return { success: true, hash: newHash };
  }
}

export const fileBrowser = new FileBrowser();
