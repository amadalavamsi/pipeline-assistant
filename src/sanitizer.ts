/**
 * Strict Security Sanitizer
 * Redacts tokens, passwords, AWS ARNs, private keys, and environment secrets before passing logs/diffs to AI.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub Tokens (Personal Access Token, OAuth, App Token)
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /github_pat_[a-zA-Z0-9_]{40,}/g, replacement: '[REDACTED_GH_PAT]' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },

  // AWS Keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY_ID]' },
  { pattern: /aws_secret_access_key\s*=\s*[a-zA-Z0-9\/+=]{40}/gi, replacement: 'aws_secret_access_key=[REDACTED_AWS_SECRET]' },

  // Private Keys (RSA, EC, PGP)
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },

  // JWT Tokens & Generic Bearer Authorization
  { pattern: /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, replacement: 'Bearer [REDACTED_JWT]' },

  // Database Connection URIs with Passwords (postgres://user:password@host)
  { pattern: /(postgres|mysql|mongodb|redis):\/\/[^:\s]+:([^@\s]+)@/gi, replacement: '$1://[USER]:[REDACTED_PASS]@' },

  // Generic API Keys & Secret Variables
  { pattern: /(api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*["']?[a-zA-Z0-9-_./+]{12,}["']?/gi, replacement: '$1=[REDACTED_SECRET]' }
];

export function sanitizeText(text: string): string {
  if (!text) return '';

  let sanitized = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Extracts a window around error keywords in large CI logs to stay safely within token limits.
 */
export function extractErrorLogWindow(fullLog: string, windowLines: number = 80): string {
  const lines = fullLog.split('\n');
  const errorIndices: number[] = [];

  const errorKeywords = [
    /error/i,
    /failed/i,
    /fatal/i,
    /exception/i,
    /panic/i,
    /exit status [1-9]/i,
    /FAIL:/,
    /BUILD FAILED/i,
    /npm ERR!/,
    /Terraform has created a resource.*error/i
  ];

  lines.forEach((line, index) => {
    if (errorKeywords.some(regex => regex.test(line))) {
      errorIndices.push(index);
    }
  });

  if (errorIndices.length === 0) {
    // Return the last N lines if no specific keyword matched
    return lines.slice(-Math.min(lines.length, windowLines)).join('\n');
  }

  // Take the last cluster of errors (most indicative of failure cause)
  const targetIndex = errorIndices[errorIndices.length - 1];
  const start = Math.max(0, targetIndex - Math.floor(windowLines / 2));
  const end = Math.min(lines.length, targetIndex + Math.floor(windowLines / 2));

  return lines.slice(start, end).join('\n');
}
