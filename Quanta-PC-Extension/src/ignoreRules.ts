import * as fs from 'fs';
import * as path from 'path';

/**
 * Built-in default ignore patterns that can NEVER be overridden.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  '.env*',
  '!.env.example',
  'client_secret*.json',
  '!client_secret.example.json',
  'API keys*',
  '*api*key*',
  '*.pem',
  '*.key',
  '*.cert',
  '*.crt',
  'certs/**',
  'node_modules/**',
  '.git/**',
  '.quanta/**',
  'dist/**',
  'out/**',
  'bin/**',
  '*.vsix',
  '*.apk',
  '*.aab',
  'antigravity_chats.json',
  '*.log',
  '*_log.txt',
  '.DS_Store',
  'Thumbs.db',
  '*~',
  '*.swp',
  '*.swo'
];

export class IgnoreMatcher {
  private patterns: {
    pattern: string;
    isNegated: boolean;
    isDirectoryOnly: boolean;
    regex: RegExp;
    dirRegex?: RegExp;
  }[] = [];

  constructor(customPatterns: string[] = []) {
    const combined = [...DEFAULT_IGNORE_PATTERNS, ...customPatterns];
    this.compilePatterns(combined);
  }

  private globToRegex(glob: string): RegExp {
    let re = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLESTAR§/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${re}($|/)`);
  }

  private globToDirRegex(glob: string): RegExp {
    let re = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLESTAR§/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${re}/`);
  }

  private compilePatterns(rawList: string[]) {
    this.patterns = [];
    for (const raw of rawList) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const isNegated = trimmed.startsWith('!');
      const clean = isNegated ? trimmed.substring(1).trim() : trimmed;
      const isDirectoryOnly = clean.endsWith('/');
      const glob = isDirectoryOnly ? clean.slice(0, -1) : clean;

      this.patterns.push({
        pattern: clean,
        isNegated,
        isDirectoryOnly,
        regex: this.globToRegex(glob),
        dirRegex: isDirectoryOnly ? this.globToDirRegex(glob) : undefined
      });
    }
  }

  /**
   * Check if a relative file/folder path should be ignored.
   * Path should use forward slashes (e.g. "src/index.ts" or "node_modules/")
   */
  public isIgnored(relativePath: string, isDirectory: boolean = false): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    let ignored = false;

    for (const p of this.patterns) {
      if (p.isDirectoryOnly) {
        if (isDirectory) {
          const normalizedDir = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
          if (p.regex.test(normalized) || p.regex.test(normalizedDir)) {
            ignored = !p.isNegated;
          }
        } else if (p.dirRegex && p.dirRegex.test(normalized)) {
          ignored = !p.isNegated;
        }
        continue;
      }

      if (p.regex.test(normalized)) {
        ignored = !p.isNegated;
      }
    }
    return ignored;
  }
}

/**
 * Load .quantaignore from workspace root, creating a default one if missing.
 */
export function loadWorkspaceIgnore(workspaceRoot: string): IgnoreMatcher {
  const ignoreFile = path.join(workspaceRoot, '.quantaignore');
  let patterns: string[] = [];

  if (fs.existsSync(ignoreFile)) {
    try {
      const content = fs.readFileSync(ignoreFile, 'utf8');
      patterns = content.split('\n');
    } catch (e) {
      console.warn('Failed to read .quantaignore:', e);
    }
  } else {
    // Generate default template
    const defaultTemplate = `# ===================================================================
# Quanta IDE Workspace Sync Ignore (.quantaignore)
# Files and directories excluded from Google Drive synchronization.
# ===================================================================

# Build outputs
build/
dist/
out/
bin/

# Dependencies
node_modules/
vendor/

# Temporary / OS files
*.tmp
*.bak
.DS_Store
Thumbs.db
`;
    try {
      fs.writeFileSync(ignoreFile, defaultTemplate, 'utf8');
    } catch {}
  }

  // Also check if .gitignore exists and load patterns if user enabled it
  const gitignoreFile = path.join(workspaceRoot, '.gitignore');
  if (fs.existsSync(gitignoreFile)) {
    try {
      const gitContent = fs.readFileSync(gitignoreFile, 'utf8');
      patterns.push(...gitContent.split('\n'));
    } catch {}
  }

  return new IgnoreMatcher(patterns);
}

