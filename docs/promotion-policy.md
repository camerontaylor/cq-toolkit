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

Promotion review covers `main..<batch tip>`, pinned to the two SHAs (never a moving branch).
Clean coverage comes from a clean full review or signer-recorded clean internal deltas
extending clean full coverage, only while no dirty taint exists. See the coverage rule below.
crq gives a `promotion` item **absolute priority for the next start slot** (crq allows at most 5
starts per hour). It does not pre-empt a running review.

crq reports the state as a commit status on the batch tip: context `crq/promotion-review`, posted
by the promotion-review signer as the pinned reviewer bot `cq-promotion-reviewer[bot]` (identity:
the owner's registration record, `app-registration-session-20261004.md` @ `408c87f` — see
[the interface](#the-crq-interface)).

## What blocks

- A critical or major finding blocks. The signer posts `failure` and the batch waits.
- **Minor** findings go to the crq ledger and never block.
- A dirty batch cannot be cleared by a same-byte rerun, even a clean full rerun. A blocking
  finding requires a fix landing in `merge-queue`, a post-fix new batch, and a fresh clean
  **full signer review** of `main..<new tip>` completed after the latest dirty result.
  Clean internal deltas cannot clear dirty taint. Rejecting a false positive is a human
  decision and goes through an owner override.

## What promotes

`merge-queue-gate` fast-forwards `main` to the **reviewed SHA**, not to whatever the queue tip is
now. Merges that land after the cut wait for the next batch. The gate promotes the SHA only when:

1. The newest `crq/promotion-review` status on it from the pinned reviewer is `success`, and it
   binds `main=<base>`. The pinned reviewer is the `cq-promotion-reviewer` App's bot user, matched
   by all three of creator type `Bot`, login `cq-promotion-reviewer[bot]` and its numeric id
   `339373542` (pinned in the gate template from the registration record @ `408c87f`, not a repo
   variable; an UNSET token leaves the gate refusing fail-closed). Any other creator — including
   the repository owner's own
   login, `GITHUB_TOKEN`, and every App — never counts, and a promotion-review status from one is
   a red refusal when no trusted review exists. The gate re-reads the status
   immediately before the push: if a newer one (such as a signer `failure`) arrived during the
   check wait, it promotes nothing.
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

Owner ruling (2026-10-04): the forgeable-status limit below was accepted for #269. The gate
now filters the review signal by the pinned reviewer-bot identity — creator type `Bot` plus login
`cq-promotion-reviewer[bot]` plus numeric id `339373542`, from the registration record @
`408c87f` (the gate refuses fail-closed while unpinned).
PR-B remains on hold until S2 observes the actual status creator as
`cq-promotion-reviewer[bot]` / `339373542` / `Bot` on the scratch repository.

- The gate accepts only the pinned creator identity; the owner's token alone cannot post a
  trusted review status. The App key lives in the dedicated `crq` account's home on ceres,
  the headless CachyOS signer host (registration record §Host). This identity filter does
  not prove exclusive signer custody while agents can obtain root on either host.
- Owner D10 owns the infrastructure hardening. Until the owner hardens both neptune and
  ceres, root-capable agents can reach the key. This includes removing agent-reachable
  passwordless sudo, ceres's root-equivalent `docker` access, and revisiting sshd password
  authentication, plus restricting the owner's credentials to interactive use. D4 also
  requires a dedicated restricted forced-command spool key; the spool transport must not
  grant an agent a general shell or access to the signer key. These are outstanding
  conditions, not evidence of owner approval or completed hardening.
- The crq-side audit stays **detective**. On each tick, crq checks that every `main` advance was
  authorized by a trusted bot success bound to the previous main, and corroborates it against its
  own spool records; anything else raises a loud alert. Only the newest of several promotions
  within one tick is audited.

## Owner override

The owner runs the `crq-override` tool — installed beside the signer in root-owned
`/opt/cq-reviewer/` on ceres — from the owner's own machine,
`ssh ceres`, then `sudo -u crq`. ceres is headless, so the macOS plan's login-window design
became this intended procedure: the issuing session must not be routed through neptune.
Its isolation remains conditional on the outstanding owner hardening below. The tool verifies
the target sha is a queue state beyond `main`, computes `main` itself, posts the status as
`cq-promotion-reviewer[bot]`, and logs the override to the signer's audit log:

```sh
sudo -u crq /opt/cq-reviewer/crq-override <sha> "<reason>"    # posts: override main=<current main sha> <reason>
```

The gate logs the `override` prefix in its run summary.

**Accepted limit (the override is not agent-proof today).** Neptune agents can reach
`ctaylor@ceres` without a password, and ctaylor holds NOPASSWD sudo and root-equivalent
`docker` access on ceres. A root-capable agent can reach the PEM and mint an override or
another trusted status. The accepted inability to be agent-proof remains until owner D10
hardens both neptune and ceres, restricts owner authentication to credentials agents cannot
use, and D4 supplies a dedicated restricted forced-command spool key. A physical-touch
credential alone does not close existing agent-reachable root or general-shell paths.
The terminal procedure above is conditional; it is not a claim of agent-proof isolation.

I4 still applies: an override skips the review, never the required checks.

## When the signer is offline

Nothing posts a review while ceres is down, so nothing promotes. **Promotion waits; nothing
fails red.** A gate run woken by sync's dispatch or by hand ends green with "awaiting promotion
review". When the host returns, crq picks up from the last promotion: it cuts a batch if a
trigger has fired. The override needs the same host (`crq-override` runs on ceres under `crq`
from the owner's own ssh), so while the host is down there is no remote override path either.

## What a red gate run means

A red run means a human must act. The causes are:

- a `crq/promotion-review` status from a creator other than the pinned `cq-promotion-reviewer[bot]`;
- a reviewed SHA whose required checks failed, were skipped or cancelled, or never reported
  within the timeout;
- a reviewed SHA that is off `merge-queue`;
- a review base that `main` does not contain;
- a diverged `main`;
- a rejected push.

Waiting (no review, a pending review, or a blocked review) and an already-promoted SHA are green
runs.

## The crq interface

Signer mode, which this change arms: every request is a full `base_sha..batch_sha` review —
there are no delta items and no agent-judged success. The delta-item mechanics in the next three
bullets describe the interim user mode and are rewritten when the policy doc is (PR-D).

- **Item kind:** `promotion`, carrying `batch_sha` (40-hex), `base_sha` (`main` at cut time), and
  for a delta item, `reviewed_sha` (the previously reviewed tip, an ancestor of `batch_sha`).
- **Priority:** a `promotion` item takes the next start slot ahead of everything else, and so does
  its delta re-review. It never pre-empts a running review. At most one promotion is open at a
  time.
- **Review:** the CodeRabbit CLI over `base_sha..batch_sha`, or `reviewed_sha..batch_sha` for a
  delta item, run in a detached checkout at `batch_sha`. The run counts only when the CLI exits
  successfully with a terminal, non-skipped completion. A failed, rate-limited or auth-failed run
  posts nothing new (or `error`) and is retried. It is never reported as `success`.
- **Coverage (PR-A contract):** success requires signer-recorded clean full coverage or
  clean internal deltas extending it, only absent dirty taint. A completed dirty review
  (any critical/major finding) invalidates clean coverage and stays sticky for that batch.
  A same-byte rerun cannot clear it. After a fix, a new batch requires a fresh clean full
  review covering the whole range after the latest dirty result; internal deltas cannot
  satisfy this recovery requirement. Failed, skipped or incomplete runs cannot clear taint.
  Coverage is determined by signer records, never an agent's judgment of addressed findings.
- **Status:** posted by the promotion-review signer (its installation token minted from the App
  key in the `crq` user's home on ceres) as the pinned reviewer bot `cq-promotion-reviewer[bot]`
  (identity per the registration record @ `408c87f`):
  - `context`: `crq/promotion-review`
  - `state`: `pending` while reviewing; `success` only with clean whole-range coverage
    under the sticky coverage rule above; `failure` when a completed review found any
    critical/major finding; `error` for a skipped, oversized, secret-scan-blocked or otherwise
    failed run (the batch is re-cut or escalated, never promoted)
  - `description` (140 characters at most) always carries `main=<base_sha>`, for example
    `reviewed main=<base_sha> crq#<id>`,
    `blocked: 1 critical/2 major main=<base_sha> crq#<id>`, or
    `review too_large main=<base_sha> crq#<id>`
  - `target_url`: optional link to the review record
- **After promotion:** `main` equals `batch_sha`. The next batch's base is that SHA.
