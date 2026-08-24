/**
 * reporter.ts
 *
 * Renders the ACP diagnosis into GitHub Actions outputs.
 *
 * ACP is asked to emit a machine-readable JSON block in addition to Markdown.
 * The JSON is authoritative for status/confidence/causality/annotations;
 * Markdown remains the human-readable report and is used as a compatibility
 * fallback when an older agent does not emit the JSON block.
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
  filesInvolved?: string;
  annotations: Annotation[];
}

export interface JobSummaryParams {
  jobName: string;
  failedStep?: string;
  commitSha: string;
  author: string;
  triggerLabel: string;
  markdownReport: string;
}

const MACHINE_BLOCK_RE = /<!--\s*pipeline-assistant:analysis\s*\n([\s\S]*?)\n\s*-->/i;

/**
 * Extract and validate the machine-readable analysis block emitted by ACP.
 * Invalid/missing blocks deliberately fall back to Markdown parsing.
 */
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

    const annotations: Annotation[] = Array.isArray(raw.annotations)
      ? raw.annotations
          .filter((a: any) => a && typeof a.file === 'string' && Number.isInteger(a.line) && a.line > 0 && typeof a.message === 'string')
          .slice(0, 5)
          .map((a: any) => ({
            file: a.file.trim(),
            line: a.line,
            message: a.message.trim(),
            severity: ['error', 'warning', 'notice'].includes(a.severity) ? a.severity : 'error'
          }))
      : [];

    return {
      status: status as DiagnosisStatus,
      confidence: normalizeConfidence(raw.diagnosis?.confidence),
      commitCausality: causality as CommitCausality,
      rootCause: asOptionalString(raw.rootCause?.summary),
      whatChanged: asOptionalString(raw.changeImpact?.summary),
      evidence: asOptionalString(raw.evidence?.summary),
      suggestedFix: asOptionalString(raw.fix?.summary),
      filesInvolved: Array.isArray(raw.filesInvolved)
        ? raw.filesInvolved.filter((v: unknown) => typeof v === 'string').join('\n')
        : asOptionalString(raw.filesInvolved),
      annotations
    };
  } catch {
    return null;
  }
}

function normalizeConfidence(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const pct = value <= 1 ? value * 100 : value;
    return `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Legacy Markdown parser (compatibility fallback only)
// ---------------------------------------------------------------------------

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

function parseLegacyMetadata(markdown: string): AnalysisMetadata {
  const diagnosisSection = extractSection(markdown, 'Diagnosis');
  let status: DiagnosisStatus = 'UNKNOWN';

  if (/^\s*(?:[-*]\s*)?\*?Status\*?\s*:\s*CONFIRMED\b/im.test(diagnosisSection)) status = 'CONFIRMED';
  else if (/^\s*(?:[-*]\s*)?\*?Status\*?\s*:\s*LIKELY\b/im.test(diagnosisSection)) status = 'LIKELY';

  const confidenceMatch = diagnosisSection.match(/^\s*(?:[-*]\s*)?\*?Confidence\*?\s*:\s*([^\n\r]+)/im);
  const causalityMatch = markdown.match(/^\s*(?:[-*]\s*)?\*?(?:Commit Causality|Regression)\*?\s*:\s*([^\n\r]+)/im);
  const causalityText = (causalityMatch?.[1] || '').toUpperCase();
  const commitCausality: CommitCausality = causalityText.includes('INTRODUCED')
    ? (causalityText.includes('LIKELY') ? 'LIKELY_INTRODUCED' : 'INTRODUCED')
    : causalityText.includes('PRE_EXISTING') || causalityText.includes('PRE-EXISTING')
      ? 'PRE_EXISTING'
      : causalityText.includes('UNRELATED')
        ? 'UNRELATED'
        : 'UNKNOWN';

  return {
    status,
    confidence: confidenceMatch?.[1]?.trim(),
    commitCausality,
    rootCause: extractSection(markdown, 'Root Cause') || undefined,
    whatChanged: extractSection(markdown, 'What Changed') || undefined,
    evidence: extractSection(markdown, 'Evidence') || extractSection(markdown, 'Log Evidence') || undefined,
    suggestedFix: extractSection(markdown, 'Suggested Fix') || extractSection(markdown, 'Next Steps') || undefined,
    filesInvolved: extractSection(markdown, 'Files Involved') || undefined,
    annotations: []
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

// ---------------------------------------------------------------------------
// Job Summary writer
// ---------------------------------------------------------------------------

export async function writeJobSummary(params: JobSummaryParams): Promise<void> {
  const { jobName, failedStep, commitSha, author, triggerLabel, markdownReport } = params;
  const metadata = parseAnalysisMetadata(markdownReport) || parseLegacyMetadata(markdownReport);
  const humanReport = stripMachineBlock(markdownReport);

  const shortSha = commitSha !== 'N/A' && commitSha.length > 7 ? commitSha.substring(0, 7) : commitSha;
  const statusBadge =
    metadata.status === 'CONFIRMED' ? '🟢 CONFIRMED' :
    metadata.status === 'LIKELY' ? '🟡 LIKELY' : '⚪ UNKNOWN';
  const confidence = metadata.confidence || 'N/A';
  const causalityLabel = metadata.commitCausality.replace(/_/g, ' ');

  const rootCause = metadata.rootCause || '(See full report below)';
  const whatChanged = metadata.whatChanged;
  const evidence = metadata.evidence;
  const suggestedFix = metadata.suggestedFix;
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
      ]
    )
    .addHeading('⚡ TL;DR', 3)
    .addRaw(`<p>${escapeHtml(rootCause)}</p>`)
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
    .addRaw(suggestedFix ? `<pre><code>${escapeHtml(suggestedFix)}</code></pre>` : '<em>No specific fix suggested.</em>');

  if (filesInvolved) {
    summaryBuilder = summaryBuilder
      .addHeading('📁 Files Involved', 3)
      .addRaw(`<p>${escapeHtml(filesInvolved).replace(/\n/g, '<br/>')}</p>`);
  }

  await summaryBuilder
    .addSeparator()
    .addRaw(
      '<p><sub>🤖 Report generated by ' +
      '<a href="https://github.com/amadalavamsi/pipeline-assistant">pipeline-assistant</a>' +
      ' via Agent Client Protocol (ACP)</sub></p>'
    )
    .write();

  core.info(`[reporter] Job Summary written. status=${metadata.status}, causality=${metadata.commitCausality}`);
}

// ---------------------------------------------------------------------------
// PR annotation emitter
// ---------------------------------------------------------------------------

export function emitPrAnnotations(markdownReport: string): void {
  const metadata = parseAnalysisMetadata(markdownReport);
  if (!metadata) {
    core.info('[reporter] No structured analysis block; skipping PR annotations rather than guessing from prose.');
    return;
  }

  if (metadata.annotations.length === 0) {
    core.info('[reporter] No structured annotations returned — skipping PR annotations.');
    return;
  }

  for (const annotation of metadata.annotations) {
    core.error(annotation.message, {
      title: '🤖 AI Root Cause',
      file: annotation.file,
      startLine: annotation.line,
      endLine: annotation.line
    });
  }

  core.info(`[reporter] Emitted ${metadata.annotations.length} validated AI annotation(s).`);
}
