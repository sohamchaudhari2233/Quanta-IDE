import * as fs from 'fs';
import * as path from 'path';

export interface ManifestEntry {
  path: string;
  localMd5: string;
  remoteMd5: string;
  remoteId: string;
  remoteModifiedTime?: string;
  lastSyncedAt: number;
}

export interface SyncManifest {
  version: number;
  workspaceName: string;
  lastSyncTimestamp: number;
  files: Record<string, ManifestEntry>;
}

export type SyncActionType = 'upload' | 'download' | 'conflict' | 'deleteRemote' | 'deleteLocal' | 'noChange';

export interface SyncPlanItem {
  type: SyncActionType;
  path: string;
  localMd5?: string;
  remoteMd5?: string;
  remoteId?: string;
}

export function getManifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.quanta', 'sync-manifest.json');
}

export function loadManifest(workspaceRoot: string, workspaceName: string = ''): SyncManifest {
  const manifestPath = getManifestPath(workspaceRoot);
  try {
    if (fs.existsSync(manifestPath)) {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (data && data.files) return data;
    }
  } catch (e) {
    console.warn('Failed to load sync-manifest.json:', e);
  }
  return {
    version: 1,
    workspaceName,
    lastSyncTimestamp: 0,
    files: {}
  };
}

export function saveManifest(workspaceRoot: string, manifest: SyncManifest): void {
  const manifestPath = getManifestPath(workspaceRoot);
  try {
    const dir = path.dirname(manifestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    manifest.lastSyncTimestamp = Date.now();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save sync-manifest.json:', e);
  }
}

/**
 * Perform three-way delta analysis between local state, remote state, and last synced base state.
 */
export function computeThreeWayPlan(
  localFiles: Map<string, string>, // relativePath -> localMd5
  remoteFiles: Map<string, { id: string; md5: string; modifiedTime?: string }>, // relativePath -> remoteInfo
  manifest: SyncManifest
): SyncPlanItem[] {
  const plan: SyncPlanItem[] = [];
  const allPaths = new Set<string>([
    ...localFiles.keys(),
    ...remoteFiles.keys(),
    ...Object.keys(manifest.files)
  ]);

  for (const p of allPaths) {
    const localMd5 = localFiles.get(p);
    const remote = remoteFiles.get(p);
    const base = manifest.files[p];

    const hasLocal = !!localMd5;
    const hasRemote = !!remote;
    const hasBase = !!base;

    if (!hasBase) {
      // Never synced before
      if (hasLocal && !hasRemote) {
        plan.push({ type: 'upload', path: p, localMd5 });
      } else if (!hasLocal && hasRemote) {
        plan.push({ type: 'download', path: p, remoteId: remote.id, remoteMd5: remote.md5 });
      } else if (hasLocal && hasRemote) {
        if (localMd5 === remote.md5) {
          plan.push({ type: 'noChange', path: p, localMd5, remoteMd5: remote.md5, remoteId: remote.id });
        } else {
          plan.push({ type: 'conflict', path: p, localMd5, remoteMd5: remote.md5, remoteId: remote.id });
        }
      }
    } else {
      // Previously synced
      const localChanged = hasLocal ? localMd5 !== base.localMd5 : true;
      const remoteChanged = hasRemote ? remote.md5 !== base.remoteMd5 : true;

      if (!hasLocal && !hasRemote) {
        // Deleted on both sides
        continue;
      }

      if (hasLocal && !hasRemote) {
        if (!localChanged) {
          // Remote was deleted, local wasn't modified -> delete local
          plan.push({ type: 'deleteLocal', path: p });
        } else {
          // Local modified while remote deleted -> Conflict
          plan.push({ type: 'conflict', path: p, localMd5 });
        }
      } else if (!hasLocal && hasRemote) {
        if (!remoteChanged) {
          // Local was deleted, remote wasn't modified -> delete remote
          plan.push({ type: 'deleteRemote', path: p, remoteId: remote.id, remoteMd5: remote.md5 });
        } else {
          // Remote modified while local deleted -> Conflict
          plan.push({ type: 'conflict', path: p, remoteId: remote.id, remoteMd5: remote.md5 });
        }
      } else if (hasLocal && hasRemote) {
        if (!localChanged && !remoteChanged) {
          plan.push({ type: 'noChange', path: p, localMd5, remoteMd5: remote.md5, remoteId: remote.id });
        } else if (localChanged && !remoteChanged) {
          plan.push({ type: 'upload', path: p, localMd5, remoteId: remote.id });
        } else if (!localChanged && remoteChanged) {
          plan.push({ type: 'download', path: p, remoteId: remote.id, remoteMd5: remote.md5 });
        } else {
          // Both changed!
          if (localMd5 === remote.md5) {
            plan.push({ type: 'noChange', path: p, localMd5, remoteMd5: remote.md5, remoteId: remote.id });
          } else {
            plan.push({ type: 'conflict', path: p, localMd5, remoteMd5: remote.md5, remoteId: remote.id });
          }
        }
      }
    }
  }

  return plan;
}

