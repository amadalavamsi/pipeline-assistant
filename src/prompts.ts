/**
 * prompts.ts
 *
 * All user-prompt construction logic lives here.
 * Prompt engineers edit ONLY this file — never index.ts.
 *
 * Two modes:
 *   buildLiveCiUserPromptWithData — live CI runs: data pre-fetched by index.ts, embedded directly
 *   buildOfflineUserPrompt        — local CLI testing: data from --log-file / --diff-file flags
 *
 * NOTE: The copilot CLI manages its own tool ecosystem (github-mcp-server) and does NOT
 * call back to our in-process MCP bridge. Pre-embedding all data is the correct architecture.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveCiContext {
  owner: string;
  repo: string;
  runId: number;
  hasPullRequest: boolean;
  pullNumber?: number;
}

export interface LiveCiDataContext {
  owner: string;
  repo: string;
  runId: number;
  commitSha: string;
  commitMessage: string;
  author: string;
  jobName: string;
  errorLog: string;
  diffSnippet: string;
  hasPullRequest: boolean;
  pullNumber?: number;
}

export interface OfflineContext {
  errorLog: string;
  diffSnippet: string;
  jobName: string;
}

// ---------------------------------------------------------------------------
// Live CI prompt with pre-fetched data (primary mode)
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for a live CI run with ALL data pre-fetched and embedded.
 *
 * This avoids requiring the ACP agent to make MCP tool calls back to our
 * in-process server. The copilot CLI manages its own tool ecosystem
 * (github-mcp-server) and does NOT call back to our bridge's tools/list endpoint.
 * Pre-embedding the data is the correct headless/CI architecture.
 */
export function buildLiveCiUserPromptWithData(ctx: LiveCiDataContext): string {
  const { owner, repo, runId, commitSha, commitMessage, author, jobName,
          errorLog, diffSnippet, hasPullRequest, pullNumber } = ctx;

  const prLine = hasPullRequest
    ? `- Pull Request: #${pullNumber}`
    : `- Trigger: push (no PR)`;

  const diffSection = diffSnippet
    ? `\`\`\`diff\n${diffSnippet}\n\`\`\``
    : '_No diff available for this run._';

  const errorSection = errorLog
    ? `\`\`\`text\n${errorLog}\n\`\`\``
    : '_No error log available._';

  return `You are analysing a failed GitHub Actions workflow run.
All evidence has been pre-fetched for you below — do NOT attempt to call any external tools.

## Workflow Context
- Repository: ${owner}/${repo}
- Run ID: ${runId}
- Failed Job: \`${jobName}\`
- Commit: \`${commitSha.substring(0, 7)}\` by ${author}
- Commit Message: ${commitMessage || '(none)'}
${prLine}

## Failure Log (sanitized, error window)
${errorSection}

## Code Diff (latest commit)
${diffSection}

## Instructions
1. Analyse the failure log and code diff provided above.
2. Identify the root cause of the pipeline failure.
3. Output your report strictly in the Markdown schema defined in the system prompt.`;
}

// ---------------------------------------------------------------------------
// Offline / local CLI prompt
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for local CLI testing.
 * Pre-read file contents are injected directly; no MCP tool calls are made.
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

// Keep for backwards compatibility / legacy references
export function buildLiveCiUserPrompt(ctx: LiveCiContext): string {
  return `[Legacy prompt — use buildLiveCiUserPromptWithData instead]
Repository: ${ctx.owner}/${ctx.repo}, Run: ${ctx.runId}`;
}
