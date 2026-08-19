import * as core from '@actions/core';
import * as github from '@actions/github';
import { createReadOnlyMcpServer } from './mcp-tools';
import { AcpClientBridge } from './acp-client';

const BOT_COMMENT_SIGNATURE = '<!-- pipeline-assistant-report -->';

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', { required: false }) || process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN is required for pipeline-assistant.');
    }

    const octokit = github.getOctokit(githubToken);
    const context = github.context;
    const { owner, repo } = context.repo;
    const runId = context.runId;
    const pullNumber = context.payload.pull_request?.number;
    const maxDiffLines = parseInt(core.getInput('max-diff-lines', { required: false }) || '2000', 10);
    const agentCommand = core.getInput('agent-command', { required: false }) || 'copilot';
    const agentArgsInput = core.getInput('agent-args', { required: false }) || 'acp-server';
    const agentArgs = agentArgsInput.split(' ').filter(Boolean);

    core.info(`🔍 Initializing Pipeline Assistant (ACP + MCP Engine)...`);
    core.info(`📁 Repository: ${owner}/${repo} | Run ID: ${runId} | PR: #${pullNumber || 'N/A'}`);

    // Step 1: Initialize In-Memory Read-Only MCP Server
    const mcpServer = createReadOnlyMcpServer(octokit, {
      owner,
      repo,
      runId,
      pullNumber,
      maxDiffLines
    });

    // Step 2: Fetch Context Data via MCP Tools
    core.info('📡 Invoking MCP Tools to gather failure context...');
    const logDataJson = await mcpServer.executeTool('get_failed_job_logs', {});
    const logData = JSON.parse(logDataJson);

    if (logData.message && logData.message.includes('No failed jobs found')) {
      core.info('✅ No failed jobs detected. Pipeline Assistant run complete.');
      return;
    }

    let diffSnippet = 'N/A (No PR context)';
    if (pullNumber) {
      const diffDataJson = await mcpServer.executeTool('get_pull_request_diff', { maxLines: maxDiffLines });
      const diffData = JSON.parse(diffDataJson);
      diffSnippet = diffData.diffSnippet || 'No diff retrieved.';
    }

    const commitMetaJson = await mcpServer.executeTool('get_commit_metadata', {});
    const commitMeta = JSON.parse(commitMetaJson);

    // Step 3: Start ACP Agent Subprocess with MCP Server Hook
    core.info(`🤖 Starting ACP Agent Process: ${agentCommand} ${agentArgs.join(' ')}`);
    const acpBridge = new AcpClientBridge({
      workspacePath: process.cwd(),
      agentCommand,
      agentArgs,
      mcpServer
    });

    let markdownReport = '';

    try {
      await acpBridge.start();

      // Step 4: Initialize Session & Send Diagnostic Prompt
      await acpBridge.sendRequest('initialize', {
        protocolVersion: '1.0',
        clientInfo: { name: 'pipeline-assistant', version: '1.0.0' },
        capabilities: {
          readOnly: true,
          terminalExecution: false,
          fileModification: false,
          mcpTools: mcpServer.listTools()
        }
      });

      core.info('🧠 Prompting ACP Agent for Root Cause & Evidence Analysis...');
      const systemInstructions = `You are an expert DevOps and CI/CD triage assistant.
Analyze the provided sanitized failure log and recent commit code diff.
Diagnose the failure root cause and provide actionable guidance.

Strict requirements:
1. Provide a concise 2-3 sentence Root Cause diagnosis.
2. Provide the exact Log Evidence (with relevant error line numbers).
3. Provide a Suggested Fix with exact code or configuration snippet.
4. Output cleanly in formatted Markdown matching this schema:

### ❌ Pipeline Failure Analysis
- **Failed Job**: \`${logData.jobName || 'Unknown'}\`
- **Commit**: \`${commitMeta.commitSha?.substring(0, 7) || 'N/A'}\` by \`${commitMeta.author || 'dev'}\`

#### 🔍 Root Cause
<Clear, actionable 2-sentence explanation>

#### 📜 Log Evidence
\`\`\`text
<Relevant stack trace or error log snippet>
\`\`\`

#### 💡 Suggested Fix
<Exact solution or code correction>
`;

      const promptPayload = `Failed Job Context:
Job Name: ${logData.jobName}
Error Log Window:
\`\`\`
${logData.errorLogWindow || 'No log window available'}
\`\`\`

Pull Request Diff Snippet:
\`\`\`diff
${diffSnippet}
\`\`\`

Commit Message: ${commitMeta.commitMessage}
`;

      const promptResponse = await acpBridge.sendRequest('agent/prompt', {
        system: systemInstructions,
        prompt: promptPayload
      });

      markdownReport = promptResponse?.content || promptResponse?.result?.content || promptResponse?.text || '';

      if (typeof markdownReport === 'object') {
        markdownReport = JSON.stringify(markdownReport, null, 2);
      }
    } catch (acpErr: unknown) {
      const error = acpErr as Error;
      core.warning(`ACP Agent prompt execution note: ${error.message}`);
      // Clean fallback formatting if ACP server runs in headless non-interactive mode
      markdownReport = `### ❌ Pipeline Failure Analysis
- **Failed Job**: \`${logData.jobName || 'CI'}\`
- **Commit**: \`${commitMeta.commitSha?.substring(0, 7) || 'Latest'}\` by \`${commitMeta.author || 'Author'}\`

#### 🔍 Root Cause
Analysis of the job logs identified failure during execution. Inspect the error log extract below.

#### 📜 Log Evidence
\`\`\`text
${logData.errorLogWindow || 'Error log extract unavailable'}
\`\`\`

#### 💡 Suggested Fix
Check latest commit changes against the failed assertions or permission constraints.`;
    } finally {
      acpBridge.stop();
    }

    // Step 5: Post or Update Comment on Pull Request (Idempotent)
    if (pullNumber && markdownReport) {
      core.info(`💬 Posting diagnostic report to PR #${pullNumber}...`);
      const fullCommentBody = `${BOT_COMMENT_SIGNATURE}\n${markdownReport}\n\n---\n*Report generated by [pipeline-assistant](https://github.com/amadalavamsi/pipeline-assistant) via Agent Client Protocol (ACP) & MCP.*`;

      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber
      });

      const existingComment = comments.data.find(c => c.body?.includes(BOT_COMMENT_SIGNATURE));

      if (existingComment) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: fullCommentBody
        });
        core.info(`🔄 Updated existing comment #${existingComment.id}`);
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: fullCommentBody
        });
        core.info('✨ Created new PR comment with failure diagnosis.');
      }
    }

    // Step 6: Set Outputs
    core.setOutput('failed-job-name', logData.jobName || '');
    core.setOutput('analysis-report', markdownReport);
    core.info('🎉 Pipeline Assistant completed successfully.');

  } catch (error: unknown) {
    const err = error as Error;
    core.setFailed(`pipeline-assistant failed: ${err.message}`);
  }
}

run();
