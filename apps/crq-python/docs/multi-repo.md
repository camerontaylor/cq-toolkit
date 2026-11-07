# Multi-repo review — design note (2026-11-03)

crq grows from one reviewed repository (camerontaylor/cq-toolkit) to several.
Target set: `infra`, `hart`, `dotfiles`, `agents`, `encoding`, `toolkit-research`
(all `camerontaylor/*`). Most changes there are direct pushes to the default
branch, so PR-only discovery would miss them: discovery gains a first-parent
commit-range mode per repository. The primary repo keeps every existing path
unchanged; every new behavior is keyed on an item/binding `repo` field that
legacy state lacks and receives lazily.

## Config shape (`config.json`)

The primary repo stays top-level (`repo`, `clone`, `worktree_root`,
`worktree_prefix`). New key `repos` is a list (empty = today's single-repo
behavior; the checked-in config ships empty, host overlays add entries):

```json
{"repo": "camerontaylor/cq-toolkit", "...": "...",
 "repos": [
   {"repo": "camerontaylor/infra",
    "clone": "/path/to/infra-clone-on-host",
    "default_branch": "main",
    "discovery": {"push": true, "pr": false},
    "floor": "2026-11-10T00:00:00Z",
    "quiet_minutes": 30,
    "include": ["**"],
    "exclude": ["*.lock", "vendored/**"],
    "rank_tier": 3,
    "findings": "issue"}
 ]}
```

- `discovery.push` — first-parent range discovery on the default branch
  (default true). `discovery.pr` — open-PR enrollment for that repo
  (default false). Merged PRs need no separate mode: merges land on the
  default branch, so push ranges cover their content.
- `floor` — ISO timestamp set at deploy time; the initial reviewed tip is the
  last commit at-or-before it. History before the floor is never reviewed.
- `quiet_minutes` — push coalescing window (default: global `quiet_minutes`).
- `include`/`exclude` — glob lists matched against repo-relative paths
  (default include `["**"]`, exclude `[]`). Excluded affected paths appear in
  the capture as `excluded-config` rows, never silently dropped.
- `rank_tier` — scheduling rank for this repo's items (int 2–4, default 3).
  cq-toolkit ordinary work is ranks 0–2, backfill/coverage/author are 4; new
  repos sit between (3) by default.
- `scan_extra_classes` — denylist class ids added to the universal
  secret-shape set (key material, tokens, inline secrets) for this repo's
  pre-upload scan (default `[]`). The primary repo's publish classes stay
  primary-only: fleet vocabulary is the ordinary subject matter of the
  reviewed repos and must not block their reviews. Unknown class ids fail the
  scan closed.
- `findings` — `"issue"` (file one GitHub issue per counted review with
  findings, in that repo) or `"none"`. Repair drain is never enabled for
  non-primary repos in this change.

Validation lives in `repo_registry.py` (fail-closed like every other config
parser here: unknown keys, bad slugs, bad timestamps, out-of-range ranks
refuse the config).

## Identity and migration

- Every queue item *reads* as carrying `repo` (`owner/name`): legacy items
  without the field default to the primary repo at every reader
  (`item_repo`), which is what "existing cq-toolkit items keep working"
  requires. Loads and saves never rewrite legacy items (exact queue equality
  is a tested contract); non-primary writers stamp `repo` at item creation, so
  the field spreads through the queue as new-repo items are created, while
  primary-repo writers may keep omitting it (readers normalize either way).
  No queue reset.
- Item ids embed the repo slug so ids stay unique across repos:
  push ranges `push-<name>-<base10>-<head10>` (overflow parts `…-p2`, `…-p3`),
  open PRs `<name>-pr<n>`, deltas `<name>-pr<n>-range-<pin>-<head>`.
  `<name>` is the repo's suffix after `/`.
- Push items: kind `push-current`, `pr: 0`, subject binding
  `{"type": "push-range", "repo", "base", "head", "policy"}`, plus optional
  `paths_filter` and `pin` (the parent capture target) on split follow-up parts.
  Merged-current bindings already carry `repo` and stay as they are.
- Run records (`meta.json`), work records and status.json items gain `repo`.

## Push discovery (per repo, per tick)

Per-repo state in the queue: `q["push_discovery"][<repo>] = {"reviewed_tip":
sha}`. Each tick, for each repo with `discovery.push`:

1. Fetch the repo's clone (`refs/heads/<default>` refspec). Fetch failure
   skips that repo this tick (logged, never halts the tick).
2. `tip = origin/<default>`; unchanged tip → nothing.
3. Uninitialized state → set `reviewed_tip` to the last commit at-or-before
   `floor` (or the current tip if the branch is younger than the floor) and
   stop: the floor is the review boundary, not a debt.
4. `reviewed_tip` not an ancestor of tip (rewritten history) → record a
   `push_divergence` event and reset `reviewed_tip = tip` without a review.
5. New commits younger than `quiet_minutes` → wait (coalescing window).
6. Otherwise create/refresh one pending `push-current` item per repo:
   base = `reviewed_tip`, head = tip. If a pending, uncaptured push item for
   the repo already exists, mark it `skipped` ("coalesced") and enroll the
   wider range; a captured/reviewing item pins its range and the next range
   waits for it to finish.

`reviewed_tip` advances only when a counted completed review of the pinned
range is harvested.

### Recovering a scan-blocked capture

