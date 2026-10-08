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
- **Skipped or too large** (`review_skipped`, or a size refusal classified as `too_large`): no
  escalation at first.
  - crq re-cuts the oldest contiguous half of the batch's merges, at the newest green commit
    within that half, and keeps halving until CodeRabbit accepts.
  - The original tip is then promoted prefix by prefix (`continue_to`), each prefix at most the
    accepted size (`batch_cap`).
  - A chain that carries resolved findings never posts `success` short of its fix tip
    (`must_reach`). Clean prefixes before the fix just chain to the next delta.
  - Only a refused single-merge batch escalates: an `error` status, a
    `promotion_escalated` event, an OWNER OVERRIDE banner and a Paseo alert.
  - `status.md` lists every attempt (`promotion attempts`) with its size and reason.
  - A promotion whose batch is already in `main`, for example after an override, closes itself.
- **Findings**: crq cannot tell by itself that a finding is addressed. By the chancellor's
  ruling, the **acceptance conductor** runs `crq.py promotion-resolve <n|all> "<fixed in PR #N |
  rebuttal>"` once the fix is in merge-queue. The PROMOTION BLOCKED banner in `status.md` names
  the conductor (`promotion.resolver`). Once all are resolved:
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

### Signer mode (promotion reviewer bot, contract v1 with 4cc7efeb)

**Reviewer identity.** The reviewer is `promotion.signer.app_login` (a `…[bot]` login) plus
`reviewer_bot_id` (the numeric bot user id). These are taken ONLY from the owner's
registration record, `toolkit-research/plans/app-registration-session-20261004.md`, and never
from a public-API lookup by name. Until that record exists both are `null`. crq has no
built-in defaults. An unset, malformed or banned identity is never trusted (fail closed).
`cq-reviewer[bot]`/`202921479` is a THIRD PARTY's public App (owner `cqrect`, App 1175046). It
was wrongly pinned on 2026-10-04, is banned in code, and `crq.py selfcheck` fails if it
appears in `config.json`.

**Mode** is judged from the gate at a given rev (`origin/main` for crq's own actions, the
previous `main` for the audit):
- `user`: the gate has no bot pin. This is the #269 User-allowlist gate, and today's behaviour.
- `signer`: the gate renders `--arg bot_login '<login>'` … `--argjson bot_id <n>`, and that
  pair EXACTLY equals crq's configured identity.
- `signer_unconfigured`: the gate's pin is PR-B's UNSET sentinel (`@@UNSET-REVIEWER-BOT-LOGIN@@`
  / `-1`), pins an identity crq doesn't have, or is in a format crq doesn't recognise.
  Promotion HALTS with a "reviewer identity not pinned" alert, and crq posts no User statuses
  (the gate would refuse them red).

Going live is one config edit (`app_login` + `reviewer_bot_id` from the record), alongside
the gate's pin and the signer's config.

In signer mode the signer runs the CodeRabbit CLI. It is a systemd unit running as user `crq` on **queue-host**. It does the
secret scan, and posts every status. crq judges nothing and posts nothing:

- **Transport**: the spool is `queue-host:/var/lib/crq-spool` (`promotion.signer.spool`).
  - crq runs on worker-host and talks to it over ssh. queue-host stays outbound-only.
  - **Dedicated key only (owner decision D4)**: the invocation is `ssh -i <spool.ssh_key>
    -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes <spool.ssh_alias>
    '<verb> <args>'`.
  - On queue-host that key is pinned in operator's `authorized_keys` to the forced command
    `/opt/cq-reviewer/spool-shell` (no-pty, no forwarding, restrict). It can run only these
    verbs: `put <id>` (body on stdin), `snapshot <id>`, `withdraw <id>`, `read backoff -`,
    `read result <id>`, `exist <id>…`.
  - With no key configured crq refuses to talk to the spool (fail closed).
    `legacy_shell: true` is an explicit plain-shell fallback, pending the owner's D4 call.
  - Keep the private key outside this repo (e.g. `~/.ssh/crq-spool-ed25519`).
  - Ids must match `^promo-[0-9a-f]{10}\+{0,9}$` before any command is built.
  - A per-item snapshot (claimed / request / result) costs one round trip per tick.
  - **ssh or spool failure means the state is unknown**: no new request, no withdrawal, never
    counted as signer-down. After 30 min a distinct "queue-host unreachable" alert fires once.
    After recovery, the signer-down timer restarts from the recovery time.
  - `host: null` makes it a local directory, used only by simulations.
- **Request**: crq writes `requests/<id>.json` with
  `{v,kind:"promotion",item,base_sha,batch_sha,requested_at}`.
  - The write is atomic (tmp + rename), and the file is never rewritten.
  - The id matches `promo-<sha10>` plus up to nine `+`. Ids are fresh: not used in the queue
    or in `results/`.
  - At most one request is outstanding.
  - A request counts as a start and as in flight under crq's ≤5/h and ≤2 limits.
  - Every request is a FULL `main..batch` review. There are no deltas.
- **Shared quota and deferrals**: the signer checks its coverage and budget before claiming,
  and may DEFER a request unclaimed. It publishes the deferral in `ledger/backoff.json`
  (`{v,item,wait_minutes,until,at,reason}`).
  - `reason: "rate_limit"` (or no reason): shared CodeRabbit quota, so crq extends its global
    cooldown. A rate-limited result does the same.
  - `reason: "budget"`: the signer's own 2/h cap. It does not touch crq's cooldown, so PR
    reviews keep running.
  - Either way, the signer-down timer counts from the later of `requested_at` and the
    deferral's `until`.
