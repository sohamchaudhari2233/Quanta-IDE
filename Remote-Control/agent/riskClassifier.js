/**
 * Conservative Shell Command Risk Classifier.
 * Evaluates risk level as 'safe', 'caution', or 'dangerous'.
 */

const DANGEROUS_PATTERNS = [
  // Destructive file / disk operations
  /\brm\s+-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*/i,
  /\brmdir\s+\/[sq]/i,
  /\bdel\s+\/[sqf]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bdd\s+if=/i,

  // Sudo / Privilege escalation
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\bdoas\b/i,

  // Dangerous Git commands
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z0-9]*f/i,

  // Direct script execution from internet
  /\b(?:curl|wget|fetch|invoke-webrequest)\b.*\|\s*(?:bash|sh|zsh|python|perl|pwsh|powershell)\b/i,

  // System directory modifications
  /(?:\/etc\/|\/boot\/|\/sys\/|\/dev\/|C:\\Windows|C:\\Program Files)/i,

  // Targeting sensitive credentials directly
  /(?:\.env|\.ssh|id_rsa|id_ed25519|client_secret|\.pem|\.key)\b/i,

  // Database destruction
  /\b(?:drop\s+database|drop\s+table|truncate\s+table)\b/i
];

const SAFE_PATTERNS = [
  /^(?:ls|dir|pwd|echo|cat|head|tail|more|type|which|where)(?:\s+.*)?$/i,
  /^(?:git\s+(?:status|diff|log|branch|show|remote|tag))(?:\s+.*)?$/i,
  /^(?:npm|yarn|pnpm|cargo|go|pytest|python -m unittest)\s+(?:test|check|verify|run\s+test)(?:\s+.*)?$/i,
  /^(?:node|python|ruby)\s+--version$/i
];

/**
 * Split command line by operators (&&, ||, ;, |, subshells)
 */
export function splitCommandSegments(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') return [];

  // Remove leading/trailing whitespace
  const trimmed = commandLine.trim();

  // Normalize subshells: extract inner commands
  const segments = [];
  const rawSegments = trimmed.split(/&&|\|\||;|\|/);

  for (const seg of rawSegments) {
    const clean = seg.trim();
    if (clean) {
      segments.push(clean);
      // Check for command substitutions like $(cmd) or `cmd`
      const subMatches = clean.match(/\$\(([^)]+)\)|`([^`]+)`/g);
      if (subMatches) {
        for (const sub of subMatches) {
          const inner = sub.replace(/^\$\(|\)$|^`|`$/g, '').trim();
          if (inner) segments.push(inner);
        }
      }
    }
  }

  return segments;
}

/**
 * Classify a single command segment.
 */
function classifySingleSegment(segment) {
  const clean = segment.trim();
  if (!clean) return 'safe';

  // 1. Check Dangerous patterns first
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(clean)) {
      return 'dangerous';
    }
  }

  // 2. Check Safe patterns
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(clean)) {
      return 'safe';
    }
  }

  // 3. Default to Caution for any other command (installs, builds, git commits, unparseable)
  return 'caution';
}

/**
 * Classify command line. Highest risk of any segment wins!
 */
export function classifyCommandRisk(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') {
    return { risk: 'caution', segments: [], reason: 'Empty or unparseable command' };
  }

  const segments = splitCommandSegments(commandLine);
  if (segments.length === 0) {
    return { risk: 'caution', segments: [], reason: 'No command segments detected' };
  }

  let highestRisk = 'safe';
  let triggerSegment = segments[0];

  for (const seg of segments) {
    const segRisk = classifySingleSegment(seg);
    if (segRisk === 'dangerous') {
      return { risk: 'dangerous', segments, triggerSegment: seg, reason: `Matched dangerous pattern: "${seg}"` };
    }
    if (segRisk === 'caution') {
      highestRisk = 'caution';
      triggerSegment = seg;
    }
  }

  return {
    risk: highestRisk,
    segments,
    triggerSegment,
    reason: highestRisk === 'safe' ? 'All segments matched safe read-only patterns' : 'Contains state-modifying actions'
  };
}

