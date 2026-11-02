/**
 * Regex-based Redaction Filter for AI chat transcripts and sensitive logs.
 */

const REDACTION_RULES: { name: string; pattern: RegExp; replacement: string }[] = [
  // 1. Private Keys
  {
    name: 'PrivateKey',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]'
  },
  // 2. Google Cloud / Gemini API Keys
  {
    name: 'GoogleApiKey',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    replacement: '[REDACTED_GOOGLE_API_KEY]'
  },
  // 3. GitHub Personal Access Tokens
  {
    name: 'GitHubToken',
    pattern: /\b(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]'
  },
  // 4. OpenAI / Anthropic API Keys
  {
    name: 'AiApiKey',
    pattern: /\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_AI_API_KEY]'
  },
  // 5. JSON Web Tokens (JWT)
  {
    name: 'JWT',
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_JWT_TOKEN]'
  },
  // 6. Bearer Authorization Headers
  {
    name: 'BearerToken',
    pattern: /\bBearer\s+[a-zA-Z0-9\-._~+/]{20,}=*\b/gi,
    replacement: 'Bearer [REDACTED_BEARER_TOKEN]'
  },
  // 7. Sensitive Assignment Statements (password=..., secret=..., token=...)
  {
    name: 'SensitiveAssignment',
    pattern: /\b(password|client_secret|api_key|auth_token|secret_key|private_key)\s*([:=])\s*["']?([^\s"'`\r\n]{6,})["']?/gi,
    replacement: '$1$2"[REDACTED_SECRET]"'
  },
  // 8. .env style credential lines
  {
    name: 'EnvSecretLine',
    pattern: /^([A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*)\s*=\s*["']?([^\s"'`\r\n]+)["']?$/gim,
    replacement: '$1="[REDACTED_ENV_SECRET]"'
  }
];

/**
 * Redact sensitive secrets, keys, and tokens from text content.
 */
export function redactSensitiveText(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let redacted = text;

  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }

  return redacted;
}

