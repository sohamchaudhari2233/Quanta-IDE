import * as fs from 'fs';
import * as path from 'path';

export interface SelectiveSyncConfig {
  version: number;
  excludedPaths: string[]; // e.g. ["assets/raw-video", "datasets"]
  includedPaths?: string[];
}

export class SelectiveSyncManager {
  private getConfigPath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.quanta', 'selective-sync.json');
  }

  loadConfig(workspaceRoot: string): SelectiveSyncConfig {
    const p = this.getConfigPath(workspaceRoot);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {}
    }
    return { version: 1, excludedPaths: [] };
  }

  saveConfig(workspaceRoot: string, config: SelectiveSyncConfig) {
    const p = this.getConfigPath(workspaceRoot);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Check whether a path is excluded by selective sync settings.
   */
  isPathExcluded(relativePath: string, config: SelectiveSyncConfig): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const ex of config.excludedPaths || []) {
      const cleanEx = ex.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized === cleanEx || normalized.startsWith(`${cleanEx}/`)) {
        return true;
      }
    }
    return false;
  }
}

export const selectiveSyncManager = new SelectiveSyncManager();

