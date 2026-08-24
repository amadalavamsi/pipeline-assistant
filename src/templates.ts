import * as fs from 'fs';
import * as path from 'path';

export function getSystemPrompt(variables: Record<string, string> = {}): string {
  const templatePath = path.join(__dirname, '../templates/system-prompt.txt');

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `[templates] system-prompt.txt not found at: ${templatePath}\n` +
      `Ensure the templates/ directory is present alongside dist/.`
    );
  }

  let content = fs.readFileSync(templatePath, 'utf8');

  for (const [key, value] of Object.entries(variables)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  return content;
}

export function formatReportTemplate(variables: {
  jobName: string;
  commitSha: string;
  author: string;
  rootCause: string;
  logEvidence: string;
  suggestedFix: string;
}): string {
  const templatePath = path.join(__dirname, '../templates/report-template.md');
  let content = '';

  if (fs.existsSync(templatePath)) {
    content = fs.readFileSync(templatePath, 'utf8');
  } else {
    content = `## Failure Summary

❌ {{jobName}}

## Diagnosis

- **Status**: UNKNOWN
- **Confidence**: 40%

## Root Cause

{{rootCause}}

## What Changed

Commit \`{{commitSha}}\` by \`{{author}}\`

## Evidence

\`\`\`text
{{logEvidence}}
\`\`\`

## Suggested Fix / Next Steps

{{suggestedFix}}

## Files Involved

- \`{{jobName}}\``;
  }

  for (const [key, value] of Object.entries(variables)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  return content;
}
