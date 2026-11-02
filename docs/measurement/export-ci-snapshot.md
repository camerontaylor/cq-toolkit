# Reproducible CI snapshot export

A CI snapshot for a commit is a deterministic, re-fetchable bundle of GitHub
Actions runs, their attempts and jobs, and the commit's check runs and combined
status. This document is the recipe: every field in the snapshot manifest is
reproducible by re-running the listed `gh api` calls with the recorded
pagination cursors. Read-only; no mutation, no credentials beyond the caller's
existing `gh` auth, and no verdict interpretation here — consumers decide.

## Recipe

All commands are `gh api` against `repos/{owner}/{repo}/…`. Every list endpoint
is paginated with `per_page=100` and `--paginate --slurp`, so a re-export sees
the same rows as long as the underlying data has not changed.

1. **Runs for the head SHA** (`actions/runs`, paginated):

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=100" \
     --paginate --slurp
   ```

2. **Run attempts** for each run id from step 1
   (`actions/runs/{id}/attempts`):

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs/{run_id}/attempts?per_page=100" \
     --paginate --slurp
   ```

3. **Jobs per run attempt** (`actions/runs/{id}/jobs`, `filter=all` so
   runner-less jobs are retained):

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=100&filter=all" \
     --paginate --slurp
   ```

4. **Check runs for the commit** (`commits/{sha}/check-runs`, latest per check
   name, all pages):

   ```bash
   gh api "repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100" \
     --paginate --slurp
   ```

5. **Combined status** (`commits/{sha}/status`):

   ```bash
   gh api "repos/{owner}/{repo}/commits/{sha}/status"
   ```

## Snapshot manifest

Each export records a manifest so any snapshot can be re-derived byte-for-byte
at the field level:

| field        | meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `fetched_at` | UTC instant of the export (ISO 8601)                       |
| `head_sha`   | the commit the snapshot covers                             |
| `attempt`    | per-run attempt numbers actually fetched (from step 2)     |
| `pagination` | last `page` cursor observed per endpoint in step order 1–4 |

An empty page result at cursor N means the endpoint was exhausted at N; record
N even when it is 1 so a re-export does not under- or over-read.

## Unknown and degraded evidence

Evidence that cannot be fully captured is recorded as `"unknown"`, never
invented:

- **Expired logs**: a run whose `logs_url` is gone (retention elapsed) keeps its
  metadata but its log evidence is `unknown`.
- **Missing checks**: a required check name absent from step 4 output at
  exhaustion is `unknown`, not `pending` or `failed` — the export cannot
  distinguish "not yet reported" from "never will be".
- **Failed evidence**: a check run or job with a non-success `conclusion`
  (`failure`, `timed_out`, `cancelled`, `startup_failure`) is recorded verbatim
  with its `details_url`; the export never retries or re-derives a conclusion.

A worked fixture lives at `test/fixtures/measurement/ci-snapshot.json`; its
shape is asserted by `test/measurement-snapshot.test.ts`, which exercises only
local files — the recipe itself is never executed by tests.
