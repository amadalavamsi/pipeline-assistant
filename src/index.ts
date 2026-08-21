import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { createReadOnlyMcpServer } from './mcp-tools';
import { AcpClientBridge } from './acp-client';
import { parseCliArgs } from './cli-parser';
import { getSystemPrompt, formatReportTemplate } from './templates';
import { sanitizeText, extractErrorLogWindow, initializeEnvSecretMasking, registerSecret } from './sanitizer';
import { ProtocolLogger } from './logger';
import { writeJobSummary, emitPrAnnotations } from './reporter';
import { ACP_CAPABILITIES, BOT_COMMENT_SIGNATURE, JOB_NAME, FALLBACK } from './config';
import { buildLiveCiUserPrompt, buildOfflineUserPrompt } from './prompts';

async function run(): Promise<void> {
  try {
    // -----------------------------------------------------------------------
    // Security Step 0: Initialize secret masking across the process
    // -----------------------------------------------------------------------
    initializeEnvSecretMasking();

    const cliOptions = parseCliArgs(process.argv.slice(2));

    const githubToken =
      core.getInput('github-token', { required: false }) ||
      process.env.GITHUB_TOKEN ||
      'dummy-local-token';

    if (githubToken && githubToken !== 'dummy-local-token') {
      registerSecret(githubToken);
    }
    if (process.env.COPILOT_GITHUB_TOKEN) {
      registerSecret(process.env.COPILOT_GITHUB_TOKEN);
    }

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // -----------------------------------------------------------------------
    // Resolve the TARGET run — the failing CI job we are analysing.
    //
    // Priority for run-id:
    //   1. Explicit `run-id` action input  (most reliable — set by workflow_run caller)
    //   2. github.event.workflow_run.id    (auto-populated when triggered by workflow_run)
    //   3. cliOptions.runId               (local CLI --run-id flag)
    //   4. context.runId                  (fallback — this is the ASSISTANT's own run ID,
    //                                      only correct when triggered directly, not via workflow_run)
    // -----------------------------------------------------------------------
    const runIdInput = parseInt(core.getInput('run-id', { required: false }) || '0', 10);
    const repoInput = core.getInput('repository', { required: false }) || '';

    // github.event.workflow_run is populated when triggered by workflow_run
    const workflowRunEvent = context.payload?.workflow_run as { id?: number; repository?: { owner?: { login?: string }; name?: string } } | undefined;

    const runId = runIdInput ||
                  workflowRunEvent?.id ||
                  cliOptions.runId ||
                  context.runId ||
                  0;

    // Safely resolve default owner and repo without throwing if GITHUB_REPOSITORY is unset
    let defaultOwner = process.env.GITHUB_REPOSITORY_OWNER || 'local-owner';
    let defaultRepo = 'local-repo';
    try {
      if (context.repo) {
        defaultOwner = context.repo.owner || defaultOwner;
        defaultRepo = context.repo.repo || defaultRepo;
      }
    } catch {
      // Ignored outside GitHub Actions runner
    }

    let owner: string;
    let repo: string;
    if (repoInput && repoInput.includes('/')) {
      [owner, repo] = repoInput.split('/');
    } else if (workflowRunEvent?.repository) {
      owner = workflowRunEvent.repository.owner?.login || defaultOwner;
      repo  = workflowRunEvent.repository.name        || defaultRepo;
    } else {
      owner = cliOptions.owner || defaultOwner;
      repo  = cliOptions.repo  || defaultRepo;
    }

    owner = owner.trim();
    repo = repo.trim();

    const pullNumber = cliOptions.pullNumber ||
                       (workflowRunEvent as any)?.pull_requests?.[0]?.number ||
                       context.payload?.pull_request?.number;

    const rawMaxDiff = parseInt(core.getInput('max-diff-lines', { required: false }) || '2000', 10);
    const maxDiffLines = isNaN(rawMaxDiff) ? 2000 : Math.max(10, Math.min(rawMaxDiff, 10000));

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
    // -----------------------------------------------------------------------
    const isLiveCi = runId > 0 && githubToken !== 'dummy-local-token';
    const hasPullRequest = Boolean(pullNumber);

    const systemPrompt = getSystemPrompt({
      jobName: JOB_NAME,
      commitSha: 'HEAD',
      author: 'developer'
    });

    const userPrompt = isLiveCi
      ? buildLiveCiUserPrompt({ owner, repo, runId, hasPullRequest, pullNumber })
      : buildOfflineUserPrompt({
          errorLog: offlineErrorLog,
          diffSnippet: offlineDiffSnippet,
          jobName: JOB_NAME
        });

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
      await acpBridge.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'pipeline-assistant', version: '1.0.0' },
        capabilities: ACP_CAPABILITIES
      });

      // Step 5b: Create Session with registered Read-Only MCP Tools
      console.log('🔄 Creating new ACP Session (session/new)...');
      let sessionId: string | undefined;
      try {
        const sessionRes = await acpBridge.sendRequest('session/new', {
          cwd: process.cwd(),
          mcpServers: [],
          tools: mcpServer.listTools()
        });
        if (sessionRes?.sessionId) {
          sessionId = sessionRes.sessionId;
          console.log(`✅ Session created: ${sessionId}`);
        }
      } catch (sessErr: unknown) {
        console.warn(`[ACP Notice] session/new failed, will prompt without sessionId: ${(sessErr as Error).message}`);
      }

      // Step 5c: Send prompt to agent
      console.log('🧠 Prompting ACP Agent for Root Cause & Evidence Analysis...');
      acpBridge.clearStreamedText();

      let promptResponse: any = null;
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
        jobName: JOB_NAME,
        commitSha: 'N/A',
        author: 'N/A',
        rootCause: FALLBACK.rootCause,
        logEvidence: offlineErrorLog || '(no log data available in fallback)',
        suggestedFix: FALLBACK.suggestedFix
      });
    } finally {
      acpBridge.stop();
    }

    markdownReport = sanitizeText(markdownReport);

    // -----------------------------------------------------------------------
    // Step 6: Print and save the report
    // -----------------------------------------------------------------------
    const reportFile = path.join(process.cwd(), 'analysis-report.md');

    if (!markdownReport) {
      console.warn('\n⚠️  [WARNING] Markdown report is empty — the ACP agent produced no output.');
      console.warn(`    Check the full debug log for details: ${ProtocolLogger.getLogFilePath()}`);
      markdownReport = formatReportTemplate({
        jobName: JOB_NAME,
        commitSha: 'N/A',
        author: 'N/A',
        rootCause: FALLBACK.noOutputRootCause,
        logEvidence: offlineErrorLog || '(no log data — check acp-debug.log)',
        suggestedFix: `${FALLBACK.noOutputSuggestedFix}: ${ProtocolLogger.getLogFilePath()}`
      });
    }

    console.log('\n--- [GENERATED MARKDOWN REPORT] ---');
    console.log(markdownReport);

    try {
      fs.writeFileSync(reportFile, markdownReport, 'utf8');
      console.log(`\n📄 Report saved → ${reportFile}`);
    } catch {
      // Non-fatal if filesystem is read-only
    }

    // -----------------------------------------------------------------------
    // Step 7: Write GitHub Actions Job Summary
    // -----------------------------------------------------------------------
    const triggerLabel = pullNumber ? `PR #${pullNumber}` : (context.eventName || 'push');
    try {
      await writeJobSummary({
        jobName: JOB_NAME,
        commitSha: context.sha || 'HEAD',
        author: context.actor || 'developer',
        triggerLabel,
        markdownReport
      });
    } catch (summaryErr: unknown) {
      console.warn(`[summary] Could not write Job Summary: ${(summaryErr as Error).message}`);
    }

    // -----------------------------------------------------------------------
    // Step 8: Emit inline PR annotations (only when a PR context exists)
    // -----------------------------------------------------------------------
    if (pullNumber) {
      try {
        emitPrAnnotations(markdownReport);
      } catch (annoErr: unknown) {
        console.warn(`[annotations] Could not emit annotations: ${(annoErr as Error).message}`);
      }
    }

    // -----------------------------------------------------------------------
    // Step 9: Post or update the PR comment (live CI only)
    // -----------------------------------------------------------------------
    if (pullNumber && markdownReport && !cliOptions.noExecute && githubToken !== 'dummy-local-token') {
      console.log(`💬 Posting diagnostic report to PR #${pullNumber}...`);
      const fullCommentBody = `${BOT_COMMENT_SIGNATURE}\n${markdownReport}\n\n---\n*Report generated by [pipeline-assistant](https://github.com/amadalavamsi/pipeline-assistant) via Agent Client Protocol (ACP).*`;

      try {
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
      } catch (commentErr: unknown) {
        // Non-fatal: token might lack pull-requests: write permissions in fork PRs
        console.warn(`⚠️  Could not post/update PR comment: ${(commentErr as Error).message}`);
      }
    }

    core.setOutput('failed-job-name', JOB_NAME);
    core.setOutput('analysis-report', markdownReport);
    console.log('🎉 Pipeline Assistant completed successfully.');

  } catch (error: unknown) {
    const err = error as Error;
    core.setFailed(`pipeline-assistant failed: ${err.message}`);
  }
}

run();

