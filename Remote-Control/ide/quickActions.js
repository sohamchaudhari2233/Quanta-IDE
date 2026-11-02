import { execSync } from 'child_process';
import { persistentStore } from '../core/store.js';
import { auditLogger } from '../security/auditLogger.js';

export class QuickActionRunner {
  constructor() {
    this.customActions = new Map();
  }

  registerAction(action) {
    if (!action.id) throw new Error('Action must have an id');
    this.customActions.set(action.id, action);
  }

  getActions() {
    const storeActions = persistentStore.get('quickActions') || [];
    const all = [...storeActions];
    for (const ca of this.customActions.values()) {
      all.push(ca);
    }
    return all;
  }

  listActions() {
    return this.getActions().map(a => ({
      id: a.id.replace(/^act-/, ''),
      rawId: a.id,
      name: a.label || a.name || a.id,
      command: a.command,
      risk: a.risk || (a.isReadOnly ? 'safe' : 'caution')
    }));
  }

  executeAction(actionId, params = {}, session = null) {
    const res = this.runAction(actionId, session?.workspaceRoot || process.cwd(), session?.user || 'mobile');
    if (!res.success) {
      throw new Error(res.output);
    }
    return {
      stdout: res.output,
      durationMs: res.durationMs
    };
  }

  runAction(actionId, workspaceRoot = process.cwd(), deviceId = 'unknown') {
    const actions = this.getActions();
    const action = actions.find(a => {
      if (a.id === actionId || a.id === `act-${actionId}` || a.id.replace(/^act-/, '') === actionId) return true;
      if (Array.isArray(a.aliases) && (a.aliases.includes(actionId) || a.aliases.includes(`act-${actionId}`) || a.aliases.includes(actionId.replace(/^act-/, '')))) return true;
      const normalizedLabel = (a.label || a.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (normalizedLabel && (normalizedLabel === actionId || `act-${normalizedLabel}` === actionId || normalizedLabel === actionId.replace(/^act-/, ''))) return true;
      if (actionId === 'run-tests' && a.id === 'act-npm-test') return true;
      if (actionId === 'act-run-tests' && a.id === 'act-npm-test') return true;
      return false;
    });

    if (!action) {
      throw new Error(`Action not found in allowlist: ${actionId}`);
    }

    if (typeof action.handler === 'function') {
      try {
        const out = action.handler();
        return { success: true, actionId, label: action.name || action.id, output: JSON.stringify(out) };
      } catch (e) {
        return { success: false, actionId, label: action.name || action.id, output: e.message };
      }
    }

    const startTime = Date.now();
    try {
      const output = execSync(action.command, {
        cwd: workspaceRoot,
        timeout: 30000, // 30s timeout
        maxBuffer: 512 * 1024, // 512 KB
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const durationMs = Date.now() - startTime;
      auditLogger.log({
        type: 'QUICK_ACTION_EXECUTED',
        deviceId,
        summary: `Executed quick action: ${action.label} (${action.command})`,
        details: { durationMs }
      });

      return {
        success: true,
        actionId,
        label: action.label,
        output,
        durationMs
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorOutput = err.stderr ? err.stderr.toString('utf8') : err.message;

      auditLogger.log({
        type: 'QUICK_ACTION_FAILED',
        deviceId,
        summary: `Quick action failed: ${action.label}`,
        details: { error: errorOutput, durationMs }
      });

      return {
        success: false,
        actionId,
        label: action.label,
        output: errorOutput,
        durationMs
      };
    }
  }
}

export const quickActionRunner = new QuickActionRunner();
