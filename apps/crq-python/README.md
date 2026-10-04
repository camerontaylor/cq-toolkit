# crq — CodeRabbit CLI review queue (cq-toolkit)

Pays down the CodeRabbit CLI review debt on `camerontaylor/cq-toolkit` at a
quota-safe pace (≤5 starts per rolling hour, one per 12-minute tick), under
`docs/coderabbit-review.md` (the "protocol"). It is local ops tooling with no
remote, and it is deliberately kept outside cq-toolkit.

## Layout

| Path | What |
|---|---|
| `crq.py` | The runner. Python 3.9, stdlib only. |
| `config.json` | Pacing, timeouts, addressing provider, thresholds, schedule id. |
| `seed.json` | Initial queue, taken from the 2026-10-03 debt audit plus the builder's decisions. |
| `prompts/address.md` | Prompt template for the per-cycle addressing agent (Sonnet). |
| `state/queue.json` | The queue and per-PR cycle records (gitignored). |
| `state/status.md` / `status.json` | **The file to read**: queue table, in-flight work, cooldown, schedule, recent events. |
| `state/events.jsonl` | Append-only event log. |
| `state/runs/<run>/` | Per-review files: `meta.json`, raw `review.ndjson`, `stderr.log`, `exit.json`, `classification.json`, `findings.md`, `secret-scan.json`, plus `address-*` files when an agent is spawned. |
| `state/ledger/{merged,delta}-findings.md` | Ledger-only findings for owner review. |

Git work happens only in a dedicated clone,
`/srv/operator/repos/worktrees/coderabbit-queue-repo`. Each review gets
its own worktree, `worktrees/coderabbit-queue-wt-<run>`, on a local-only `crq/*`
branch. The worktree is removed once the review is harvested. The tooling never
touches the main checkout or any agent's PR worktree.

## Tick (every 12 min, Paseo schedule)

1. Take `state/tick.lock` (a non-blocking flock) and run `git fetch`.
2. **Harvest.** For each finished review, classify the NDJSON:
   - A run is `completed` only when the CLI exits 0, the stream ends in
     `complete` with `review_completed`, and there is no `error` or
     `action_required` event (§4).
   - `rate_limited` → global cooldown, using the server's `waitTime` (or an
     exponential backoff), and the item is requeued. The run is not counted.
   - `auth` or `action_required` → the **whole queue pauses**. `--use-credits` is
     never passed.
   - `error`, `interrupted` or a timeout → the item backs off. After 3 of these
     it becomes `blocked`. A `review_skipped` run blocks the item immediately.
   - A run without `exit.json` is `interrupted` only when it is provably gone:
     neither the runner pid nor the CLI pid in `review.pid` is alive with a
     matching command line.