- **Spool permissions (queue-host)**: the parent is root:root 0755. `requests/` is `root:crq-spool`
  2775 (setgid, no sticky bit), and `operator@queue-host` and `crq` are both in `crq-spool`.
  `results/` and `ledger/` are crq:crq 0755 with files 0644. crq reaches queue-host as
  `operator@queue-host` over ssh, so a new group applies on the next ssh login. The signer
  renames a request to a dot-name before it writes `.claimed`, so crq's pre-claim withdrawal
  either wins or gets ENOENT. Any group member can replace a request, but the
  signer's `request_sha256` echo makes a swapped request visible to crq as a mismatch alert.
- **Claim / stall**: `results/<id>.claimed` means the run is in flight. crq alerts if a claimed
  run has no result after 90 min, or a request stays unclaimed for 30 min past any published
  deferral (signer down).
  - If `main` moves before the claim, crq withdraws its own request and re-cuts.
- **Result**: `results/<id>.json` must echo the item, base and batch, plus
  `request_sha256` of crq's bytes. On a mismatch crq alerts and ignores the file.
  - `completed`+`success` → `promoting`.
  - `completed`+`failure` → `findings`. The banner names the conductor, whose
    `promotion-resolve` triggers a full re-review of `main..newest-green-tip`. There is no
    agent-judged success.
  - `skipped`/`too_large` → halve (as in user mode, but every prefix is a full review).
  - `rate_limited` → global cooldown, then a fresh id.
  - `auth` → queue pause plus an alert.
  - `error`/`interrupted` → backoff, then a fresh id.
  - `secret_scan_blocked` → alert.
  - `rejected`/`error` that carry a `reason_code` are handled by code, never by reason text:
    `success_present`/`already_in_main` → done; `base_not_main`/`main_not_ancestor`/
    `checks_not_green`/`subject_moved` → re-cut; anything else (`gate_not_pinned`,
    `bad_request`, `coverage`, `internal`, `not_on_queue`, …) → alert. A `rejected` without a
    code is also an alert. A plain `error` with no code is retried.
  - `completed` with no final status (the signer's post failed) → retry with backoff. The
    signer's coverage ledger usually posts without a new CLI run.
  - Findings and severity counts go to `state/ledger/promotion-findings.md`.
- **Switch-over**: a user-era promotion still open when the gate switches is re-requested
  once as a signer item.
- **Audit**: the advance is judged by the gate that ran, i.e. the previous `main`'s copy.
  - Primary rule: the newest status by (configured `app_login`, `Bot`, `creator.id ==
    reviewer_bot_id`) must be `success`, and its `main=<base>` must be contained in the previous
    `main`. With the identity unset nothing is trusted. Otherwise **UNVERIFIED** with an alert.
  - `override…` statuses are logged, not alerted.
  - Corroboration is informational (`promotion_uncorroborated` event): `crq#<id>` is a crq item
    for this batch, and its result has `posted.status_id`/`state` matching the authorizing
    status and `request_sha256` matching crq's request.

### Promotion audit (compensating control for #269's accepted P1)

Any fleet agent that holds the owner's `gh` auth can post `crq/promotion-review`. So every
tick, whatever `promotion.enabled` says, crq polls `main` with GET requests only. When `main`
has moved since the last tick, crq finds the newest allowed-User `crq/promotion-review` on the
new sha and classifies the advance:

- **verified**: the authorizing status is `success`, crq has a `promotion` item for that batch
  sha with a completed review, and crq itself posted that exact status. crq records each
  status id it posts, and the audit matches on that id.
- **UNVERIFIED**: anything else. Examples: no qualifying status, a status crq did not post,
  no crq item or no completed review, `main` not fast-forwarded, or an `override` status.
  crq then raises an alert:
  - a banner at the top of `state/status.md`, until `crq.py promotion-ack <sha|all> "<reason>"`;
  - a `promotion_unverified` event;
  - a `paseo send --no-wait` to the chancellor (`promotion.alert_agent_id`). This path was
    verified to deliver from the Background launchd session that ticks run in;
  - a best-effort `osascript` notification. It exits 0 in that session but may not display.
- **pre-policy**: the previous `main` did not yet contain `docs/promotion-policy.md`, so the
  advance happened under the old gate.

Every advance is appended to `state/ledger/promotion-audit.md`. If two promotions land within
one tick, only the newest `main` is audited.

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

**Tick health (2026-10-08).** A tick takes about 10 s. Tick-agent cleanup runs after
`status.md` and the heartbeat are written, with a 30 s budget (`cleanup_budget_s`), and saves
progress after every archive. Any backlog carries over to the next tick. The previous design
wedged for ~25 h: 101 failed OAuth runs piled up, a 500-entry cap made crq forget the oldest
runs, every tick took ~330 s, and none persisted. A tick that finds the previous completed tick
more than 36 min old (`stale_alarm_min`) messages the chancellor.

**Watchdog.** `ops/crq-watchdog.py` runs with no agent, from the LaunchAgent
`ops/com.crq.watchdog.plist`, every 10 min. It is installed as copies at
`~/Library/Application Support/crq/crq-watchdog.py` and `~/Library/LaunchAgents/`.
- It reads only `~/Library/Application Support/crq/heartbeat.json`, which every completed tick
  writes. macOS TCC blocks launchd-started python from reading the external volume.
- If the heartbeat is older than 36 min, it alerts the chancellor once per outage (Paseo plus
  a macOS notification). A Paseo schedule run that "succeeded" proves nothing.
- Log: `~/Library/Logs/crq-watchdog.log`. After editing `ops/crq-watchdog.py`, copy it to the
  install path again.

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
