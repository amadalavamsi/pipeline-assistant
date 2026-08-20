/**
 * mcp-tools.ts
 *
 * In-Memory Read-Only MCP Server.
 * - Tool REGISTRY (names, descriptions, parameter schemas) → loaded from config/mcp-tools.json
 * - Tool IMPLEMENTATION (GitHub API calls)                → switch/case below
 *
 * To add a new tool:
 *   1. Add its JSON descriptor to config/mcp-tools.json
 *   2. Add a matching case in executeTool() below
 */

import { getOctokit } from '@actions/github';
import { sanitizeText, extractErrorLogWindow } from './sanitizer';
import { ProtocolLogger } from './logger';
import { MCP_TOOL_REGISTRY } from './config';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ReadOnlyMcpServer {
  listTools(): McpToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReadOnlyMcpServer(
  octokit: ReturnType<typeof getOctokit>,
  context: {
    owner: string;
    repo: string;
    runId: number;
    pullNumber?: number;
    maxDiffLines: number;
  }
): ReadOnlyMcpServer {
  return {
    // Tool registry is served directly from config/mcp-tools.json
    listTools: () => MCP_TOOL_REGISTRY,

    executeTool: async (name: string, args: Record<string, unknown>): Promise<string> => {
      ProtocolLogger.mcpToolInvoked(name, args);

      switch (name) {
        case 'get_failed_job_logs': {
          try {
            const jobsResponse = await octokit.rest.actions.listJobsForWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              run_id: context.runId
            });

            const failedJob = jobsResponse.data.jobs.find(
              j => j.conclusion === 'failure' || j.status === 'in_progress'
            );

            if (!failedJob) {
              const res = JSON.stringify({ message: 'No failed jobs found in workflow run.' });
              ProtocolLogger.mcpToolResult(name, 'No failed jobs found', res.length);
              return res;
            }

            const logsResponse = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              job_id: failedJob.id
            });

            const rawLog = String(logsResponse.data);
            const sanitized = sanitizeText(rawLog);
            const errorWindow = extractErrorLogWindow(sanitized, 120);

            const result = JSON.stringify({
              jobName: failedJob.name,
              jobId: failedJob.id,
              errorLogWindow: errorWindow
            });

            ProtocolLogger.mcpToolResult(name, `Extracted error window for job: ${failedJob.name}`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to download logs: ${error.message}` });
          }
        }

        case 'get_pull_request_diff': {
          if (!context.pullNumber) {
            const res = JSON.stringify({ message: 'No pull request associated with this workflow run.' });
            ProtocolLogger.mcpToolResult(name, 'No PR context', res.length);
            return res;
          }

          try {
            const diffResponse = await octokit.rest.pulls.get({
              owner: context.owner,
              repo: context.repo,
              pull_number: context.pullNumber,
              mediaType: { format: 'diff' }
            });

            const rawDiff = String(diffResponse.data);
            const sanitized = sanitizeText(rawDiff);
            const diffLines = sanitized.split('\n');
            const limitedDiff = diffLines.slice(0, context.maxDiffLines).join('\n');

            const result = JSON.stringify({
              pullNumber: context.pullNumber,
              totalLines: diffLines.length,
              diffSnippet: limitedDiff
            });

            ProtocolLogger.mcpToolResult(name, `Fetched ${diffLines.length} diff lines (capped to ${context.maxDiffLines})`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch PR diff: ${error.message}` });
          }
        }

        case 'get_commit_metadata': {
          try {
            const run = await octokit.rest.actions.getWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              run_id: context.runId
            });

            const result = JSON.stringify({
              commitSha: run.data.head_sha,
              commitMessage: run.data.head_commit?.message || '',
              author: run.data.head_commit?.author?.name || '',
              event: run.data.event
            });

            ProtocolLogger.mcpToolResult(name, `Retrieved commit ${run.data.head_sha?.substring(0, 7)}`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch commit metadata: ${error.message}` });
          }
        }

        case 'get_latest_commit_diff': {
          try {
            // Fetch the head SHA from the workflow run
            const run = await octokit.rest.actions.getWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              run_id: context.runId
            });
            const headSha = run.data.head_sha;

            // Fetch the commit diff via the commits API (works without a PR)
            const commitResponse = await octokit.rest.repos.getCommit({
              owner: context.owner,
              repo: context.repo,
              ref: headSha,
              mediaType: { format: 'diff' }
            });

            const maxLines = (args.maxLines as number) || context.maxDiffLines;
            const rawDiff = String(commitResponse.data);
            const sanitized = sanitizeText(rawDiff);
            const diffLines = sanitized.split('\n');
            const limitedDiff = diffLines.slice(0, maxLines).join('\n');

            const result = JSON.stringify({
              commitSha: headSha,
              totalLines: diffLines.length,
              diffSnippet: limitedDiff
            });

            ProtocolLogger.mcpToolResult(name, `Fetched commit diff for ${headSha.substring(0, 7)} (${diffLines.length} lines, capped to ${maxLines})`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch commit diff: ${error.message}` });
          }
        }

        default: {
          const err = `Tool "${name}" is not supported in read-only mode.`;
          ProtocolLogger.mcpToolError(name, err);
          throw new Error(err);
        }
      }
    }
  };
}
