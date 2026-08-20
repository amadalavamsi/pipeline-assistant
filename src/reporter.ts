/**
 * reporter.ts
 *
 * Handles two output channels for failure diagnostics:
 *   1. GitHub Actions Job Summary  — always written, visible on the failed-job Summary tab.
 *   2. Inline PR annotations       — emitted only when a pull-request context is present.
 *
 * Both functions consume the AI-generated markdown report from index.ts; no prompt changes needed.
 */

import * as core from '@actions/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Annotation {
  file: string;
  line: number;
  message: string;
}

export interface JobSummaryParams {
  jobName: string;
  commitSha: string;
  author: string;
  /** Human-readable trigger label, e.g. "push" or "PR #12" */
  triggerLabel: string;
  markdownReport: string;
}

// ---------------------------------------------------------------------------
// Annotation Parser
// ---------------------------------------------------------------------------

/**
 * Scan an AI-generated markdown report for common compiler / runtime error
 * file:line patterns and return structured annotations.
 *
 * Supported patterns:
 *  - TypeScript / ESLint  : src/foo.ts:10:5 - error TS2345: …
 *  - Python               : File "src/main.py", line 42
 *  - Jest / Node stack    : at Object.<anonymous> (test/foo.test.js:42:5)
 *  - Generic              : error at path/to/file.go:25
 *
 * Capped at 5 results (GitHub allows 10 annotations per step; buffer kept for safety).
 */
