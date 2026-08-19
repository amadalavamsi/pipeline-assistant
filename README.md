# pipeline-assistant 🚀

**Automated CI/CD failure root-cause analysis powered by GitHub Copilot ACP (Agent Client Protocol) and read-only MCP (Model Context Protocol) tools.**

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-pipeline--assistant-blue?logo=github)](https://github.com/marketplace/actions/pipeline-assistant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Protocol: ACP](https://img.shields.io/badge/Protocol-ACP%20(JSON--RPC%202.0)-cyan)](https://agentclientprotocol.com)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP%20(Read--Only)-purple)](https://modelcontextprotocol.io)

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
