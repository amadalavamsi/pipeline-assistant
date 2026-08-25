/**
 * Strict Security Sanitizer
 * Redacts tokens, passwords, AWS keys, private keys, cloud credentials,
 * and environment secrets before passing logs/diffs to AI or writing to logs.
 */

import * as core from '@actions/core';

// Dynamic secrets registered at runtime (e.g. from env vars or inputs)
const dynamicSecrets = new Set<string>();

/**
 * Register a sensitive string value to be strictly redacted across all logs, diffs, and prompts.
 * Also registers it with GitHub Actions runner to mask in runner console.
 */
export function registerSecret(secret: string): void {
  if (!secret || typeof secret !== 'string') return;
  const trimmed = secret.trim();
  if (trimmed.length >= 4) {
    dynamicSecrets.add(trimmed);
    try {
      core.setSecret(trimmed);
    } catch {
      // Ignored outside GitHub Actions runner environment
    }
  }
}

/**
 * Automatically scan process.env for sensitive variable values and register them.
 */
export function initializeEnvSecretMasking(): void {
  const sensitiveKeyPatterns = [
    /_TOKEN$/i,
    /^TOKEN/i,
    /API[_-]?KEY/i,
    /SECRET/i,
    /PASSWORD/i,
    /PASSWD/i,
    /PRIVATE[_-]?KEY/i,
    /CREDENTIAL/i,
    /AUTH[_-]?TOKEN/i
  ];

  const ignoredEnvKeys = new Set([
    'SSH_AUTH_SOCK',
    'PATH',
    'NODE_PATH',
    'PWD',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'TMP'
  ]);

  for (const [key, value] of Object.entries(process.env)) {
    if (ignoredEnvKeys.has(key)) continue;
    if (value && typeof value === 'string' && value.length >= 6) {
      if (sensitiveKeyPatterns.some(pat => pat.test(key))) {
        registerSecret(value);
      }
    }
  }
}

// Static comprehensive regex patterns for known cloud and API secret formats
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub Tokens (PAT, OAuth, App, Installation, Refresh)
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /github_pat_[a-zA-Z0-9_]{40,}/g, replacement: '[REDACTED_GH_PAT]' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /ghr_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },

  // OpenAI & Anthropic API Keys
  { pattern: /sk-proj-[a-zA-Z0-9_-]{30,}/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

  // AWS Credentials
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY_ID]' },
  { pattern: /ASIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_TEMP_KEY_ID]' },
  { pattern: /aws_secret_access_key\s*[:=]\s*[a-zA-Z0-9\/+=]{40}/gi, replacement: 'aws_secret_access_key=[REDACTED_AWS_SECRET]' },

  // Google / GCP API Keys
  { pattern: /AIza[0-9A-Za-z-_]{35}/g, replacement: '[REDACTED_GCP_API_KEY]' },

  // Slack Tokens
  { pattern: /xox[baprs]-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },

  // NPM & PyPI Tokens
  { pattern: /npm_[a-zA-Z0-9]{36}/g, replacement: '[REDACTED_NPM_TOKEN]' },
  { pattern: /pypi-[a-zA-Z0-9-_]{40,}/g, replacement: '[REDACTED_PYPI_TOKEN]' },

  // Azure Storage Keys & Connection Strings
  { pattern: /AccountKey=[a-zA-Z0-9+/=]{60,}/gi, replacement: 'AccountKey=[REDACTED_AZURE_KEY]' },
  { pattern: /SharedAccessSignature=[^\s"']+/gi, replacement: 'SharedAccessSignature=[REDACTED_AZURE_SAS]' },

  // Private Keys & Certificates (RSA, EC, PGP, OpenSSH, DSA)
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, replacement: '[REDACTED_CERTIFICATE]' },

  // JWT Tokens & Generic Bearer Authorization
  { pattern: /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, replacement: 'Bearer [REDACTED_JWT]' },

  // Database Connection URIs with Passwords (postgres://user:password@host, mysql, mongodb, redis)
  { pattern: /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/([^:\s]+):([^@\s]+)@/gi, replacement: '$1://$2:[REDACTED_PASS]@' },

  // Generic API Keys, Secrets & Authorization headers
  { pattern: /(api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|password|passwd|secret[_-]?key)\s*[:=]\s*["']?[a-zA-Z0-9-_./+=]{10,}["']?/gi, replacement: '$1=[REDACTED_SECRET]' }
];

export function sanitizeText(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let sanitized = text;

  // 1. Redact dynamically registered secrets
  for (const secret of dynamicSecrets) {
    if (secret && sanitized.includes(secret)) {
      // Global literal replacement safely escaped
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }

  // 2. Redact static known secret patterns
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Extracts a window around error keywords in large CI logs to stay safely within token limits.
 */
export function extractErrorLogWindow(fullLog: string, windowLines: number = 80): string {
  if (!fullLog) return '';

  const lines = fullLog.split('\n');
  const radius = Math.max(10, Math.floor(windowLines / 2));
  const errorKeywords = [
    /\berror\b/i,
    /\bfailed\b/i,
    /\bfatal\b/i,
    /\bexception\b/i,
    /\bpanic\b/i,
    /exit status [1-9]/i,
    /FAIL:/i,
    /BUILD FAILED/i,
    /npm ERR!/i,
    /process completed with exit code [1-9]/i,
    /command failed/i
  ];

  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (errorKeywords.some(regex => regex.test(line))) matches.push(index);
  });

  if (matches.length === 0) {
    return lines.slice(-Math.min(lines.length, windowLines)).join('\n');
  }

  // Preserve context around both the earliest meaningful error and the final
  // failure summary. The last error-looking line is often only a consequence
  // such as "process exited with code 1".
  const anchors = [matches[0], matches[matches.length - 1]];
  const ranges: Array<[number, number]> = [];

  for (const anchor of anchors) {
    const start = Math.max(0, anchor - radius);
    const end = Math.min(lines.length, anchor + radius + 1);
    ranges.push([start, end]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  const selected: string[] = [];
  for (const [start, end] of merged) {
    selected.push(lines.slice(start, end).join('\n'));
  }

  return selected.join('\n\n--- additional failure context ---\n\n');
}