export function parseAnnotations(text: string): Annotation[] {
  const annotations: Annotation[] = [];
  const seen = new Set<string>();

  type PatternDef = {
    regex: RegExp;
    fileIdx: number;
    lineIdx: number;
    msgIdx: number; // -1 means build a default message
  };

  const patterns: PatternDef[] = [
    // TypeScript/ESLint: src/foo.ts:10:5 - error TS2345: Argument of type …
    {
      regex: /([^\s"'`(]+\.[a-z]{2,5}):(\d+):\d+\s*[-–]\s*(error\s+\S+[^\n]*)/gi,
      fileIdx: 1,
      lineIdx: 2,
      msgIdx: 3
    },
    // Python: File "src/main.py", line 42
    {
      regex: /File "([^"]+\.[a-z]{2,5})",\s*line\s+(\d+)/gi,
      fileIdx: 1,
      lineIdx: 2,
      msgIdx: -1
    },
    // Jest / Node.js stack: at Object.<anonymous> (test/foo.test.js:42:5)
    {
      regex: /at\s+\S+\s+\(([^\s)]+\.[a-z]{2,5}):(\d+):\d+\)/gi,
      fileIdx: 1,
      lineIdx: 2,
      msgIdx: -1
    },
    // Generic: Error at path/to/file.go:25
    {
      regex: /(?:error|Error|ERROR)\s+at\s+([^\s:]+\.[a-z]{2,5}):(\d+)/gi,
      fileIdx: 1,
      lineIdx: 2,
      msgIdx: -1
    }
  ];

  for (const { regex, fileIdx, lineIdx, msgIdx } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (annotations.length >= 5) break;

      const file = match[fileIdx]?.trim();
      const line = parseInt(match[lineIdx], 10);
      if (!file || isNaN(line)) continue;

      const dedupeKey = `${file}:${line}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const message =
        msgIdx >= 0 && match[msgIdx]
          ? match[msgIdx].trim()
          : `Failure detected at ${file}:${line}`;

      annotations.push({ file, line, message });
    }
    if (annotations.length >= 5) break;
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text body of a named section from the AI markdown report.
 * Searches for any heading line that contains `sectionKeyword` and returns
 * all content up to the next heading of the same or higher level.
 */
function extractSection(markdown: string, sectionKeyword: string): string {
  const lines = markdown.split('\n');
  let capturing = false;
  let captureLevel = 0;
  const buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#+)\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2];

      if (title.includes(sectionKeyword)) {
        capturing = true;
        captureLevel = level;
        continue;
      }

      if (capturing && level <= captureLevel) {
        // Reached the next sibling or parent heading — stop.
        break;
      }
    }

    if (capturing) {
      buffer.push(line);
    }
  }

  return buffer.join('\n').trim();
}

/**
 * Strip markdown code fences (``` … ```) so the text can be embedded
 * safely inside an HTML <pre><code> block in the Job Summary.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[a-z]*\n?/gi, '').trim();
}

/**
 * Escape HTML special characters so raw text is safe inside HTML elements.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Job Summary writer
// ---------------------------------------------------------------------------

/**
 * Write a rich GitHub Actions Job Summary to $GITHUB_STEP_SUMMARY.
 *
 * Output layout:
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  ❌ Pipeline Failure Analysis                             │
 *  ├──────────────┬──────────┬────────────┬───────────────────┤
 *  │  Failed Job  │  Commit  │  Author    │  Trigger          │
 *  ├──────────────┴──────────┴────────────┴───────────────────┤
 *  │  🔍 Root Cause                                            │
 *  │  <text>                                                   │
 *  │  📜 Log Evidence (collapsible)                            │
 *  │  💡 Suggested Fix                                         │
 *  │  ─────────────────────────────────────────────────────── │
 *  │  🤖 generated by pipeline-assistant                       │
 *  └──────────────────────────────────────────────────────────┘
 */
export async function writeJobSummary(params: JobSummaryParams): Promise<void> {
  const { jobName, commitSha, author, triggerLabel, markdownReport } = params;

  const shortSha = commitSha !== 'N/A' && commitSha.length > 7
    ? commitSha.substring(0, 7)
    : commitSha;

  // Pull named sections out of the AI report
  const rootCause =
    extractSection(markdownReport, 'Root Cause') ||
    '(See full report below)';

  const rawLog =
    extractSection(markdownReport, 'Error Log') ||
    extractSection(markdownReport, 'Log Evidence') ||
    extractSection(markdownReport, 'Log');


  const rawFix =
    extractSection(markdownReport, 'Suggested Fix') ||
    extractSection(markdownReport, 'Fix');

  const cleanLog = escapeHtml(stripCodeFences(rawLog));
  const cleanFix = escapeHtml(stripCodeFences(rawFix));

  // Log evidence goes in a collapsible <details> to keep the summary compact
  const logHtml = cleanLog
    ? `<details><summary>Click to expand log evidence</summary><pre><code>${cleanLog}</code></pre></details>`
    : '<em>No log evidence extracted.</em>';

  const fixHtml = cleanFix
    ? `<pre><code>${cleanFix}</code></pre>`
    : '<em>No specific fix suggested.</em>';

  await core.summary
    .addHeading('❌ Pipeline Failure Analysis', 1)
    .addTable([
      [
        { data: 'Failed Job', header: true },
        { data: 'Commit', header: true },
        { data: 'Author', header: true },
        { data: 'Trigger', header: true }
      ],
      [
        `<code>${escapeHtml(jobName)}</code>`,
        `<code>${escapeHtml(shortSha)}</code>`,
        escapeHtml(author || '—'),
        escapeHtml(triggerLabel)
      ]
    ])
    .addHeading('🔍 Root Cause', 3)
    .addRaw(`<p>${escapeHtml(rootCause)}</p>`)
    .addHeading('📜 Log Evidence', 3)
    .addRaw(logHtml)
    .addHeading('💡 Suggested Fix', 3)
    .addRaw(fixHtml)
    .addSeparator()
    .addRaw(
      '<p><sub>🤖 Report generated by ' +
      '<a href="https://github.com/amadalavamsi/pipeline-assistant">pipeline-assistant</a>' +
      ' via ACP + Read-Only MCP</sub></p>'
    )
    .write();

  core.info('[reporter] Job Summary written to $GITHUB_STEP_SUMMARY.');
}

// ---------------------------------------------------------------------------
// PR annotation emitter
// ---------------------------------------------------------------------------

/**
 * Emit inline code annotations on the PR diff for each file:line error found
 * in the AI-generated report.
 *
 * ⚠️  Call this ONLY when a pull-request context is present (pullNumber is set).
 *     For push-to-main triggers, skip this entirely — there is no PR diff to annotate.
 */
export function emitPrAnnotations(markdownReport: string): void {
  const annotations = parseAnnotations(markdownReport);

  if (annotations.length === 0) {
    core.info('[reporter] No file:line patterns found in report — skipping PR annotations.');
    return;
  }

  for (const annotation of annotations) {
    core.error(annotation.message, {
      title: '🤖 AI Root Cause',
      file: annotation.file,
      startLine: annotation.line
    });
  }

  core.info(`[reporter] Emitted ${annotations.length} inline annotation(s) on PR diff.`);
}
