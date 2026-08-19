import * as fs from 'fs';
import * as path from 'path';

export function getSystemPrompt(variables: Record<string, string> = {}): string {
  const templatePath = path.join(__dirname, '../templates/system-prompt.txt');
  let content = '';

  if (fs.existsSync(templatePath)) {
    content = fs.readFileSync(templatePath, 'utf8');
  }
  //   } else {
  //     // Fallback embedded prompt if running in standalone bundled dist
  //     content = `You are an expert DevOps and CI/CD triage assistant.
  // Analyze the provided sanitized failure log and recent commit code diff.
  // Diagnose the failure root cause and provide actionable guidance.

  // Strict requirements:
  // 1. Provide a concise 2-3 sentence Root Cause diagnosis.
  // 2. Provide the exact Log Evidence (with relevant error line numbers).
  // 3. Provide a Suggested Fix with exact code or configuration snippet.
  // 4. Output cleanly in formatted Markdown matching this schema:

  // ### ❌ Pipeline Failure Analysis
  // - **Failed Job**: \`{{jobName}}\`
  // - **Commit**: \`{{commitSha}}\` by \`{{author}}\`

  // #### 🔍 Root Cause
  // <Clear, actionable 2-sentence explanation>

  // #### 📜 Log Evidence
  // \`\`\`text
  // <Relevant stack trace or error log snippet>
  // \`\`\`

  // #### 💡 Suggested Fix
  // <Exact solution or code correction>`;
  //   }

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
    content = `### ❌ Pipeline Failure Analysis
- **Failed Job**: \`{{jobName}}\`
- **Commit**: \`{{commitSha}}\` by \`{{author}}\`

#### 🔍 Root Cause
{{rootCause}}

#### 📜 Log Evidence
\`\`\`text
{{logEvidence}}
\`\`\`

#### 💡 Suggested Fix
{{suggestedFix}}`;
  }

  for (const [key, value] of Object.entries(variables)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  return content;
}
