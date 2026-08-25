/**
 * reporter.ts
 *
 * Renders ACP diagnosis into GitHub Actions outputs.
 *
 * Safety rule: the machine-readable analysis block is authoritative for
 * status/causality/confidence/annotations. If it is missing or invalid we do
 * NOT infer a diagnosis from prose. An unstructured AI answer is useful as a
 * report, but it is not trusted enough to drive badges or PR annotations.
 */

import * as core from '@actions/core';

export type DiagnosisStatus = 'CONFIRMED' | 'LIKELY' | 'UNKNOWN';
export type CommitCausality = 'INTRODUCED' | 'LIKELY_INTRODUCED' | 'PRE_EXISTING' | 'UNRELATED' | 'UNKNOWN';

export interface Annotation {
  file: string;
  line: number;
  message: string;
  severity?: 'error' | 'warning' | 'notice';
}

export interface AnalysisMetadata {
  status: DiagnosisStatus;
  confidence?: string;
  commitCausality: CommitCausality;
  rootCause?: string;
  whatChanged?: string;
  evidence?: string;
  suggestedFix?: string;
  fixPatch?: string;
  filesInvolved?: string;
  annotations: Annotation[];
  structured: boolean;
}

export interface JobSummaryParams {
  jobName: string;
  failedStep?: string;
  commitSha: string;
  author: string;
  triggerLabel: string;
  markdownReport: string;
  changedLines?: Set<string>;
}

const MACHINE_BLOCK_RE = /<!--\s*pipeline-assistant:analysis\s*\n([\s\S]*?)\n\s*-->/i;

/** Parse and validate the machine-readable block. Never trust prose for diagnosis state. */
export function parseAnalysisMetadata(markdown: string): AnalysisMetadata | null {
  const match = markdown.match(MACHINE_BLOCK_RE);
  if (!match) return null;

  try {
    const raw = JSON.parse(match[1]);
    if (!raw || typeof raw !== 'object') return null;

    const status = String(raw.diagnosis?.status || '').toUpperCase();
    const allowedStatus: DiagnosisStatus[] = ['CONFIRMED', 'LIKELY', 'UNKNOWN'];
    if (!allowedStatus.includes(status as DiagnosisStatus)) return null;

    const causality = String(raw.diagnosis?.commitCausality || '').toUpperCase();
    const allowedCausality: CommitCausality[] = [
      'INTRODUCED', 'LIKELY_INTRODUCED', 'PRE_EXISTING', 'UNRELATED', 'UNKNOWN'
    ];
    if (!allowedCausality.includes(causality as CommitCausality)) return null;

    const confidenceValue = raw.diagnosis?.confidence;
    if (typeof confidenceValue !== 'number' || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) {
      return null;
    }
    // Enforce the same confidence/status contract on the host side. This keeps
    // an inconsistent model response from becoming a misleading green badge.
    if ((status === 'CONFIRMED' && confidenceValue < 0.85) ||
        (status === 'LIKELY' && (confidenceValue < 0.60 || confidenceValue >= 0.85)) ||
        (status === 'UNKNOWN' && confidenceValue >= 0.60)) {
      return null;
    }

    const annotations: Annotation[] = Array.isArray(raw.annotations)
      ? raw.annotations
          .filter((a: any) => a && typeof a.file === 'string' && Number.isInteger(a.line) && a.line > 0 && typeof a.message === 'string')
          .slice(0, 5)
          .map((a: any) => ({
            file: normalizeRepoPath(a.file),
            line: a.line,
            message: a.message.trim(),
            severity: ['error', 'warning', 'notice'].includes(a.severity) ? a.severity : 'error'
          }))
          .filter((a: Annotation) => a.file.length > 0 && a.file.length <= 500 && a.message.length > 0 && a.message.length <= 1000)
      : [];

    return {
      status: status as DiagnosisStatus,
      confidence: `${Math.round(confidenceValue * 100)}%`,
      commitCausality: causality as CommitCausality,
      rootCause: asOptionalString(raw.rootCause?.summary),
      whatChanged: asOptionalString(raw.changeImpact?.summary),
      evidence: asOptionalString(raw.evidence?.summary),
      suggestedFix: asOptionalString(raw.fix?.summary),
      fixPatch: asOptionalString(raw.fix?.patch),
      filesInvolved: Array.isArray(raw.filesInvolved)
        ? raw.filesInvolved.filter((v: unknown) => typeof v === 'string').join('\n')
        : asOptionalString(raw.filesInvolved),
      annotations,
      structured: true
    };
  } catch {
    return null;
  }
}

