import crypto from 'crypto';
import { eventBus } from '../core/eventBus.js';
import { classifyCommandRisk } from './riskClassifier.js';
import { RuleEngine } from './ruleEngine.js';
import { persistentStore } from '../core/store.js';
import { auditLogger } from '../security/auditLogger.js';

export class ApprovalManager {
  constructor(ruleEngine = null) {
    this.ruleEngine = ruleEngine || new RuleEngine(persistentStore.get('autoApproveRules') || []);
    this.pendingApprovals = new Map(); // id -> approvalCard
  }

  createFingerprint(actionType, command, workingDir = '') {
    return crypto
      .createHash('sha256')
      .update(`${actionType}|${command.trim()}|${workingDir.trim()}`)
      .digest('hex')
      .substring(0, 16);
  }

  requestApproval(opts = {}) {
    const actionType = opts.actionType || opts.action || 'run_command';
    const command = opts.command || '';
    const workingDir = opts.workingDir || opts.targetPath || '';
    const workspaceRoot = opts.workspaceRoot || '';

    const fingerprint = this.createFingerprint(actionType, command, workingDir);
    const classification = classifyCommandRisk(command);

    // Deduplication check: return existing pending approval if fingerprint matches
    for (const card of this.pendingApprovals.values()) {
      if (card.fingerprint === fingerprint) {
        return card;
      }
    }

    // 1. Check auto-approval rules
    const autoDecision = this.ruleEngine.canAutoApprove(actionType, command, workingDir, workspaceRoot);
    if (autoDecision.autoApprove) {
      auditLogger.log({
        type: 'AUTO_APPROVE',
        summary: `Auto-approved (${classification.risk}): ${command}`,
        details: { fingerprint, reason: autoDecision.reason }
      });
      return {
        autoApproved: true,
        risk: classification.risk,
        fingerprint,
        reason: autoDecision.reason
      };
    }

    // 2. Queue for manual mobile approval
    const id = crypto.randomUUID();
    const approvalCard = {
      id,
      fingerprint,
      actionType,
      action: actionType,
      command,
      workingDir,
      targetPath: workingDir,
      risk: classification.risk,
      triggerSegment: classification.triggerSegment,
      reason: classification.reason,
      status: 'pending',
      timestamp: Date.now()
    };

    this.pendingApprovals.set(id, approvalCard);

    // Publish event over EventBus to mobile clients
    eventBus.publish('approval.requested', approvalCard);

    return approvalCard;
  }

  getPending() {
    return this.getPendingApprovals();
  }

  resolve(id, decision, options = {}) {
    const res = this.resolveApproval({
      id,
      decision,
      resolvedBy: options.user || options.resolvedBy || 'mobile',
      deviceId: options.deviceId || 'unknown',
      ...options
    });
    if (!res.success) {
      throw new Error(res.error);
    }
    return res.card;
  }

  getPendingApprovals() {
    return Array.from(this.pendingApprovals.values());
  }

  resolveApproval({ id, fingerprint, decision, resolvedBy = 'mobile', deviceId = 'unknown' }) {
    const card = this.pendingApprovals.get(id);
    if (!card) {
      return { success: false, error: 'Approval request not found or already resolved' };
    }

    // Strict race & spoof prevention: prompt fingerprint MUST match
    if (fingerprint && card.fingerprint !== fingerprint) {
      return {
        success: false,
        error: 'Spoof/Race detected: Prompt content in IDE does not match approval card'
      };
    }

    card.status = decision === 'approve' ? 'approved' : 'rejected';
    card.resolvedAt = Date.now();
    card.resolvedBy = resolvedBy;
    card.deviceId = deviceId;

    this.pendingApprovals.delete(id);

    // Save to persistent history (last 100)
    const history = persistentStore.get('approvalsHistory') || [];
    history.push(card);
    if (history.length > 100) history.shift();
    persistentStore.set('approvalsHistory', history);

    // Log decision in audit logger
    auditLogger.log({
      type: decision === 'approve' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
      deviceId,
      summary: `${decision.toUpperCase()} action (${card.risk}): ${card.command}`,
      details: { id, fingerprint: card.fingerprint }
    });

    // Notify listeners & mobile clients
    eventBus.publish('approval.resolved', card);

    return { success: true, card };
  }
}

export const approvalManager = new ApprovalManager();
