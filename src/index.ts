/**
 * index.ts — Pipeline Assistant Orchestration
 *
 * This file contains ONLY execution flow. All configuration, prompts, and
 * reporting logic live in dedicated modules:
 *
 *   src/config.ts   — ACP capabilities, MCP tool registry, agent defaults
 *   src/prompts.ts  — User prompt builders (live-CI and offline)
 *   src/templates.ts — System prompt & report template file readers
 *   src/reporter.ts — Job Summary writer and PR annotation emitter
 */

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
import { writeJobSummary, emitPrAnnotations } from './reporter';
import { ACP_CAPABILITIES, BOT_COMMENT_SIGNATURE, JOB_NAME, FALLBACK } from './config';
import { buildLiveCiUserPromptWithData, buildOfflineUserPrompt } from './prompts';

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
    // Tool registry loaded from config/mcp-tools.json via src/config.ts
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
    // System prompt → templates/system-prompt.txt (single source of truth)
    // User prompt   → src/prompts.ts (pure builder functions, no inline strings here)
    //
    // Architecture note: The copilot CLI manages its own tool ecosystem (github-mcp-server)
    // and does NOT call back to our in-process MCP bridge. We pre-fetch all GitHub data
    // here via octokit and embed it directly in the prompt instead.
    // -----------------------------------------------------------------------
    const isLiveCi = runId > 0 && githubToken !== 'dummy-local-token';
    const hasPullRequest = Boolean(pullNumber);

    const systemPrompt = getSystemPrompt({
      jobName: JOB_NAME,
      commitSha: 'HEAD',
      author: 'developer'
    });

    let userPrompt: string;

    if (isLiveCi) {
      console.log('📡 Pre-fetching GitHub data (logs, diff, metadata)...');

      // --- Fetch commit metadata ---
      let commitSha = 'HEAD';
      let commitMessage = '';
      let commitAuthor = 'developer';
      let jobName = JOB_NAME;
      try {
        const run = await octokit.rest.actions.getWorkflowRun({
          owner, repo, run_id: runId
        });
        commitSha = run.data.head_sha || 'HEAD';
        commitMessage = run.data.head_commit?.message || '';
        commitAuthor = run.data.head_commit?.author?.name || 'developer';
        console.log(`  ✅ Commit: ${commitSha.substring(0, 7)} by ${commitAuthor}`);
      } catch (e) {
        console.warn(`  ⚠️ Could not fetch commit metadata: ${(e as Error).message}`);
      }

      // --- Fetch failed job logs ---
      let errorLog = '';
      try {
        const jobsRes = await octokit.rest.actions.listJobsForWorkflowRun({
          owner, repo, run_id: runId
        });
        const failedJob = jobsRes.data.jobs.find(
          j => j.conclusion === 'failure' || j.status === 'in_progress'
        );
        if (failedJob) {
          jobName = failedJob.name;
          const logsRes = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
            owner, repo, job_id: failedJob.id
          });
          errorLog = extractErrorLogWindow(sanitizeText(String(logsRes.data)), 120);
          console.log(`  ✅ Logs: fetched error window for job "${failedJob.name}"`);
        } else {
          console.warn('  ⚠️ No failed job found in workflow run.');
        }
      } catch (e) {
        console.warn(`  ⚠️ Could not fetch job logs: ${(e as Error).message}`);
      }

      // --- Fetch code diff ---
      let diffSnippet = '';
      try {
        if (hasPullRequest && pullNumber) {
          const diffRes = await octokit.rest.pulls.get({
            owner, repo, pull_number: pullNumber,
            mediaType: { format: 'diff' }
          });
          diffSnippet = sanitizeText(String(diffRes.data))
            .split('\n').slice(0, maxDiffLines).join('\n');
          console.log('  ✅ Diff: fetched PR diff');
        } else {
          const commitRes = await octokit.rest.repos.getCommit({
            owner, repo, ref: commitSha,
            mediaType: { format: 'diff' }
          });
          diffSnippet = sanitizeText(String(commitRes.data))
            .split('\n').slice(0, maxDiffLines).join('\n');
          console.log('  ✅ Diff: fetched commit diff');
        }
      } catch (e) {
        console.warn(`  ⚠️ Could not fetch diff: ${(e as Error).message}`);
      }

      userPrompt = buildLiveCiUserPromptWithData({
        owner, repo, runId,
        commitSha, commitMessage, author: commitAuthor,
        jobName, errorLog, diffSnippet,
        hasPullRequest, pullNumber
      });
    } else {
      userPrompt = buildOfflineUserPrompt({
        errorLog: offlineErrorLog,
        diffSnippet: offlineDiffSnippet,
        jobName: JOB_NAME
      });
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
      // ACP capabilities loaded from config/acp-capabilities.json — never edit here.
      // protocolVersion: integer (this agent validates it as a number type)
      await acpBridge.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'pipeline-assistant', version: '1.0.0' },
        capabilities: ACP_CAPABILITIES
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

    fs.writeFileSync(reportFile, markdownReport, 'utf8');
    console.log(`\n📄 Report saved → ${reportFile}`);

    // -----------------------------------------------------------------------
    // Step 7: Write GitHub Actions Job Summary (always — visible on the
    //         failed-job Summary tab regardless of push vs PR strategy)
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
      // Non-fatal: summary writing can fail outside GitHub Actions (e.g. local runs)
      console.warn(`[summary] Could not write Job Summary: ${(summaryErr as Error).message}`);
    }

    // -----------------------------------------------------------------------
    // Step 8: Emit inline PR annotations (only when a PR context exists)
    //         Teams that push directly to main/master naturally skip this.
    // -----------------------------------------------------------------------
    if (pullNumber) {
      emitPrAnnotations(markdownReport);
    }

    // -----------------------------------------------------------------------
    // Step 9: Post or update the PR comment (live CI only)
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

    core.setOutput('failed-job-name', JOB_NAME);
    core.setOutput('analysis-report', markdownReport);
    console.log('🎉 Pipeline Assistant completed successfully.');

  } catch (error: unknown) {
    const err = error as Error;
    core.setFailed(`pipeline-assistant failed: ${err.message}`);
  }
}

run();
