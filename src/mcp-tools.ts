/**
 * In-Memory Read-Only MCP Server providing tools to read failed job logs and PR commit diffs.
 */

import { getOctokit } from '@actions/github';
import { sanitizeText, extractErrorLogWindow } from './sanitizer';

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
    }
  ];

  return {
    listTools: () => tools,

    executeTool: async (name: string, args: Record<string, unknown>): Promise<string> => {
      switch (name) {
        case 'get_failed_job_logs': {
          const jobsResponse = await octokit.rest.actions.listJobsForWorkflowRun({
            owner: context.owner,
            repo: context.repo,
            run_id: context.runId
          });

          const failedJob = jobsResponse.data.jobs.find(
            j => j.conclusion === 'failure' || j.status === 'in_progress'
          );

          if (!failedJob) {
            return JSON.stringify({ message: 'No failed jobs found in workflow run.' });
          }

          try {
            const logsResponse = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              job_id: failedJob.id
            });

            const rawLog = String(logsResponse.data);
            const sanitized = sanitizeText(rawLog);
            const errorWindow = extractErrorLogWindow(sanitized, 120);

            return JSON.stringify({
              jobName: failedJob.name,
              jobId: failedJob.id,
              errorLogWindow: errorWindow
            });
          } catch (err: unknown) {
            const error = err as Error;
            return JSON.stringify({ error: `Failed to download logs: ${error.message}` });
          }
        }

        case 'get_pull_request_diff': {
          if (!context.pullNumber) {
            return JSON.stringify({ message: 'No pull request associated with this workflow run.' });
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

            return JSON.stringify({
              pullNumber: context.pullNumber,
              totalLines: diffLines.length,
              diffSnippet: limitedDiff
            });
          } catch (err: unknown) {
            const error = err as Error;
            return JSON.stringify({ error: `Failed to fetch PR diff: ${error.message}` });
          }
        }

        case 'get_commit_metadata': {
          const run = await octokit.rest.actions.getWorkflowRun({
            owner: context.owner,
            repo: context.repo,
            run_id: context.runId
          });

          return JSON.stringify({
            commitSha: run.data.head_sha,
            commitMessage: run.data.head_commit?.message || '',
            author: run.data.head_commit?.author?.name || '',
            event: run.data.event
          });
        }

        default:
          throw new Error(`Tool "${name}" is not supported in read-only mode.`);
      }
    }
  };
}
