import { classifyCommandRisk, splitCommandSegments } from './riskClassifier.js';

export class RuleEngine {
  constructor(rules = []) {
    this.rules = rules;
  }

  setRules(rules) {
    this.rules = rules || [];
  }

  /**
   * Evaluate whether a command can be auto-approved based on active rules.
   * STRICT HARD FLOOR: 'dangerous' commands can NEVER be auto-approved.
   */
  canAutoApprove(actionType, commandLine, workingDir = '', workspaceRoot = '') {
    // 1. Run risk classifier
    const classification = classifyCommandRisk(commandLine);
    
    // HARD FLOOR ENFORCEMENT: Dangerous commands NEVER pass auto-approval
    if (classification.risk === 'dangerous') {
      return {
        autoApprove: false,
        risk: 'dangerous',
        reason: 'HARD FLOOR: Dangerous commands can never be auto-approved'
      };
    }

    // 2. Ensure execution is within workspace scope if workspaceRoot is provided
    if (workspaceRoot && workingDir) {
      const normalizedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();
      const normalizedWork = workingDir.replace(/\\/g, '/').toLowerCase();
      if (!normalizedWork.startsWith(normalizedRoot)) {
        return {
          autoApprove: false,
          risk: 'caution',
          reason: 'Path scope restriction: Command execution outside workspace root requires manual approval'
        };
      }
    }

    // 3. Match against active rules
    const activeRules = this.rules.filter(r => r.enabled);
    if (activeRules.length === 0) {
      return {
        autoApprove: false,
        risk: classification.risk,
        reason: 'No matching auto-approval rules enabled (Deny by Default)'
      };
    }

    // Every segment of a compound command must be covered by a rule
    const segments = splitCommandSegments(commandLine);
    for (const segment of segments) {
      let segmentApproved = false;
      for (const rule of activeRules) {
        if (rule.actionType !== actionType) continue;

        // Check command regex pattern
        if (rule.commandPattern) {
          try {
            const re = new RegExp(rule.commandPattern, 'i');
            if (re.test(segment)) {
              segmentApproved = true;
              break;
            }
          } catch {}
        }
      }

      if (!segmentApproved) {
        return {
          autoApprove: false,
          risk: classification.risk,
          reason: `Command segment "${segment}" did not match any auto-approve rule`
        };
      }
    }

    return {
      autoApprove: true,
      risk: classification.risk,
      reason: 'Matched active auto-approval rule(s)'
    };
  }

  /**
   * Simulate a rule against recent approval history.
   */
  simulateRule(candidateRule, history = []) {
    let matchedCount = 0;
    let blockedDangerous = 0;

    for (const item of history) {
      const classification = classifyCommandRisk(item.command);
      if (classification.risk === 'dangerous') {
        blockedDangerous++;
        continue;
      }
      try {
        const re = new RegExp(candidateRule.commandPattern, 'i');
        if (re.test(item.command)) {
          matchedCount++;
        }
      } catch {}
    }

    return {
      totalAnalyzed: history.length,
      wouldApprove: matchedCount,
      blockedDangerous
    };
  }
}