3. **Enroll** (from `gh pr list`, every tick):
   - An open, non-draft PR into `merge-queue`, or stacked on a chain of open
     PRs that ends there, with no item → an open item (two cycles).
   - A PR whose head moved past its newest completed CLI review, with nothing
     pending, in flight or blocked → one `prN-delta-<sha7>` item covering only
     the new commits. If the PR was restacked meanwhile, the reviewed head is
     replayed onto the new pin (`git merge-tree`), and the review compares the
     new head with that replay. A pure restack is skipped without a run. A
     replay conflict falls back to one full-diff review, not a two-cycle redo.
   - A PR merged into `merge-queue` after the seed: never CLI-reviewed → a
     merged-tier `prN-merged` item (supersession filter applies); reviewed at
     an older head → a post-merge delta (target = the merge's first parent);
     reviewed at the merged head → a `skipped` record, no run.
   - A stacked PR merged into its parent branch shows up as the parent's head
     moving, so the parent's delta covers it.
4. **Start.** Starts are gated by the cap, the cooldown and `max_inflight`.
   Pick the first eligible item in this order: boosted (cycle 2 of an
   in-progress pair), open PR cycles, open-PR deltas, newly merged follow-ups
   (merged-tier `new` and post-merge deltas), then the seeded merged backlog.
   Each open PR or open-PR delta must pass three checks (post-merge deltas
   skip them, since a merged head no longer moves and gets no addressing agent):
   - It is still open and not a draft.
   - No **running** Paseo agent is tied to it. A match is any of: `#N` in the
     title, `pr-N` in the cwd, or a cwd whose git branch is the PR branch.
   - Its last commit and the PR's `updatedAt` are both at least 30 min old.
     This is skipped when the head is our own addressing push.
   - `paseo ls` failing counts as "unknown", which blocks starts.
5. **Pin the base** (§3). The base is `merge-base(origin/<PR base ref>, head)`,
   pinned once per PR and reused for cycle 2.
   - If the pin stops being an ancestor of the head (the PR was restacked), the
     earlier cycles are voided and two cycles are owed again on a new pin.
   - The same applies when a tier-2 PR's recorded cycle-1 base differs from its
     current merge-base. #248 hit this rule: cycle 1 was at `596afb85`, it is
     now at `70de728`.
6. **Secret-scan** the added and removed lines of `base..head` (§1). This
   applies the 9 classes in `policy/denylist/patterns.yml` (read from
   `origin/merge-queue`) plus the `gitleaks stdin` default rules. Any hit
   blocks the item. Matched content is never written down.
7. Launch `coderabbit review --agent --base-commit <pin>` (`gtimeout 75m`)
   through a double fork (`sh -c '… & echo $!'`). The runner is reparented to
   launchd before the tick returns. The runner writes `review.pid` (its pid and
   the CLI pid). A later tick harvests the run.

## Findings

- **Open PRs.** If a cycle has ≥1 critical or major finding, one Sonnet
  addressing agent runs.
  - It works in its own worktree (`coderabbit-queue-addr-*`), fixes the valid
    findings and rebuts the false positives.
  - Checks are focused only; it never runs full suites.
  - It pushes fast-forward only. If its base moved by a force-push it stops.
  - It writes `address-result.json` with its dispositions.
  - With no critical or major findings, minor ones are recorded and not
    chased. Cycle 2 is then queued on the same pin (it is mandatory, §5).
  - The queue stops at 2 cycles. If fixes land after cycle 2, the status shows
    them, and they still need non-author review before any ready claim.
- **Merged and delta items.** One review each. Findings go to
  `state/ledger/`. No follow-up PRs or issues are opened without owner
  approval.

## Promotion to `main` (cq-toolkit `docs/promotion-policy.md`, PR #269)

crq does nothing for promotion until `origin/main` contains `docs/promotion-policy.md`.
After that, `main` advances only to a merge-queue sha that carries a `crq/promotion-review`
status, and crq posts that status.

- **Cut** (`promotion_tick`, at most one promotion open): triggers are on demand
  (`crq.py promote`), ≥5 first-parent merges in `main..merge-queue`, or ≥8 h since the last
  promotion with ≥1 merge. The batch is the newest first-parent merge-queue commit whose
  `static`, `denylist` and `ratchet` checks all passed. Like the gate's I4 rule, this reads
  `check-runs?filter=latest` and requires every row with that name to be completed+success.
  The base is `main` from `gh api …/git/ref/heads/main`.
- **Start**: a `promotion` item takes the next start slot ahead of everything else. The cap,
  cooldown, `max_inflight` and secret scan still apply, and it never pre-empts a running
  review. It reviews `base..batch` (or `reviewed..batch` for a delta) in a detached worktree at
  the batch, and posts `pending` when the review starts.
- **Harvest**: no critical/major finding → `success` (`reviewed main=<base> crq#<id>` or
  `delta <reviewed12>.. main=<base> crq#<id>`), then state `promoting`. Otherwise →
  `failure` (`blocked: N major main=<base>`), then state `findings`. Findings also go to
  `state/ledger/promotion-findings.md`.
  - Failed, interrupted or rate-limited runs post nothing new and are retried (backoff ≤60
    min). They are never blocked.
  - A CLI-skipped review posts `error` and the item is blocked, so the owner must re-cut or
    override.
- **Findings**: crq cannot tell by itself that a finding is addressed. Someone runs
  `crq.py promotion-resolve <n|all> "<fixed in PR #N | rebuttal>"`. Once all are resolved:
  - the newest green tip descends from the batch → a delta item over `batch..tip`, still
    bound to the original base;
  - the tip is unchanged → `success` on the batch itself ("blocking dispositioned");
  - the tip does not descend → re-cut from `main`.
- **Promoting**: when `main` contains the batch, the promotion is done. If `main` has not
  moved 20 min after `success`, crq dispatches `merge-queue-gate.yml -f sha=<batch>` once.
  If `main` moves somewhere that lacks the base, crq re-cuts.
- **Identity**: statuses are posted with the host's `gh` auth. Before every post, crq checks
  `gh api user` is `camerontaylor` (User) and refuses otherwise, because a non-allowed creator
  turns the gate red. Config: `config.json` `promotion`.

## Merged PRs: supersession and the synthetic diff

- **Survival.** Take the lines the PR added (`git diff --numstat merge^1
  merge`). Count how many are still attributed by `git blame -w -M` at
  `origin/merge-queue` to the PR's own commits (`merge^1..merge^2` plus the
  merge). Reformatting counts as superseded, so this is a lower bound.
