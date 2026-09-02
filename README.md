# pipeline-assistant 🤖

**Automated CI/CD failure root-cause analysis powered by GitHub Copilot via ACP (Agent Client Protocol).**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Protocol: ACP](https://img.shields.io/badge/Protocol-ACP%20(Agent%20Client%20Protocol)-cyan)](https://agentclientprotocol.com)
[![Protocol: MCP](https://img.shields.io/badge/Tools-MCP%20(Read--Only)-purple)](https://modelcontextprotocol.io)

> When your CI fails, `pipeline-assistant` automatically fetches the sanitized error logs and commit diff, sends them to a GitHub Copilot AI agent, and posts a structured root-cause diagnosis directly to your GitHub Actions Job Summary — before you even open the logs.

---

## 🎯 The Problem

When a CI/CD pipeline fails, developers typically spend **15–30 minutes**:

1. Scrolling thousands of lines of raw build logs to find the actual error
2. Cross-referencing the latest commit diff to figure out what changed
3. Manually copying snippets into an AI chat to get an answer

`pipeline-assistant` automates this entire flow **inside your GitHub runner** — no tokens to copy, no tabs to switch.

---

## ✨ What You Get

Every failure produces a structured diagnosis posted to the **GitHub Actions Job Summary**:

| Failed Job | Failed Step | Commit | Status | Confidence | Commit Causality |
|---|---|---|---|---|---|
| `Unit Tests` | `Run tests` | `a1b2c3d` | 🟢 CONFIRMED | 92% | INTRODUCED |

```markdown
## Failure Summary
❌ Unit Tests

## Diagnosis
- **Status**: CONFIRMED
- **Confidence**: 92%

## Root Cause
The test `JiraClientTest` fails because `import {axios} from 'axios'` is a named import,
but axios only exports a default export. TypeScript TS2724 correctly rejects this.

## What Changed
Commit `a1b2c3d` by `developer` modified:
- test/jira-client.test.ts

## Evidence
- TypeScript compilation error TS2724 at line 1 of test file
- axios package only exposes a default export, not a named `axios` export
```text
test/jira-client.test.ts:1:9 - error TS2724: '"axios"' has no exported member named 'axios'.
  1 import {axios} from 'axios';
```

## Suggested Fix / Next Steps
```diff
- import {axios} from 'axios';
+ import axios from 'axios';
```

## Files Involved
- test/jira-client.test.ts
```

### Diagnosis States

The assistant never forces a root cause when evidence is insufficient:

| State | Meaning | Confidence |
|:---|:---|:---|
| 🟢 **CONFIRMED** | Error log + code diff definitively prove the failure | ≥ 85% |
| 🟡 **LIKELY** | Strong evidence but external factors possible | 60–84% |
| ⚪ **UNKNOWN** | Truncated logs, silent exit, or infra issue — provides investigation steps instead | < 60% |

---

## 🏗️ How It Works

```
Your CI Workflow Fails
        │
        ▼
[ workflow_run trigger fires pipeline-assistant ]
        │
        ▼
┌─────────────────────────────────────────────┐
│  pipeline-assistant runner                  │
│                                             │
│  1. Fetches sanitized failure log window    │
│  2. Fetches trigger-commit diff             │
│  3. Looks up last successful run baseline   │
│  4. Identifies exact failed job + step      │
└─────────────────────────────────────────────┘
        │ Pre-fetched evidence (sanitized)
        ▼
┌─────────────────────────────────────────────┐
│  ACP Bridge (JSON-RPC 2.0 over stdin/stdout) │
│                                             │
│  Sends context to: copilot --acp --stdio    │
│  Enforces: read-only, no bash execution     │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  GitHub Copilot AI Agent                    │
│                                             │
│  Produces structured Markdown report with:  │
│  CONFIRMED/LIKELY/UNKNOWN status            │
│  Confidence % + Commit Causality            │
│  Exact fix or investigation steps           │
└─────────────────────────────────────────────┘
        │
        ▼
[ Report posted to: Job Summary + PR Comment ]
```

---

## 🚀 Quick Setup

### Prerequisites

**1. GitHub Copilot access**

The action uses the GitHub Copilot CLI binary (`copilot`) with ACP (`--acp --stdio`) support. You need either:
- A personal GitHub Copilot subscription, **or**
- A GitHub Copilot for Business organization license

**2. `COPILOT_GITHUB_TOKEN` secret**

The Copilot CLI needs a GitHub OAuth token to authenticate headlessly in CI. This is the token the Copilot CLI stores locally after you run `copilot auth login`.

To get your token:
```bash
# On your local machine, find the token stored by the Copilot CLI
cat ~/.config/github-copilot/hosts.json
```

Copy the `oauth_token` value (starts with `gho_`) and add it as a repository secret:
- `Settings → Secrets and variables → Actions → New repository secret`
- Name: `COPILOT_GITHUB_TOKEN`
- Value: your `gho_...` OAuth token

---

### Step 1 — Add the workflow file

Create `.github/workflows/pipeline-assistant.yml` in your repository:

```yaml
# .github/workflows/pipeline-assistant.yml
name: Pipeline Failure Triage

on:
  workflow_run:
    workflows: ["Unit Tests"]   # ← Replace with the exact name of your CI workflow
    types: [completed]

permissions:
  pull-requests: write   # to post the diagnosis comment on PRs
  actions: read          # to read job logs from the failed workflow
  contents: read         # to read commit diffs

jobs:
  triage:
    name: Diagnose Failure
    # Only runs when the watched CI workflow actually failed
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout pipeline-assistant action
        uses: actions/checkout@v4
        with:
          repository: amadalavamsi/pipeline-assistant
          path: .pipeline-assistant

      # Install the GitHub Copilot CLI with ACP support (v1.0.80+)
      # Note: The npm package @githubnext/github-copilot-cli is an older v0.1.x
      # that does NOT support --acp. Use the official binary from GitHub Releases.
      - name: Install GitHub Copilot CLI
        run: |
          COPILOT_VERSION="1.0.80"
          curl -fsSL "https://github.com/github/copilot-cli/releases/download/v${COPILOT_VERSION}/copilot-linux-x64.tar.gz" \
            -o copilot.tar.gz
          tar -xzf copilot.tar.gz
          sudo mv copilot /usr/local/bin/copilot
          sudo chmod +x /usr/local/bin/copilot
          copilot --version

      - name: 🤖 Run Pipeline Assistant
        uses: amadalavamsi/pipeline-assistant@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Pass the FAILING workflow's run ID — NOT this assistant workflow's run ID
          run-id: ${{ github.event.workflow_run.id }}
          repository: ${{ github.event.workflow_run.repository.full_name }}
          agent-command: 'copilot'
          agent-args: '--acp --stdio'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
```

> **Important**: `run-id` must be `${{ github.event.workflow_run.id }}` — the run ID of the **failing** CI workflow, not this triage workflow's own run ID.

---

### Step 2 — Trigger a failure

Push a breaking change or re-run a failed workflow. The triage job fires automatically and posts the diagnosis to the Job Summary.

---

## ⚙️ Inputs

| Input | Required | Default | Description |
|:---|:---|:---|:---|
| `github-token` | No | `${{ github.token }}` | GitHub token for reading logs and posting PR comments |
| `run-id` | No | `github.event.workflow_run.id` | Run ID of the **failing** workflow to analyse |
| `repository` | No | current repo | Repository to analyse in `owner/repo` format |
| `agent-command` | No | `copilot` | The ACP agent binary to execute |
| `agent-args` | No | `--acp --stdio` | Arguments for the ACP agent process |
| `max-diff-lines` | No | `2000` | Max commit diff lines sent to the agent (prevents token exhaustion) |

## 📤 Outputs

| Output | Description |
|:---|:---|
| `failed-job-name` | Name of the failed job that was analysed |
| `failed-step-name` | Name of the specific failed step within the job |
| `target-commit-sha` | SHA of the commit that triggered the failure |
| `analysis-report` | Full Markdown root-cause analysis report |

---

## 🛡️ Security & Safety

| Guarantee | Detail |
|:---|:---|
| **Read-only** | The agent never modifies files, creates commits, or writes to your repo |
| **No bash execution** | All `terminal/execute` and `client/runCommand` ACP calls are blocked at protocol level |
| **Secret redaction** | GitHub tokens, AWS keys, OpenAI keys, private keys, Azure SAS tokens, and connection strings are stripped before any context reaches the AI |
| **Least-privilege subprocess** | The Copilot process only receives `PATH`, `HOME`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` — no cloud credentials or other CI secrets |
| **Prompt injection defence** | All untrusted inputs (logs, commit messages, diffs) are wrapped in XML boundary tags so injected instructions cannot override system directives |
| **No hallucinated fixes** | When log evidence is insufficient, the agent returns `UNKNOWN` status and actionable investigation steps instead of guessing |

---

## 🛠️ Local Development & Testing

```bash
# Clone the repository
git clone https://github.com/amadalavamsi/pipeline-assistant.git
cd pipeline-assistant

# Install dependencies
npm install

# Typecheck
npm run typecheck

# Build the dist bundle (required before pushing)
npm run build

# Dry-run: shows what prompts would be sent without calling the AI agent
node dist/index.js --no-execute

# Test with a local error log file
node dist/index.js --log-file ./my-error.log --no-execute

# Test against a live GitHub run (requires GITHUB_TOKEN in env)
GITHUB_TOKEN=ghp_... node dist/index.js \
  --owner amadalavamsi \
  --repo story-proof-bot \
  --run-id 123456789 \
  --no-execute
```

---

## 🧩 Real-World Example

This action is actively used in [**story-proof-bot**](https://github.com/amadalavamsi/story-proof-bot), where it watches the `Unit Tests` workflow and automatically diagnoses every failure.

The full working workflow:
[`.github/workflows/pipeline-assistant.yml`](https://github.com/amadalavamsi/story-proof-bot/blob/main/.github/workflows/pipeline-assistant.yml)

---

## 📄 License

MIT © [Vamsi Amadala](https://github.com/amadalavamsi)


---

## 🎯 The Problem

When CI/CD pipelines fail (unit test crashes, broken assertions, terraform permissions, or lint errors), developers spend 15–30 minutes:
1. Scrolling through 10,000+ lines of raw build logs.
2. Cross-referencing the latest commit diff to locate the broken file.
3. Asking AI models by copying and pasting snippets manually.

`pipeline-assistant` automates this entire diagnostic flow right inside your GitHub Action runners.

---

## 🏗️ Architecture: Pure ACP + MCP Decoupled Standard

```
[ GitHub Action Fails ]
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  pipeline-assistant runner                                  │
│                                                             │
│  1. Read-Only MCP Tools:                                    │
│     - get_failed_job_logs (with error window extraction)    │
│     - get_pull_request_diff                                 │
│     - get_commit_metadata                                   │
│                                                             │
│  2. Strict Security Sanitizer (Redacts tokens, ARNs, keys)  │
│                                                             │
│  3. ACP Client Bridge (JSON-RPC 2.0 via stdin/stdout)       │
└─────────────────────────────────────────────────────────────┘
          │
          │ Standard ACP Protocol
          ▼
┌─────────────────────────────────────────────────────────────┐
│  ACP Agent Runner (GitHub Copilot `acp-server`)             │
│                                                             │
│  - Analyzes error context vs. commit diff                   │
│  - Pinpoints exact root-cause line & evidence               │
│  - Generates actionable Markdown fix suggestion             │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
[ Idempotent Markdown Diagnosis posted to PR Comment ]
```

---

## 🛡️ Enterprise Security & Safety Guarantees

* **🔒 Read-Only Operations**: The assistant never modifies files or creates commits.
* **🚫 Zero Bash/Terminal Execution**: All ACP command execution requests are strictly blocked at the client protocol level.
* **🔑 Strict Secrets Redaction**: Regex sanitizers automatically strip GitHub tokens (`ghp_`), AWS credentials (`AKIA...`), JWTs, private keys, and connection strings before any context reaches the AI.
* **🔄 Zero Additional Vendor Costs**: Reuses the organization's existing GitHub Copilot ACP subscription—no extra third-party API keys required.
* **💬 Idempotent Comments**: Re-running or fixing a build updates the same PR comment instead of creating noisy duplicate notifications.

---

## 📋 Example PR Diagnostic Report

```markdown
### ❌ Pipeline Failure Analysis
- **Failed Job**: `unit-tests`
- **Commit**: `a1b2c3d` by `@developer`

#### 🔍 Root Cause
The test `UserServiceTest.testFindById_NullUser` failed with a `NullPointerException` because `UserRepository.findById` was refactored in `UserService.java:L42` without null checking the return value.

#### 📜 Log Evidence
```text
[ERROR] Tests run: 45, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 4.21 s <<< FAILURE!
[ERROR] com.example.service.UserServiceTest.testFindById_NullUser  Time elapsed: 0.012 s  <<< ERROR!
java.lang.NullPointerException: Cannot invoke "com.example.model.User.getId()" because "user" is null
    at com.example.service.UserService.getUserDetails(UserService.java:42)
    at com.example.service.UserServiceTest.testFindById_NullUser(UserServiceTest.java:78)
```

#### 💡 Suggested Fix
In `UserService.java`, wrap the return in an `Optional` or add a defensive null check:
```java
public UserDto getUserDetails(Long id) {
    User user = userRepository.findById(id).orElseThrow(() -> new UserNotFoundException(id));
    return UserDto.from(user);
}
```
```

---

## 🚀 Quick Setup

Add `.github/workflows/pipeline-assistant.yml` to your repository:

```yaml
name: CI/CD Pipeline Triage

on:
  workflow_run:
    workflows: ["Build & Test"] # Name of your main CI workflow
    types: [completed]

permissions:
  pull-requests: write
  actions: read
  contents: read

jobs:
  triage:
    name: Diagnose Pipeline Failure
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - name: 🛡️ Run Pipeline Assistant
        uses: amadalavamsi/pipeline-assistant@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## ⚙️ Inputs

| Input | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `github-token` | — | `${{ github.token }}` | GitHub token for reading logs and posting PR comments |
| `agent-command` | — | `copilot` | The ACP Agent binary command to execute |
| `agent-args` | — | `acp-server` | Arguments for the ACP Agent process |
| `max-diff-lines` | — | `2000` | Max lines of PR diff to send to the ACP agent |

---

## 🛠️ Local Development

```bash
# Clone the repository
git clone https://github.com/amadalavamsi/pipeline-assistant.git
cd pipeline-assistant

# Install dependencies
npm install

# Typecheck
npm run typecheck

# Build bundle for GitHub Actions runner (dist/index.js)
npm run build
```

---

## 📄 License

MIT © [Vamsi Amadala](https://github.com/amadalavamsi)
