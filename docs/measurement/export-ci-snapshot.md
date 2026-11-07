# CI snapshot export recipe (M10a2)

A CI snapshot is a **recorded snapshot**: one read-only capture of the GitHub
Actions runs, per-attempt jobs, check runs and combined status for exactly
one commit head, taken by hand with the `gh api` recipe below. A later re-run
does not reproduce it byte for byte — runs get re-run and `filter=latest`
moves — so the manifest records enough provenance (repo, head, fetch
instant, per-invocation page counts) to re-query the same views. Nothing here
interprets a verdict; consumers decide. No mutation, and no credentials
beyond the caller's existing `gh` auth.

## Recipe

All commands are `gh api` against `repos/{owner}/{repo}/…`. Every one of the
five uses `per_page=100` with `--paginate --slurp`, so each output is an
array with one entry per fetched page and no offered page is skipped.
`attempts/{n}` returns a single object; its slurped output is a one-element
array. Exhausting pagination is necessary but not sufficient for coverage:
GitHub caps some lists silently; see Coverage.

1. **Runs for the head** — workflow runs whose `head_sha` matches:

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=100" --paginate --slurp
   ```

2. **Each attempt of each run** — there is no `/attempts` collection (it
   404s) and no `run_count` field; the run object carries `run_attempt`, its
   latest attempt number, so attempts are enumerated `1..run_attempt`, one
   call per attempt:

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}" --paginate --slurp
   ```

3. **Jobs of one attempt** — attempt-scoped, so no `filter` is ever passed
   (never `filter=all`; the page already holds only that attempt's jobs):

   ```bash
   gh api "repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}/jobs?per_page=100" --paginate --slurp
   ```

4. **Check runs of the head** — the latest check run per name:

   ```bash
   gh api "repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100" --paginate --slurp
   ```

5. **Combined status of the head** — the `statuses` array paginates; the
   default page of 30 would silently truncate it:

   ```bash
   gh api "repos/{owner}/{repo}/commits/{sha}/status?per_page=100" --paginate --slurp
   ```

## What is recorded

Each manifest attempt entry is the recorded subset of the fetched object:
`id`, `run_attempt`, `conclusion`, `head_sha`, `created_at`. A failed job or
check run — any non-success `conclusion` such as `failure`, `timed_out`,
`cancelled`, `startup_failure` — is recorded verbatim with its own link
fields: a job with its `html_url` (and `check_run_url`), a check run with
its `details_url` (workflow-job responses carry no `details_url`).
An attempt with zero jobs keeps its object entry with its `jobs` field set
to `[]`, never omitted.

## Manifest

One manifest per snapshot, snake_case:

- `repo` — `owner/name` of the repository queried.
- `head_sha` — the one head this snapshot covers.
- `fetched_at` — the capture instant, ISO 8601 UTC.
- `window` — explicit inputs used, if any; omitted when there were none.
- `attempts` — the recorded attempt entries described above.
- `pagination` — pages fetched per endpoint invocation (below).
- `complete` — `true` only when all five steps ran to exhaustion.
- `failed_step` — when `complete` is false, the step that failed.

`pagination` holds one entry per endpoint _invocation_, never one scalar per
endpoint. Runs, check runs and status are each invoked once. Attempts and
jobs are invoked per run id and attempt number, keyed by run id first, then
attempt number:

```json
{"jobs": {"<run_id>": {"1": 1, "2": 2}}}
```

These field names are doc conventions only. A future machine reader defines
its own schema in code.

## Log probe

Each run object carries a run-level `logs_url`, and expiry is not derivable
from the field. After a partial re-run that archive holds only the re-run
jobs, so probe the attempt archive
`repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}/logs` for each
recorded attempt. Probe with `gh api --method GET …`; this downloads the
zip — both log endpoints answer `405` to a HEAD request, so there is no
lighter probe. The attempt-logs download documents only a `302 Found`
redirect for a live archive, so no documented status code signals expiry:
treat any non-`302` response as a distinct probe failure recorded with its
status code, never as expired logs. The run keeps its metadata, and its
`log_evidence` is `"unknown"`.

## Coverage

Unknown is never zero:

- A snapshot covers exactly one head. The head is **observed** only when all
  five steps completed to exhaustion: then `complete: true`. Otherwise
  `complete: false`, with `failed_step` naming the step that failed.
- Exhaustion is not always proof: GitHub caps some lists silently. A
  `head_sha` run search returns at most 1,000 runs, and check runs cover at
  most the 1,000 most recent check suites. When a step reached a documented
  cap, its coverage is not proven: record `complete: false` with
  `failed_step` naming the capped step, never a "no red".
- Feed observed heads into M10e's `ciObservedHeads` input
  (`OutcomePanelsInput.ciObservedHeads` in `scripts/measurement-outcomes.d.mts`)
  and point each `CiRedObservation.source` at the snapshot path. A head with
  no complete snapshot is unobserved: it is never a "no red". M10e counts
  eligible heads missing from the coverage set in `ciRed.unobservedHeads`,
  and with no coverage declared the `ciRed` counts are null.
- The required-check names are not in these responses; take them from the
  target repository's own policy or trust reference. A required check name
  absent from step 4 at exhaustion is `unknown`, not `pending` or `failed` —
  the export cannot distinguish "not yet reported" from "never will be".
  Absence is unknown evidence only: never write a `CiRedObservation` for an
  absent check; an observation records an actual red.
- A failed log probe (see Log probe) is `unknown` evidence.
