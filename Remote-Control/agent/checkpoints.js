import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { eventBus } from '../core/eventBus.js';
import { auditLogger } from '../security/auditLogger.js';

export class CheckpointManager {
  constructor(options = {}) {
    this.maxCheckpoints = options.maxCheckpoints || 20;
  }

  getShadowGitDir(workspaceRoot = process.cwd()) {
    const root = (typeof workspaceRoot === 'string' && workspaceRoot) ? workspaceRoot : process.cwd();
    return path.join(root, '.quanta', 'checkpoints', '.git');
  }

  ensureShadowGit(workspaceRoot = process.cwd()) {
    const root = (typeof workspaceRoot === 'string' && workspaceRoot) ? workspaceRoot : process.cwd();
    const shadowDir = this.getShadowGitDir(root);
    if (!fs.existsSync(shadowDir)) {
      fs.mkdirSync(path.dirname(shadowDir), { recursive: true });
      execFileSync('git', ['init', '--bare', shadowDir], { encoding: 'utf8' });

      // Ensure author identity is configured locally in shadow repository
      try {
        execFileSync('git', [`--git-dir=${shadowDir}`, 'config', 'user.name', 'Quanta IDE'], { encoding: 'utf8' });
        execFileSync('git', [`--git-dir=${shadowDir}`, 'config', 'user.email', 'checkpoints@quanta.local'], { encoding: 'utf8' });
      } catch { }

      // Setup shadow exclude file mirroring .quantaignore
      const excludeFile = path.join(shadowDir, 'info', 'exclude');
      const excludeRules = `
.env*
!.env.example
client_secret*.json
!.client_secret.example.json
*.key
*.pem
*.cert
node_modules/
.git/
.quanta/
dist/
out/
build/
`;
      fs.writeFileSync(excludeFile, excludeRules, 'utf8');
    }
  }

  runShadowGit(workspaceRoot = process.cwd(), args) {
    const root = (typeof workspaceRoot === 'string' && workspaceRoot) ? workspaceRoot : process.cwd();
    this.ensureShadowGit(root);
    const shadowDir = this.getShadowGitDir(root);
    if (!Array.isArray(args)) throw new Error('Git arguments must be an array');
    return execFileSync('git', [`--git-dir=${shadowDir}`, `--work-tree=${root}`, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000
    });
  }

  createCheckpoint(workspaceRoot = process.cwd(), label = 'Pre-task Snapshot') {
    const root = (typeof workspaceRoot === 'string' && workspaceRoot) ? workspaceRoot : process.cwd();
    try {
      this.ensureShadowGit(root);
      this.runShadowGit(root, ['add', '-A']);

      const timestamp = new Date().toISOString();
      const safeLabel = String(label || 'Pre-task Snapshot').replace(/"/g, "'");
      const commitMsg = `Checkpoint: ${safeLabel} [${timestamp}]`;

      // Check if there are changes to commit
      try {
        this.runShadowGit(root, ['commit', '-m', commitMsg]);
        const commitHash = this.runShadowGit(root, ['rev-parse', '--short', 'HEAD']).trim();

        const checkpoint = {
          id: commitHash,
          label: safeLabel,
          timestamp: Date.now(),
          isoTime: timestamp
        };

        eventBus.publish('checkpoint.created', checkpoint);
        auditLogger.log({
          type: 'CHECKPOINT_CREATED',
          summary: `Created shadow checkpoint: ${safeLabel} (${commitHash})`
        });

        return checkpoint;
      } catch (err) {
        // If nothing to commit, return latest commit hash
        const latest = this.runShadowGit(root, ['rev-parse', '--short', 'HEAD']).trim();
        return { id: latest, label: `${safeLabel} (unchanged)`, timestamp: Date.now() };
      }
    } catch (err) {
      console.warn('Failed to create shadow git checkpoint:', err.message);
      return null;
    }
  }

  listCheckpoints(workspaceRoot = process.cwd(), limit = 20) {
    let root = workspaceRoot;
    let lim = limit;
    if (typeof workspaceRoot === 'number') {
      lim = workspaceRoot;
      root = process.cwd();
    } else if (!root || typeof root !== 'string') {
      root = process.cwd();
    }
    const safeLimit = Math.max(1, parseInt(lim, 10) || 20);

    try {
      this.ensureShadowGit(root);
      const log = this.runShadowGit(root, ['log', '-n', String(safeLimit), '--pretty=format:%h|%s|%ct']);
      if (!log.trim()) return [];

      return log
        .trim()
        .split('\n')
        .map(line => {
          const [id, label, timeSec] = line.split('|');
          return {
            id,
            label,
            timestamp: parseInt(timeSec, 10) * 1000
          };
        });
    } catch {
      return [];
    }
  }

  getDiff(workspaceRoot = process.cwd(), checkpointId) {
    const root = (typeof workspaceRoot === 'string' && workspaceRoot) ? workspaceRoot : process.cwd();
    if (!checkpointId || !/^[a-zA-Z0-9._~^-]+$/.test(checkpointId)) {
      return 'Diff unavailable: Invalid checkpoint ID';
    }
    try {
      this.ensureShadowGit(root);
      return this.runShadowGit(root, ['diff', checkpointId, '--']);
    } catch (err) {
      return `Diff unavailable: ${err.message}`;
    }
  }

  rollback(workspaceRoot = process.cwd(), checkpointId, options = {}) {
    let root = workspaceRoot;
    let id = checkpointId;
    let opts = options;

    // Polymorphic signature: handle rollback(checkpointId, options) gracefully
    if (typeof checkpointId === 'object' || typeof checkpointId === 'undefined') {
      opts = typeof checkpointId === 'object' ? checkpointId : {};
      id = workspaceRoot;
      root = process.cwd();
    }

    if (!id || typeof id !== 'string') {
      throw new Error('Rollback failed: checkpointId is required');
    }

    // Checkpoint ID injection guard
    if (!/^[a-zA-Z0-9._~^-]+$/.test(id)) {
      throw new Error('Rollback failed: Invalid checkpointId format');
    }

    try {
      // Automatic safety checkpoint of current state before rollback
      this.createCheckpoint(root, `Pre-Rollback Safety Backup before reverting to ${id}`);

      // Restore working tree from the specified checkpoint
      this.runShadowGit(root, ['checkout', id, '--', '.']);

      auditLogger.log({
        type: 'CHECKPOINT_ROLLBACK',
        deviceId: opts.user || opts.deviceId || 'mobile',
        summary: `Rolled back workspace to shadow checkpoint: ${id}`
      });

      return { success: true, checkpointId: id };
    } catch (err) {
      throw new Error(`Rollback failed: ${err.message}`);
    }
  }
}

export const checkpointManager = new CheckpointManager();

