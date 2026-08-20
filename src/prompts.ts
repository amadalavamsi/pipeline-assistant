/**
 * prompts.ts
 *
 * All user-prompt construction logic lives here.
 * Prompt engineers edit ONLY this file — never index.ts.
 *
 * Two modes:
 *   buildLiveCiUserPrompt  — for live GitHub Actions runs (agent calls MCP tools at inference time)
 *   buildOfflineUserPrompt — for local CLI testing (pre-read file data injected directly)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveCiContext {
  /** GitHub repository owner (org or username) */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** GitHub Actions workflow run ID */
  runId: number;
  /** True when this run is associated with an open pull request */
  hasPullRequest: boolean;
  /** Pull request number (present only when hasPullRequest is true) */
  pullNumber?: number;
}

export interface OfflineContext {
  /** Pre-sanitized error log window from a local log file */
  errorLog: string;
  /** Pre-sanitized diff snippet from a local diff file */
  diffSnippet: string;
  /** Job name to include in the prompt */
  jobName: string;
}

// ---------------------------------------------------------------------------
// Live CI prompt
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for a live GitHub Actions run.
 *
 * The agent is instructed to call MCP tools at inference time to gather
 * the real failure log, commit metadata, and code diff before writing the report.
 */
export function buildLiveCiUserPrompt(ctx: LiveCiContext): string {
  const { owner, repo, runId, hasPullRequest, pullNumber } = ctx;

  const diffToolLine = hasPullRequest
    ? `- \`get_pull_request_diff\` — fetches the PR code diff (pull request #${pullNumber} is open)`
    : `- \`get_latest_commit_diff\` — fetches the diff of the latest commit (no PR associated with this run)`;

  const prLine = hasPullRequest
    ? `- Pull Request: #${pullNumber}`
    : `- Trigger: push (no PR)`;

  return `You are analysing a failed GitHub Actions workflow run.

Available MCP tools you MUST call to gather evidence before writing your report:
- \`get_failed_job_logs\` — fetches sanitized logs from the failed job
- \`get_commit_metadata\` — fetches the commit SHA, author, and commit message
${diffToolLine}

Workflow context:
- Repository: ${owner}/${repo}
- Run ID: ${runId}
${prLine}

Instructions:
1. Call the MCP tools listed above to collect the failure log, commit metadata, and code diff.
2. Analyse the data you retrieve.
3. Output your report strictly in the Markdown schema defined in the system prompt.`;
}

// ---------------------------------------------------------------------------
// Offline / local CLI prompt
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for local CLI testing.
 *
 * Pre-read file contents are injected directly; no MCP tool calls are made.
 * Typically used with --log-file and --diff-file CLI flags.
 */
export function buildOfflineUserPrompt(ctx: OfflineContext): string {
  const { errorLog, diffSnippet, jobName } = ctx;

  const errorLogSection = errorLog ||
    '[Sample Error Log Window]\nError: Process completed with exit code 1.\n' +
    'AssertionError: expected true to equal false\n  at UserServiceTest.ts:42';

  const diffSection = diffSnippet || 'No diff available.';

  return `Failed Job Context:
Job Name: ${jobName}
Error Log Window:
\`\`\`
${errorLogSection}
\`\`\`

Pull Request Diff Snippet:
\`\`\`diff
${diffSection}
\`\`\`

Commit Message: Local CLI trigger`;
}
