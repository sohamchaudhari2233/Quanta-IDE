import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.QUANTA_DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const INITIAL_SCHEMA = {
  version: 1,
  taskQueue: [],
  autoApproveRules: [
    {
      id: 'rule-safe-readonly',
      name: 'Auto-Approve Read-Only Inspection',
      actionType: 'run_command',
      commandPattern: '^(ls|dir|pwd|git status|git diff|cat|echo)(\\s+.*)?$',
      pathScope: 'workspace',
      riskLevel: 'safe',
      enabled: false
    }
  ],
  approvalsHistory: [],
  quickActions: [
    { id: 'act-git-status', label: 'Git Status', command: 'git status', isReadOnly: true },
    { id: 'act-git-diff', label: 'Git Diff', command: 'git diff', isReadOnly: true },
    { id: 'act-npm-test', label: 'Run Tests', command: 'npm test', isReadOnly: false, aliases: ['run-tests', 'npm-test'] }
  ],
  webhooks: [],
  promptLibrary: [
    { id: 'tpl-review', title: 'Code Review', prompt: 'Please review the recent changes for security, performance, and best practices.', tags: ['review'] },
    { id: 'tpl-test', title: 'Add Unit Tests', prompt: 'Write comprehensive unit tests covering the new functionality with positive and negative assertions.', tags: ['test'] }
  ]
};

export class PersistentStore {
  constructor() {
    this.ensureDir();
    this.data = this.load();
  }

  ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  load() {
    this.ensureDir();
    if (fs.existsSync(STORE_FILE)) {
      try {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        if (!raw || !raw.trim()) return { ...INITIAL_SCHEMA };
        const parsed = JSON.parse(raw);
        return { ...INITIAL_SCHEMA, ...parsed };
      } catch (err) {
        if (err.name === 'SyntaxError') {
          return { ...INITIAL_SCHEMA };
        }
        console.error('Failed to parse store.json, restoring initial schema:', err.message);
        return { ...INITIAL_SCHEMA };
      }
    }
    this.save(INITIAL_SCHEMA);
    return { ...INITIAL_SCHEMA };
  }

  save(data = this.data) {
    this.ensureDir();
    const payload = JSON.stringify(data, null, 2);
    const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpFile, payload, 'utf8');
      try {
        fs.renameSync(tmpFile, STORE_FILE);
      } catch {
        fs.copyFileSync(tmpFile, STORE_FILE);
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    } catch (err) {
      try {
        fs.writeFileSync(STORE_FILE, payload, 'utf8');
      } catch (writeErr) {
        console.error('Failed to atomically save store.json:', writeErr.message);
      }
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }
}

export const persistentStore = new PersistentStore();

