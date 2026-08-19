Running two MCP queries in parallel to collect the failed job logs and the latest commit list (to then fetch the commit diff). They are independent and quick to retrieve. I'll fetch job logs and the most recent commit simultaneously.Fetching full commit patch and metadata for the latest commit SHA afbab50d867e758ddd3848615880f789e535c802 to inspect recent code changes that likely cause the test failure.### ❌ Pipeline Failure Analysis
- **Failed Job**: `CI-Job`
- **Commit**: `afbab50d867e758ddd3848615880f789e535c802` by `Vamsi Tarun`

#### 🔍 Root Cause
A recent commit changed the test import to use a named import from axios (`import {axios} from 'axios'`), but axios exposes a default export — TypeScript reports there is no exported member named `axios`. This causes the TypeScript compile step in the test run to fail, aborting the job.

#### 📜 Log Evidence
```text
test/jira-client.test.ts:1:9 - error TS2724: '"axios"' has no exported member named 'axios'. Did you mean 'Axios'?

  1 import {axios} from 'axios';
            ~~~~~

  node_modules/axios/index.d.ts:623:14
    623 export class Axios {
                    ~~~~~
    'Axios' is declared here.
```

#### 💡 Suggested Fix
Replace the named import with the default import in test/jira-client.test.ts:

```ts
// test/jira-client.test.ts
- import {axios} from 'axios';
+ import axios from 'axios';
```

Commit that change and re-run the CI (or run `npm test` locally) — the TypeScript error should be resolved.