export interface CliOptions {
  runId?: number;
  jobId?: number;
  pullNumber?: number;
  owner?: string;
  repo?: string;
  noExecute?: boolean; // Dry-run mode: fetch & sanitize logs/diff, print prompt, skip AI/posting
  logFile?: string;   // Local log file path for offline testing
  diffFile?: string;  // Local diff file path for offline testing
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (const arg of args) {
    if (arg === '--no-execute' || arg === '--dry-run') {
      options.noExecute = true;
    } else if (arg.startsWith('--run-id=')) {
      options.runId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--job-id=')) {
      options.jobId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--pr=') || arg.startsWith('--pull-number=')) {
      options.pullNumber = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--owner=')) {
      options.owner = arg.split('=')[1];
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.split('=')[1];
    } else if (arg.startsWith('--log-file=')) {
      options.logFile = arg.split('=')[1];
    } else if (arg.startsWith('--diff-file=')) {
      options.diffFile = arg.split('=')[1];
    }
  }

  return options;
}
