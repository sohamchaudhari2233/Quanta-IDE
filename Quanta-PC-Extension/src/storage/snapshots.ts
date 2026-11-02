import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

export interface WorkspaceSnapshot {
  id: string;
  timestamp: number;
  isoTime: string;
  machineName: string;
  label?: string;
  files: Record<string, { hash: string; size: number }>;
  gitContext?: { branch: string; commit: string; isDirty: boolean };
}

export class SnapshotManager {
  private getSnapshotsDir(workspaceRoot: string) {
    return path.join(workspaceRoot, '.quanta', 'snapshots');
  }

  private getBlobsDir(workspaceRoot: string) {
    return path.join(workspaceRoot, '.quanta', 'blobs');
  }

  private ensureDirs(workspaceRoot: string) {
    const sDir = this.getSnapshotsDir(workspaceRoot);
    const bDir = this.getBlobsDir(workspaceRoot);
    if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });
    if (!fs.existsSync(bDir)) fs.mkdirSync(bDir, { recursive: true });
  }

  /**
   * Save a content-addressed blob. Returns its SHA-256 hash.
   */
  saveBlob(workspaceRoot: string, content: Buffer | string): string {
    this.ensureDirs(workspaceRoot);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const blobPath = path.join(this.getBlobsDir(workspaceRoot), hash);

    if (!fs.existsSync(blobPath)) {
      fs.writeFileSync(blobPath, buf);
    }
    return hash;
  }

  /**
   * Retrieve a blob by hash.
   */
  getBlob(workspaceRoot: string, hash: string): Buffer {
    const blobPath = path.join(this.getBlobsDir(workspaceRoot), hash);
    if (!fs.existsSync(blobPath)) throw new Error(`Blob not found: ${hash}`);
    return fs.readFileSync(blobPath);
  }

  /**
   * Create a versioned workspace snapshot.
   */
  createSnapshot(
    workspaceRoot: string,
    fileMap: Map<string, string>, // relativePath -> fileContent
    label = 'Sync Push',
    gitContext?: { branch: string; commit: string; isDirty: boolean }
  ): WorkspaceSnapshot {
    this.ensureDirs(workspaceRoot);
    const now = Date.now();
    const id = `snap-${now}`;

    const files: Record<string, { hash: string; size: number }> = {};

    for (const [relPath, content] of fileMap.entries()) {
      const hash = this.saveBlob(workspaceRoot, content);
      files[relPath] = { hash, size: Buffer.byteLength(content, 'utf8') };
    }

    const snapshot: WorkspaceSnapshot = {
      id,
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      machineName: os.hostname(),
      label,
      files,
      gitContext
    };

    const snapshotPath = path.join(this.getSnapshotsDir(workspaceRoot), `${id}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

    return snapshot;
  }

  /**
   * List all stored snapshots.
   */
  listSnapshots(workspaceRoot: string): WorkspaceSnapshot[] {
    const sDir = this.getSnapshotsDir(workspaceRoot);
    if (!fs.existsSync(sDir)) return [];

    const files = fs.readdirSync(sDir).filter(f => f.startsWith('snap-') && f.endsWith('.json'));
    const snapshots: WorkspaceSnapshot[] = [];

    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(sDir, f), 'utf8');
        snapshots.push(JSON.parse(raw));
      } catch {}
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Garbage Collect unreferenced blobs. Never deletes any blob referenced by any snapshot!
   */
  gcSnapshots(workspaceRoot: string, maxSnapshotsToKeep = 30): { deletedSnapshots: number; deletedBlobs: number } {
    this.ensureDirs(workspaceRoot);
    const snapshots = this.listSnapshots(workspaceRoot);

    let deletedSnapshots = 0;
    // Prune oldest snapshots exceeding cap
    if (snapshots.length > maxSnapshotsToKeep) {
      const toPrune = snapshots.slice(maxSnapshotsToKeep);
      for (const snap of toPrune) {
        try {
          fs.unlinkSync(path.join(this.getSnapshotsDir(workspaceRoot), `${snap.id}.json`));
          deletedSnapshots++;
        } catch {}
      }
    }

    // Collect all referenced blob hashes from surviving snapshots
    const remaining = this.listSnapshots(workspaceRoot);
    const referencedHashes = new Set<string>();
    for (const snap of remaining) {
      for (const entry of Object.values(snap.files)) {
        referencedHashes.add(entry.hash);
      }
    }

    // Scan blobs directory and prune unreferenced blobs
    const bDir = this.getBlobsDir(workspaceRoot);
    const allBlobs = fs.readdirSync(bDir);
    let deletedBlobs = 0;

    for (const blob of allBlobs) {
      if (!referencedHashes.has(blob)) {
        try {
          fs.unlinkSync(path.join(bDir, blob));
          deletedBlobs++;
        } catch {}
      }
    }

    return { deletedSnapshots, deletedBlobs };
  }
}

export const snapshotManager = new SnapshotManager();