function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
      if (title.toLowerCase().includes(sectionKeyword.toLowerCase())) {
        capturing = true;
        captureLevel = level;
        continue;
      }
      if (capturing && level <= captureLevel) break;
    }
    if (capturing) buffer.push(line);
  }
  return buffer.join('\n').trim();
}

/**
 * Compatibility renderer for an old/invalid agent response. It deliberately
 * marks the diagnosis as UNKNOWN and never creates annotations from prose.
 */
function parseUntrustedMarkdown(_markdown: string): AnalysisMetadata {
  return {
    status: 'UNKNOWN',
    confidence: undefined,
    commitCausality: 'UNKNOWN',
    rootCause: undefined,
    whatChanged: undefined,
    evidence: undefined,
    suggestedFix: undefined,
    filesInvolved: undefined,
    annotations: [],
    structured: false
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripMachineBlock(markdown: string): string {
  return markdown.replace(MACHINE_BLOCK_RE, '').trim();
}

function normalizeChangedLineKey(file: string, line: number): string {
  return `${normalizeRepoPath(file)}:${line}`;
}

export function stripMachineAnalysisBlock(markdown: string): string {
  return stripMachineBlock(markdown);
}

export async function writeJobSummary(params: JobSummaryParams): Promise<void> {
  const { jobName, failedStep, commitSha, author, triggerLabel, markdownReport, changedLines } = params;
  const metadata = parseAnalysisMetadata(markdownReport) || parseUntrustedMarkdown(markdownReport);
  const humanReport = stripMachineBlock(markdownReport);

  const shortSha = commitSha !== 'N/A' && commitSha.length > 7 ? commitSha.substring(0, 7) : commitSha;
  const statusBadge =
    metadata.status === 'CONFIRMED' ? '🟢 CONFIRMED' :
    metadata.status === 'LIKELY' ? '🟡 LIKELY' : '⚪ UNKNOWN / UNVERIFIED';
  const confidence = metadata.confidence || 'N/A';
  const causalityLabel = metadata.commitCausality.replace(/_/g, ' ');

  const rootCause = metadata.structured && metadata.rootCause
    ? metadata.rootCause
    : 'No machine-validated root-cause diagnosis is available. The AI output is shown below for context only.';
  const whatChanged = metadata.whatChanged;
  const evidence = metadata.evidence;
  const suggestedFix = metadata.structured ? metadata.suggestedFix : undefined;
  const filesInvolved = metadata.filesInvolved;

  let summaryBuilder = core.summary
    .addHeading('❌ Pipeline Failure Analysis', 2)
    .addTable([
      [
        { data: 'Failed Job', header: true },
        { data: 'Failed Step', header: true },
        { data: 'Commit', header: true },
        { data: 'Status', header: true },
        { data: 'Confidence', header: true },
        { data: 'Commit Causality', header: true }
      ],
      [
        `<code>${escapeHtml(jobName)}</code>`,
        `<code>${escapeHtml(failedStep || 'N/A')}</code>`,
        `<code>${escapeHtml(shortSha)}</code>`,
        `<strong>${statusBadge}</strong>`,
        `<code>${escapeHtml(confidence)}</code>`,
        escapeHtml(causalityLabel)
      ]
    ])
    .addRaw(`<p><strong>Trigger:</strong> ${escapeHtml(triggerLabel)}</p>`)
    .addRaw(`<p><strong>Author:</strong> ${escapeHtml(author)}</p>`)
    .addHeading('⚡ TL;DR', 3)
    .addRaw(`<p>${escapeHtml(rootCause).replace(/\n/g, '<br/>')}</p>`);

  if (!metadata.structured) {
    summaryBuilder = summaryBuilder.addRaw(
      '<p>⚠️ <strong>AI output was not machine-validated.</strong> Status, confidence, commit causality, and PR annotations were intentionally not inferred from prose.</p>'
    );
  }

  summaryBuilder = summaryBuilder
    .addHeading('🔍 Root Cause', 3)
    .addRaw(`<p>${escapeHtml(rootCause).replace(/\n/g, '<br/>')}</p>`);

  if (whatChanged) {
    summaryBuilder = summaryBuilder
      .addHeading('🔄 Change Impact', 3)
      .addRaw(`<p>${escapeHtml(whatChanged).replace(/\n/g, '<br/>')}</p>`);
  }

  if (evidence) {
    summaryBuilder = summaryBuilder
      .addHeading('📌 Key Evidence', 3)
      .addRaw(`<p>${escapeHtml(evidence).replace(/\n/g, '<br/>')}</p>`);
  }

  summaryBuilder = summaryBuilder
    .addHeading('📜 Full Report', 3)
    .addRaw(`<details><summary>View full ACP report</summary><pre><code>${escapeHtml(humanReport)}</code></pre></details>`)
    .addHeading('💡 Suggested Fix / Next Steps', 3)
    .addRaw(suggestedFix ? `<p>${escapeHtml(suggestedFix).replace(/\n/g, '<br/>')}</p>` : '<em>No specific fix suggested.</em>');

  if (metadata.fixPatch) {
    summaryBuilder = summaryBuilder
      .addRaw(`<pre><code>${escapeHtml(metadata.fixPatch)}</code></pre>`);
  }

  if (filesInvolved) {
    summaryBuilder = summaryBuilder
      .addHeading('📁 Files Involved', 3)
      .addRaw(`<p>${escapeHtml(filesInvolved).replace(/\n/g, '<br/>')}</p>`);
  }

  await summaryBuilder
    .addSeparator()
    .addRaw('<p><sub>🤖 Report generated by <a href="https://github.com/amadalavamsi/pipeline-assistant">pipeline-assistant</a> via Agent Client Protocol (ACP)</sub></p>')
    .write();

  core.info(`[reporter] Job Summary written. structured=${metadata.structured}, status=${metadata.status}, causality=${metadata.commitCausality}`);
}

/**
 * Emit only evidence-backed annotations. For PRs, an annotation is useful only
 * when the line is actually part of the triggering commit. This avoids pointing
 * developers at unchanged/pre-existing code as though their PR introduced it.
 */
export function emitPrAnnotations(markdownReport: string, changedLines?: Set<string>): void {
  const metadata = parseAnalysisMetadata(markdownReport);
  if (!metadata) {
    core.info('[reporter] No structured analysis block; skipping PR annotations.');
    return;
  }

  // LIKELY/UNKNOWN diagnoses are intentionally not annotated inline. An inline
  // red error marker is too strong a signal when the model has not established it.
  if (metadata.status !== 'CONFIRMED') {
    core.info(`[reporter] Diagnosis is ${metadata.status}; skipping PR annotations to avoid false positives.`);
    return;
  }

  if (!changedLines || changedLines.size === 0) {
    core.info('[reporter] No trigger-commit changed-line map; skipping PR annotations.');
    return;
  }

  const validated = metadata.annotations.filter(a => changedLines.has(normalizeChangedLineKey(a.file, a.line)));
  if (validated.length === 0) {
    core.info('[reporter] No annotations point to lines changed by the triggering commit; skipping PR annotations.');
    return;
  }

  for (const annotation of validated) {
    core.error(annotation.message, {
      title: '🤖 AI Root Cause',
      file: annotation.file,
      startLine: annotation.line,
      endLine: annotation.line
    });
  }

  core.info(`[reporter] Emitted ${validated.length} evidence-backed AI annotation(s).`);
}
