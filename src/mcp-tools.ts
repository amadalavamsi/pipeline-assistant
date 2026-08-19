/**
 * In-Memory Read-Only MCP Server providing tools to read failed job logs and PR commit diffs.
 * Includes complete audit logging for every tool invocation and return payload.
 */

import { getOctokit } from '@actions/github';
import { sanitizeText, extractErrorLogWindow } from './sanitizer';
import { ProtocolLogger } from './logger';

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ReadOnlyMcpServer {
  listTools(): McpToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
}

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
  const tools: McpToolDefinition[] = [
    {
      name: 'get_failed_job_logs',
      description: 'Fetch the sanitized failure log context from the current workflow run.',
      parameters: {
        type: 'object',
        properties: {
          jobName: { type: 'string', description: 'Optional specific job name to filter' }
        }
      }
    },
    {
      name: 'get_pull_request_diff',
      description: 'Fetch the sanitized git diff of the latest commit(s) in the pull request.',
      parameters: {
        type: 'object',
        properties: {
          maxLines: { type: 'number', description: 'Max diff lines to retrieve' }
        }
      }
    },
    {
      name: 'get_commit_metadata',
      description: 'Retrieve metadata of the latest commit including author and commit message.',
      parameters: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'get_latest_commit_diff',
      description: 'Fetch the sanitized file diff of the latest commit on the current workflow run. Use this for push-triggered runs where no pull request is available.',
      parameters: {
        type: 'object',
        properties: {
          maxLines: { type: 'number', description: 'Max diff lines to retrieve' }
        }
      }
    }
  ];

  return {
    listTools: () => tools,

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
              mediaType: {
                format: 'diff'
              }
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