- **Per-file focus.** For each PR path, compare the PR's surviving lines with
  the path's added lines from pre-merge to now. A path is reviewed only when
  that share is ≥0.25, which keeps hot files full of other PRs' work out of
  the review.
- **Synthetic pair.** Both commits descend from current merge-queue. The chain
  is `MQ → B'` → `H`:
  - `B'` sets the selected paths back to their pre-merge content.
  - `H` has a tree identical to MQ.
  - Reviewing `H` against `B'` shows what the PR introduced plus every later
    change to those paths, with **today's** tree as review context.
  - The refs are written to `refs/crq/synth/prN-{base,head}` in the clone.
    Rebuild them with `crq.py synth N`.
- A PR is skipped when survival is <0.25 or fewer than 15 covered lines remain.
  `crq.py measure` prints the full table.

## Operating

```bash
cd /srv/operator/repos/coderabbit-queue
cat state/status.md                       # what's happening
python3 crq.py tick --dry-run             # what the next tick would do, and why others wait
python3 crq.py pause "reason"             # queue-level pause (ticks still harvest)
python3 crq.py resume
paseo schedule pause <schedule_id>        # stop ticks entirely
paseo schedule resume <schedule_id>
python3 crq.py requeue|skip|block <item> ["reason"]
python3 crq.py start <item> [--ignore-quiet]   # one targeted tick (still capped/scanned)
python3 crq.py measure                    # recompute supersession for merged PRs
```

Tick agents are Paseo `claude/claude-haiku-4-5` runs that only execute
`crq.py tick`. The runner archives each finished tick agent and its workspace
once, keeping the last 3. It tracks them in `queue.json` `archived_tick_runs`.

**Why reviews must never be children of the tick (2026-10-04).** A tick agent
runs `crq.py tick` with a 120 s Bash foreground limit. A slower tick is moved
to the background, and the agent ends its turn. Claude Code then kills that
task's whole descendant tree by ppid, which `setsid` does not escape. Re-archiving
all ~117 past tick agents each tick made every tick about 6 min long, so every
review still running about 2 min after launch was killed. That was 20 of 28
merged-tier runs, logged as "interrupted: no exit status recorded" at the next
tick. Two changes fix it: the double fork above (a review survives any tick or
agent) and archive-once (a tick takes about 20 s).

**Workspaces.** Paseo 0.11 schedules cannot target a workspace, so each tick
agent gets its own throwaway workspace, which is archived as above.
`paseo run --workspace <id>` replaces `--cwd` with the workspace's own
directory. So addressing agents keep `--new-workspace local`, which keeps them
in their worktree. That workspace is renamed `crq · address PR #N cN`.
