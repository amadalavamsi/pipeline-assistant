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

        case 'get_recent_commits': {
          try {
            const count = Math.min(20, Math.max(1, (args.count as number) || 5));
            let branch = 'HEAD';

            try {
              const run = await octokit.rest.actions.getWorkflowRun({
                owner: context.owner,
                repo: context.repo,
                run_id: context.runId
              });
              branch = run.data.head_branch || run.data.head_sha || 'HEAD';
            } catch {
              // Fallback to default branch
            }

            const commitsResponse = await octokit.rest.repos.listCommits({
              owner: context.owner,
              repo: context.repo,
              sha: branch,
              per_page: count
            });

            const commits = commitsResponse.data.map(c => ({
              sha: c.sha.substring(0, 7),
              fullSha: c.sha,
              author: c.commit.author?.name || c.author?.login || 'unknown',
              message: sanitizeText(c.commit.message),
              date: c.commit.author?.date
            }));

            const result = JSON.stringify({
              branch,
              count: commits.length,
              commits
            });

            ProtocolLogger.mcpToolResult(name, `Retrieved last ${commits.length} commits on ${branch}`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch recent commits: ${error.message}` });
          }
        }

        case 'get_commit_diff': {
          try {
            const commitSha = args.commitSha as string;
            if (!commitSha) {
              return JSON.stringify({ error: 'Missing required parameter: commitSha' });
            }

            const maxLines = (args.maxLines as number) || context.maxDiffLines;
            const commitResponse = await octokit.rest.repos.getCommit({
              owner: context.owner,
              repo: context.repo,
              ref: commitSha,
              mediaType: { format: 'diff' }
            });

            const rawDiff = String(commitResponse.data);
            const sanitized = sanitizeText(rawDiff);
            const diffLines = sanitized.split('\n');
            const limitedDiff = diffLines.slice(0, maxLines).join('\n');

            const result = JSON.stringify({
              commitSha,
              totalLines: diffLines.length,
              diffSnippet: limitedDiff
            });

            ProtocolLogger.mcpToolResult(name, `Fetched diff for commit ${commitSha} (${diffLines.length} lines, capped to ${maxLines})`, result.length);
            return result;
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch diff for commit ${args.commitSha}: ${error.message}` });
          }
        }

        case 'get_file_content': {
          try {
            const rawFilePath = args.filePath as string;
            if (!rawFilePath || typeof rawFilePath !== 'string') {
              return JSON.stringify({ error: 'Missing required parameter: filePath' });
            }

            // Path normalization and traversal prevention
            const normalizedPath = rawFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normalizedPath.includes('..') || normalizedPath.startsWith('./')) {
              const err = `Access denied: Path traversal patterns are strictly forbidden: "${rawFilePath}"`;
              ProtocolLogger.mcpToolError(name, err);
              return JSON.stringify({ error: err });
            }

            // Sensitive file blacklist — enterprise security safeguard
            const sensitiveFilePatterns = [
              /^\.env(\..+)?$/i,
              /^\.git\//i,
              /^\.aws\//i,
              /^\.ssh\//i,
              /id_rsa/i,
              /id_ed25519/i,
              /id_dsa/i,
              /\.(pem|key|p12|pfx|pkcs12|keystore|jks)$/i,
              /credentials(\.json|\.ya?ml|\.ini)?$/i,
              /secrets?(\.json|\.ya?ml)?$/i
            ];

            if (sensitiveFilePatterns.some(pattern => pattern.test(normalizedPath))) {
              const err = `Security Gate: Access to sensitive or credential file "${normalizedPath}" is blocked.`;
              ProtocolLogger.mcpToolError(name, err);
              return JSON.stringify({ error: err });
            }

            let ref = args.ref as string | undefined;
            if (!ref) {
              try {
                const run = await octokit.rest.actions.getWorkflowRun({
                  owner: context.owner,
                  repo: context.repo,
                  run_id: context.runId
                });
                ref = run.data.head_sha;
              } catch {
                ref = 'HEAD';
              }
            }

            const fileResponse = await octokit.rest.repos.getContent({
              owner: context.owner,
              repo: context.repo,
              path: normalizedPath,
              ref
            });

            if ('content' in fileResponse.data && fileResponse.data.encoding === 'base64') {
              const decoded = Buffer.from(fileResponse.data.content, 'base64').toString('utf8');
              const sanitized = sanitizeText(decoded);
              const lines = sanitized.split('\n');
              const limitedContent = lines.slice(0, 500).join('\n'); // cap to 500 lines

              const result = JSON.stringify({
                filePath: normalizedPath,
                ref,
                totalLines: lines.length,
                content: limitedContent
              });

              ProtocolLogger.mcpToolResult(name, `Fetched file ${normalizedPath} @ ${ref} (${lines.length} lines)`, result.length);
              return result;
            } else {
              return JSON.stringify({ error: `Path "${normalizedPath}" is not a readable file.` });
            }
          } catch (err: unknown) {
            const error = err as Error;
            ProtocolLogger.mcpToolError(name, error.message);
            return JSON.stringify({ error: `Failed to fetch file content: ${error.message}` });
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