`crq.py push-recover <item> recapture|release --operator <identity>
--verdict false-positive|source-fixed|abandon --reason <explanation>` is an
explicit operator action under `tick.lock`. It validates the digest-bound
`blocked-secret-scan` receipt against the item's source and capture. It never
changes scanner policy, reserves quota or dispatches a review.

- **recapture** fetches the configured repository and pins its current default
  tip. It retains the old item, capture and receipt as `skipped` history, with
  the operator's disposition in `push_recovery`, and captures a new item from
  the **original base** through that tip. The natural tick must scan this fresh
  projection before any vendor invocation. An unchanged tip is allowed, but
  unchanged flagged content will block again. Existing ids are never reused:
  recovery generations use `-rN`, and overflow parts retain that generation.
- **release** retires the blocked whole range without a replacement. Its
  unchanged tip is not automatically enrolled again. The next changed tip is
  still reviewed from the unchanged `reviewed_tip`, so release is not review
  credit and does not forgive the range. Split-only debt or an already advanced
  boundary requires recapture instead, to avoid losing outstanding paths.

Unstarted active split parts of the same source range are retired together;
recapture rebuilds the whole affected scope, including overflow. Dispatched
active parts refuse recovery and must be harvested first. Both actions retain
`reviewed_tip`, existing receipts and captured objects. A terminal old item
cannot be recovered twice. See [the operator runbook](../ops/push-recovery.md).

This is deliberately explicit rather than automatic supersession on a later
push: unrelated pushes must not silently replace refused evidence. Repository
`.gitleaksignore` files are not imported into the stdin projection scan.
Gitleaks' own inline `gitleaks:allow` behavior is unchanged, but it does not
bypass the independent denylist. Prefer correcting a documentation example
(for example, generating a handshake nonce inline) over weakening scan policy.

## Review unit — reuse of the merged-current machinery

The review unit is the affected-current-additions projection (policy
`affected-current-additions-v1`), exactly as for merged-current, with the
source range generalized:

- `current_paths` gains an explicit `pre` (range base) and a `clone`
  parameter; merged-PR callers pass `merge^1` and the primary clone
  unchanged. Target for a push range is the pinned tip at capture time; a
  follow-up split part reuses its parent capture's target, so the content it
  was created for cannot move before it runs.
- Caps are unchanged and shared: 256 KiB per file (over-cap files are
  `unsupported` rows — a file cannot be split), 2 MiB per review scope,
  1000-path manifest cap. When selected paths exceed the 2 MiB scope cap the
  range **splits by path**: the overflow paths become a follow-up
  `push-current` item (same base/head, `-p2` id suffix, `depends_on` the
  first part) whose capture filters to the remaining paths. Every part is a
  full review; none is silently dropped.
- Capture documents, receipts (`review_receipt.write_receipt`), the
  pre-upload secret scan (denylist + gitleaks over the projection diff) and
  classification are reused verbatim; the denylist remains cq-toolkit's
  `policy/denylist/patterns.yml` (single source of truth) for every repo.
- Scan classes are per-repo. The target repos' subject matter IS the fleet
  (a survey found 78–195 files per repo legitimately matching the
  legacy-hostname and personal-path publish classes), so cq-toolkit's
  *publish* classes (legacy hostnames, client names, personal paths, agent
  memory, package names, agent scratch paths and the gateway-config
  vocabulary) would block nearly every foreign review without protecting
  anything. Non-primary repos scan with the **universal secret-shape
  classes** — token/SSH plumbing, gateway route-key material, key-material
  environment files and inline secret assignments — plus gitleaks
  defaults; the primary
  repo keeps every class. A repo config may add publish classes back via
  `scan_extra_classes`; an id missing from the parsed file fails the scan
  (fail closed), never a silent unfiltered upload.
- `rank()`: items whose `repo` differs from the primary use the repo's
  `rank_tier` (before kind-specific ranks, after optional-cycle rank 5), so
  cq-toolkit ordinary work stays first and new repos sit between it and
  backfill. `ordinary_review_eligible` (rank ≤ 3) therefore covers new-repo
  items; optional additional cycles keep waiting behind them.

## Findings delivery

For non-primary repos with `findings: "issue"`, harvesting a counted completed
review with ≥1 finding files one issue in that repo: title
`crq: <base10>..<head10> — N findings (M blocking)`, body = findings markdown
plus run/receipt identity and a fixed "auto-filed by crq; no auto-fix" note.
Idempotent: the issue URL is stored on the item before state settles; a failed
creation records `issue_error` and is retried on later ticks while findings
remain unreported. The repair drain, backfill, promotion, review ledger,
author quota and coverage stay primary-repo-only; their kind/state filters
ignore `push-current` and foreign-repo items.

## Status and summaries

`status.md`/`status.json` carry `repo` per item (ids already embed it for new
items); the header gains one line per non-primary repo with pending/reviewing
counts and its push reviewed tip. `summary.json` gains a `repos` block:
`{<repo>: {"pending": n, "reviewing": n, "blocked": n, "other": n}}` plus
each repo's `reviewed_tip` once push state exists (idle repos stay visible
with zero counts). The block is additive: `schema_version` stays 2 so
fleet-readers pinned to it accept the summary regardless of deploy order.

## Owner-only actions (not part of this change)

Creating the six clones and any keys on the queue host; GitHub App
installations and repo permissions (issue creation via the existing `gh`
auth); choosing floors and exclude lists per repo; the queue-host deploy
itself (coordinator).
