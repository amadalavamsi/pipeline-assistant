import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { createReadOnlyMcpServer } from './mcp-tools';
import { AcpClientBridge } from './acp-client';
import { parseCliArgs } from './cli-parser';
import { getSystemPrompt, formatReportTemplate } from './templates';
import { sanitizeText, extractErrorLogWindow } from './sanitizer';
import { ProtocolLogger } from './logger';

const BOT_COMMENT_SIGNATURE = '<!-- pipeline-assistant-report -->';

async function run(): Promise<void> {
  try {
    const cliOptions = parseCliArgs(process.argv.slice(2));

    const githubToken =
      core.getInput('github-token', { required: false }) ||
      process.env.GITHUB_TOKEN ||
      'dummy-local-token';

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    const owner = cliOptions.owner || context.repo?.owner || process.env.GITHUB_REPOSITORY_OWNER || 'local-owner';
    const repo = cliOptions.repo || context.repo?.repo || (process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'local-repo');
    const runId = cliOptions.runId || context.runId || 0;
    const pullNumber = cliOptions.pullNumber || context.payload?.pull_request?.number;
    const maxDiffLines = parseInt(core.getInput('max-diff-lines', { required: false }) || '2000', 10);
    const agentCommand = core.getInput('agent-command', { required: false }) || 'copilot';
    const agentArgsInput = core.getInput('agent-args', { required: false }) || ' --acp --stdio';
    const agentArgs = agentArgsInput.split(' ').filter(Boolean);

    console.log(`\n🔍 Pipeline Assistant (ACP + Read-Only MCP)`);
    console.log(`📁 Target: ${owner}/${repo} | Run ID: ${runId || 'N/A'} | PR: #${pullNumber || 'N/A'}`);
    console.log(`📝 Full debug log → ${ProtocolLogger.getLogFilePath()}`);
    if (cliOptions.noExecute) {
      console.log(`🛡️ Mode: --no-execute (Dry-run mode: fetch & sanitize data, skip AI execution/commenting)`);
    }

    // -----------------------------------------------------------------------
    // Step 1: Create a single MCP server instance (reused across the entire run)
    // -----------------------------------------------------------------------
    const mcpServer = createReadOnlyMcpServer(octokit, {
      owner,
      repo,
      runId,
      pullNumber,
      maxDiffLines
    });

    // -----------------------------------------------------------------------
    // Step 2: Offline / local file testing support
    // When --log-file or --diff-file are provided we pre-populate context so
    // the agent's prompt references real data even without a live GitHub run.
    // -----------------------------------------------------------------------
    let offlineErrorLog = '';
    let offlineDiffSnippet = '';

    if (cliOptions.logFile && fs.existsSync(cliOptions.logFile)) {
      console.log(`📂 Reading local log file: ${cliOptions.logFile}`);
      const rawLog = fs.readFileSync(cliOptions.logFile, 'utf8');
      offlineErrorLog = extractErrorLogWindow(sanitizeText(rawLog), 120);
    }

    if (cliOptions.diffFile && fs.existsSync(cliOptions.diffFile)) {
      console.log(`📂 Reading local diff file: ${cliOptions.diffFile}`);
      const rawDiff = fs.readFileSync(cliOptions.diffFile, 'utf8');
      offlineDiffSnippet = sanitizeText(rawDiff).split('\n').slice(0, maxDiffLines).join('\n');
    }

    // -----------------------------------------------------------------------
    // Step 3: Build system prompt and user prompt
    // In live CI mode the prompt instructs the agent to call MCP tools itself.
    // In offline/dry-run mode the pre-read file data is injected directly.
    // -----------------------------------------------------------------------
    const isLiveCi = runId > 0 && githubToken !== 'dummy-local-token';
    const hasPullRequest = Boolean(pullNumber);

    const systemPrompt = getSystemPrompt({
      jobName: 'CI-Job',
      commitSha: 'HEAD',
      author: 'developer'
    });

    let userPrompt: string;

    if (isLiveCi) {
      // Agent will call MCP tools at inference time to obtain the real data
      userPrompt = `You are analysing a failed GitHub Actions workflow run.

Available MCP tools you MUST call to gather evidence before writing your report:
- \`get_failed_job_logs\` — fetches sanitized logs from the failed job
- \`get_commit_metadata\` — fetches the commit SHA, author, and commit message
${hasPullRequest
          ? `- \`get_pull_request_diff\` — fetches the PR code diff (pull request #${pullNumber} is open)`
          : `- \`get_latest_commit_diff\` — fetches the diff of the latest commit (no PR associated with this run)`
        }

Workflow context:
- Repository: ${owner}/${repo}
- Run ID: ${runId}
${hasPullRequest ? `- Pull Request: #${pullNumber}` : '- Trigger: push (no PR)'}

Instructions:
1. Call the MCP tools listed above to collect the failure log, commit metadata, and code diff.
2. Analyse the data you retrieve.
3. Output your report strictly in the Markdown schema defined in the system prompt.`;
    } else {
      // Offline / local mode — inject pre-read file data directly
      const errorLogSection = offlineErrorLog ||
        '[Sample Error Log Window]\nError: Process completed with exit code 1.\nAssertionError: expected true to equal false\n  at UserServiceTest.ts:42';
      const diffSection = offlineDiffSnippet || 'No diff available.';

      userPrompt = `Failed Job Context:
Job Name: CI-Job
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

    // -----------------------------------------------------------------------
    // Step 4: Handle --no-execute (dry-run mode)
    // -----------------------------------------------------------------------
    if (cliOptions.noExecute) {
      console.log('\n--- [DRY-RUN SYSTEM PROMPT] ---');
      console.log(systemPrompt);
      console.log('\n--- [DRY-RUN USER PROMPT] ---');
      console.log(userPrompt);
      console.log('\n✅ Dry-run completed successfully. (No AI execution or PR comments made)');
      return;
    }

    // -----------------------------------------------------------------------
    // Step 5: Launch ACP Agent and run the full protocol handshake
    // -----------------------------------------------------------------------
    console.log(`🤖 Starting ACP Agent Process: ${agentCommand} ${agentArgs.join(' ')}`);
    const acpBridge = new AcpClientBridge({
      workspacePath: process.cwd(),
      agentCommand,
      agentArgs,
      mcpServer
    });

    let markdownReport = '';

    try {
      await acpBridge.start();

      // Step 5a: Initialize Protocol
      // protocolVersion: integer (this agent validates it as a number type)
      await acpBridge.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'pipeline-assistant', version: '1.0.0' },
        capabilities: {
          readOnly: true,
          terminalExecution: false,
          fileModification: false
        }
      });

      // Step 5b: Create Session
      // mcpServers must be empty — our MCP server is in-process and responds to
      // mcp/callTool requests directly via the ACP bridge. The agent discovers
      // tools via tools/list (handled in acp-client.ts handleAgentRequest).
      console.log('🔄 Creating new ACP Session (session/new)...');
      let sessionId: string | undefined;
      try {
        const sessionRes = await acpBridge.sendRequest('session/new', {
          cwd: process.cwd(),
          mcpServers: []
        });
        if (sessionRes?.sessionId) {
          sessionId = sessionRes.sessionId;
          console.log(`✅ Session created: ${sessionId}`);
        }
      } catch (sessErr: unknown) {
        console.warn(`[ACP Notice] session/new failed, will prompt without sessionId: ${(sessErr as Error).message}`);
      }

      // Step 5c: Send prompt to agent
      // Primary format: prompt as a content array (ACP standard)
      // Fallback format: messages array (OpenAI-compatible agents)
      console.log('🧠 Prompting ACP Agent for Root Cause & Evidence Analysis...');
      acpBridge.clearStreamedText();

      let promptResponse: any = null;
      // Only include sessionId if session/new actually succeeded
      const promptParams = (id: string | undefined, extra: Record<string, unknown>) =>
        id ? { sessionId: id, ...extra } : extra;

      try {
        promptResponse = await acpBridge.sendRequest('session/prompt',
          promptParams(sessionId, {
            prompt: [
              {
                type: 'text',
                text: `${systemPrompt}\n\n${userPrompt}`
              }
            ]
          })
        );
      } catch {
        // Fallback: some agents accept OpenAI-style messages array
        console.warn('[ACP Notice] session/prompt (prompt array) failed — retrying with messages format...');
        promptResponse = await acpBridge.sendRequest('session/prompt',
          promptParams(sessionId, {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          })
        );
      }

      const streamedText = acpBridge.getStreamedText();
      markdownReport =
        streamedText ||
        promptResponse?.content ||
        promptResponse?.result?.content ||
        promptResponse?.text ||
        '';

      if (typeof markdownReport === 'object') {
        markdownReport = JSON.stringify(markdownReport, null, 2);
      }
    } catch (acpErr: unknown) {
      const error = acpErr as Error;
      console.warn(`[ACP Process Notification] ${error.message}`);
      markdownReport = formatReportTemplate({
        jobName: 'CI-Job',
        commitSha: 'N/A',
        author: 'N/A',
        rootCause: 'Analysis of the failure logs identified build or test errors. Inspect the extract below.',
        logEvidence: offlineErrorLog || '(no log data available in fallback)',
        suggestedFix: 'Review the failing lines in the commit diff against the assertion requirements.'
      });
    } finally {
      acpBridge.stop();
    }

    // -----------------------------------------------------------------------
    // Step 6: Print and save the report
    // -----------------------------------------------------------------------
    const reportFile = path.join(process.cwd(), 'analysis-report.md');

    if (!markdownReport) {
      console.warn('\n⚠️  [WARNING] Markdown report is empty — the ACP agent produced no output.');
      console.warn(`    Check the full debug log for details: ${ProtocolLogger.getLogFilePath()}`);
      markdownReport = formatReportTemplate({
        jobName: 'CI-Job',
        commitSha: 'N/A',
        author: 'N/A',
        rootCause: 'ACP agent produced no output. The agent may have timed out or failed silently.',
        logEvidence: offlineErrorLog || '(no log data — check acp-debug.log)',
        suggestedFix: `Review acp-debug.log for the full ACP protocol trace: ${ProtocolLogger.getLogFilePath()}`
      });
    }

    console.log('\n--- [GENERATED MARKDOWN REPORT] ---');
    console.log(markdownReport);

    fs.writeFileSync(reportFile, markdownReport, 'utf8');
    console.log(`\n📄 Report saved → ${reportFile}`);

    // -----------------------------------------------------------------------
    // Step 6: Post or update the PR comment (live CI only)
    // -----------------------------------------------------------------------
    if (pullNumber && markdownReport && !cliOptions.noExecute && githubToken !== 'dummy-local-token') {
      console.log(`💬 Posting diagnostic report to PR #${pullNumber}...`);
      const fullCommentBody = `${BOT_COMMENT_SIGNATURE}\n${markdownReport}\n\n---\n*Report generated by [pipeline-assistant](https://github.com/amadalavamsi/pipeline-assistant) via Agent Client Protocol (ACP) & Read-Only MCP.*`;

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
        console.log(`🔄 Updated existing comment #${existingComment.id}`);
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: fullCommentBody
        });
        console.log('✨ Created new PR comment with failure diagnosis.');
      }
    }

    core.setOutput('failed-job-name', 'CI-Job');
    core.setOutput('analysis-report', markdownReport);
    console.log('🎉 Pipeline Assistant completed successfully.');

  } catch (error: unknown) {
    const err = error as Error;
    core.setFailed(`pipeline-assistant failed: ${err.message}`);
  }
}

run();
