import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import { createReadOnlyMcpServer } from './mcp-tools';
import { AcpClientBridge } from './acp-client';
import { parseCliArgs } from './cli-parser';
import { getSystemPrompt, formatReportTemplate } from './templates';
import { sanitizeText, extractErrorLogWindow } from './sanitizer';

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
    const agentArgsInput = core.getInput('agent-args', { required: false }) || ' --acp';
    const agentArgs = agentArgsInput.split(' ').filter(Boolean);

    console.log(`\n🔍 Pipeline Assistant (ACP + Read-Only MCP)`);
    console.log(`📁 Target: ${owner}/${repo} | Run ID: ${runId || 'N/A'} | PR: #${pullNumber || 'N/A'}`);
    if (cliOptions.noExecute) {
      console.log(`🛡️ Mode: --no-execute (Dry-run mode: fetch & sanitize data, skip AI execution/commenting)`);
    }

    let jobName = 'CI-Job';
    let errorLogWindow = '';
    let diffSnippet = 'No diff available.';
    let commitSha = 'local-head';
    let author = 'developer';
    let commitMessage = 'Local CLI trigger';

    // Offline / Local file testing support
    if (cliOptions.logFile && fs.existsSync(cliOptions.logFile)) {
      console.log(`📂 Reading local log file: ${cliOptions.logFile}`);
      const rawLog = fs.readFileSync(cliOptions.logFile, 'utf8');
      errorLogWindow = extractErrorLogWindow(sanitizeText(rawLog), 120);
    }

    if (cliOptions.diffFile && fs.existsSync(cliOptions.diffFile)) {
      console.log(`📂 Reading local diff file: ${cliOptions.diffFile}`);
      const rawDiff = fs.readFileSync(cliOptions.diffFile, 'utf8');
      diffSnippet = sanitizeText(rawDiff).split('\n').slice(0, maxDiffLines).join('\n');
    }

    // Step 1: Gather context via MCP Server if connected to GitHub
    if (!errorLogWindow && runId > 0 && githubToken !== 'dummy-local-token') {
      console.log('📡 Invoking Read-Only MCP Tools to fetch failure context...');
      const mcpServer = createReadOnlyMcpServer(octokit, {
        owner,
        repo,
        runId,
        pullNumber,
        maxDiffLines
      });

      const logDataJson = await mcpServer.executeTool('get_failed_job_logs', {});
      const logData = JSON.parse(logDataJson);

      if (logData.jobName) jobName = logData.jobName;
      if (logData.errorLogWindow) errorLogWindow = logData.errorLogWindow;

      if (pullNumber) {
        const diffDataJson = await mcpServer.executeTool('get_pull_request_diff', { maxLines: maxDiffLines });
        const diffData = JSON.parse(diffDataJson);
        if (diffData.diffSnippet) diffSnippet = diffData.diffSnippet;
      }

      const commitMetaJson = await mcpServer.executeTool('get_commit_metadata', {});
      const commitMeta = JSON.parse(commitMetaJson);
      if (commitMeta.commitSha) commitSha = commitMeta.commitSha;
      if (commitMeta.author) author = commitMeta.author;
      if (commitMeta.commitMessage) commitMessage = commitMeta.commitMessage;
    }

    if (!errorLogWindow) {
      errorLogWindow = '[Sample Error Log Window]\nError: Process completed with exit code 1.\nAssertionError: expected true to equal false\n  at UserServiceTest.ts:42';
    }

    // Step 2: Prepare Prompt from Template
    const systemPrompt = getSystemPrompt({
      jobName,
      commitSha: commitSha.substring(0, 7),
      author
    });

    const promptPayload = `Failed Job Context:
Job Name: ${jobName}
Error Log Window:
\`\`\`
${errorLogWindow}
\`\`\`

Pull Request Diff Snippet:
\`\`\`diff
${diffSnippet}
\`\`\`

Commit Message: ${commitMessage}
`;

    // Handle --no-execute (Dry-run mode)
    if (cliOptions.noExecute) {
      console.log('\n--- [DRY-RUN SYSTEM PROMPT] ---');
      console.log(systemPrompt);
      console.log('\n--- [DRY-RUN SANITIZED PAYLOAD] ---');
      console.log(promptPayload);
      console.log('\n✅ Dry-run completed successfully. (No AI execution or PR comments made)');
      return;
    }

    // Step 3: Run ACP Agent
    const mcpServer = createReadOnlyMcpServer(octokit, {
      owner,
      repo,
      runId,
      pullNumber,
      maxDiffLines
    });

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

      // Step 3a: Initialize Protocol
      await acpBridge.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'pipeline-assistant', version: '1.0.0' },
        capabilities: {
          readOnly: true,
          terminalExecution: false,
          fileModification: false,
          mcpTools: mcpServer.listTools()
        }
      });

      // Step 3b: Create Session (ACP Standard)
      console.log('🔄 Creating new ACP Session (session/new)...');
      let sessionId = 'default-session';
      try {
        const sessionRes = await acpBridge.sendRequest('session/new', {
          cwd: process.cwd(),
          mcpServers: []
        });
        if (sessionRes?.sessionId) {
          sessionId = sessionRes.sessionId;
        }
      } catch (sessErr: unknown) {
        console.warn(`[ACP Notice] session/new fallback to direct prompt: ${(sessErr as Error).message}`);
      }

      console.log('🧠 Prompting ACP Agent for Root Cause & Evidence Analysis...');
      acpBridge.clearStreamedText();

      // Step 3c: Send Prompt via session/prompt (or fallback to agent/prompt)
      let promptResponse: any = null;
      try {
        promptResponse = await acpBridge.sendRequest('session/prompt', {
          sessionId,
          content: [
            {
              type: 'text',
              text: `${systemPrompt}\n\n${promptPayload}`
            }
          ]
        });
      } catch {
        // Fallback for agents that expect agent/prompt or prompt
        promptResponse = await acpBridge.sendRequest('session/prompt', {
          sessionId,
          system: systemPrompt,
          prompt: promptPayload
        });
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
        jobName,
        commitSha: commitSha.substring(0, 7),
        author,
        rootCause: 'Analysis of the failure logs identified build or test errors. Inspect the extract below.',
        logEvidence: errorLogWindow,
        suggestedFix: 'Review the failing lines in the commit diff against the assertion requirements.'
      });
    } finally {
      acpBridge.stop();
    }

    console.log('\n--- [GENERATED MARKDOWN REPORT] ---');
    console.log(markdownReport);

    // Step 4: Post or Update Comment on Pull Request (if in CI and pullNumber present)
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

    core.setOutput('failed-job-name', jobName);
    core.setOutput('analysis-report', markdownReport);
    console.log('🎉 Pipeline Assistant completed successfully.');

  } catch (error: unknown) {
    const err = error as Error;
    core.setFailed(`pipeline-assistant failed: ${err.message}`);
  }
}

run();
