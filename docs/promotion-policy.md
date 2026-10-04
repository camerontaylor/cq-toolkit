# Promotion policy: batched, CodeRabbit-reviewed promotion to `main`

Owner ruling, 2026-10-04. Merging into `merge-queue` stays lenient: required checks green plus
basic review, with the CodeRabbit CLI queue (crq) following up afterwards. **Promotion to `main`
is the one place a CodeRabbit review is required before merge**, and promotion reviews get first
claim on review slots. The gate no longer promotes on every green queue push.

## When a batch is cut

crq cuts a batch on the first of these:

- **On demand.** The owner (or the chancellor) asks crq to cut a promotion.
- **N = 5** merges into `merge-queue` since the last promotion.
- **T = 8 hours** since the last promotion, with at least one unpromoted merge.

The **batch tip** is the newest `merge-queue` commit whose gate wait list (`static`, `denylist`,
`ratchet`) has _completed with success_. A commit whose checks are pending, failed or cancelled
(a superseded intermediate tip) is never a batch tip. If no such commit exists, crq waits for
checks to finish. The **base** is `main` at cut time. Only one promotion is open at a time.

## What gets reviewed

One CodeRabbit CLI review of `main..<batch tip>`, pinned to the two SHAs (never a moving branch).
crq gives a `promotion` item **absolute priority for the next start slot** (crq allows at most 5
starts per hour). It does not pre-empt a running review.

crq reports the state as a commit status on the batch tip: context `crq/promotion-review`, posted
with the owner's `gh` auth (see [the interface](#the-crq-interface)).

## What blocks

- An **unaddressed critical or major** finding blocks. crq posts `failure` and the batch waits.
- **Minor** findings go to the crq ledger and never block.
- Fixes land in `merge-queue` through normal PRs. The new batch tip `T2` must descend from the
  reviewed tip `T1`. crq runs a **delta review of `T1..T2` only**. When it is clean and the
  blocking findings are addressed, crq posts `success` on `T2`, still bound to the **original
  base**: `base..T1` was covered by the full review and `T1..T2` by the delta review.

## What promotes

`merge-queue-gate` fast-forwards `main` to the **reviewed SHA**, not to whatever the queue tip is
now. Merges that land after the cut wait for the next batch. The gate promotes the SHA only when:

1. The newest `crq/promotion-review` status on it from an allowed reviewer is `success`, and it
   binds `main=<base>`. Allowed reviewers are user accounts listed in `vars.CQ_PROMOTION_REVIEWERS`
   (blank means the repository owner). Statuses posted with `GITHUB_TOKEN` or by any App come from
   Bots and never count, so a PR head's workflow cannot forge one. The gate re-reads the status
   immediately before the push: if a newer one (such as a crq `failure`) arrived during the check
   wait, it promotes nothing.
2. Every required check on its wait list succeeded **on that SHA** (I4: skipped, cancelled or
   missing is never a pass).
3. It is on `merge-queue`'s first-parent line (a queue state, not a PR-branch commit reached
   through a merge's second parent), `main` is an ancestor of it, and `<base>` is in `main`. A
   base that `main` does not contain would leave unreviewed commits in `main..sha`.

The crq status event wakes the gate. A dispatch of `merge-queue-gate` with a `sha` re-runs it.
Gate runs serialize per target SHA, so a tip dispatch never displaces a queued promotion of a
reviewed SHA.
`cq-gate` (`gate.yml`) runs report-only while this policy holds. It must learn this signal before
C2 retires `merge-queue-gate`.

## Accepted limit

Owner ruling (2026-10-04): accept this limit now, fix it with a dedicated identity later.

- Every fleet agent runs `gh` as the owner, so a `crq/promotion-review` status is not proof
  against a misbehaving agent. The allowed-reviewer check rules out only `GITHUB_TOKEN`, App and
  fork forgery.
- The compensating control is **detective**. After every promotion, crq matches the status that
  promoted `main` against its own review ledger. A promotion status with no matching crq record
  raises a loud alert. This check lives on the crq side, implemented by the crq steward.
- The fix is a dedicated reviewer identity. Follow-up: dedicated crq reviewer App.

## Owner override

The owner posts the status by hand. The gate logs it as an override in its run summary:

```sh
gh api -X POST repos/camerontaylor/cq-toolkit/statuses/<sha> \
  -f context=crq/promotion-review -f state=success \
  -f description="override main=$(gh api repos/camerontaylor/cq-toolkit/git/ref/heads/main --jq .object.sha) <reason>"
```

I4 still applies: an override skips the review, never the required checks.

## When the crq host is offline

Nothing posts a review, so nothing promotes. **Promotion waits; nothing fails red.** A gate run
woken by sync's dispatch or by hand ends green with "awaiting promotion review". When the host
returns, crq picks up from the last promotion: it cuts a batch if a trigger has fired.

## What a red gate run means

A red run means a human must act. The causes are:

- a `crq/promotion-review` status from a creator who is not an allowed reviewer;
- a reviewed SHA whose required checks failed, were skipped or cancelled, or never reported
  within the timeout;
- a reviewed SHA that is off `merge-queue`;
- a review base that `main` does not contain;
- a diverged `main`;
- a rejected push.

Waiting (no review, a pending review, or a blocked review) and an already-promoted SHA are green
runs.

## The crq interface

- **Item kind:** `promotion`, carrying `batch_sha` (40-hex), `base_sha` (`main` at cut time), and
  for a delta item, `reviewed_sha` (the previously reviewed tip, an ancestor of `batch_sha`).
- **Priority:** a `promotion` item takes the next start slot ahead of everything else, and so does
  its delta re-review. It never pre-empts a running review. At most one promotion is open at a
  time.
- **Review:** the CodeRabbit CLI over `base_sha..batch_sha`, or `reviewed_sha..batch_sha` for a
  delta item, run in a detached checkout at `batch_sha`. The run counts only when the CLI exits
  successfully with a terminal, non-skipped completion. A failed, rate-limited or auth-failed run
  posts nothing new (or `error`) and is retried. It is never reported as `success`.
- **Status:** `POST repos/<owner>/<repo>/statuses/<batch_sha>` with the owner's `gh` auth:
  - `context`: `crq/promotion-review`
  - `state`: `pending` while reviewing, `success` when no critical/major finding is unaddressed,
    `failure` when one is
  - `description` (140 characters at most) always carries `main=<base_sha>`, for example
    `reviewed main=<base_sha> crq#<id>`, `delta <reviewed_sha12>.. main=<base_sha>`, or
    `blocked: 2 major main=<base_sha>`
  - `target_url`: optional link to the review record
- **After promotion:** `main` equals `batch_sha`. The next batch's base is that SHA.
