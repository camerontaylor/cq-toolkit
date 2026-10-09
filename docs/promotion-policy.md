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
by the promotion-review signer as the pinned reviewer bot `cq-promotion-reviewer[bot]` (identity:
the owner's registration record, `app-registration-session-20261004.md` @ `d8f132f` — see
[the interface](#the-crq-interface)).

## What blocks

- A critical or major finding blocks. The signer posts `failure` and the batch waits.
- **Minor** findings go to the crq ledger and never block.
- A blocking finding is cleared only by a fix landing in `merge-queue` followed by a clean **full
  signer review** of `main..<new tip>`: success always means a clean signer-recorded review
  covering the whole range, never a judgment that findings were "addressed". Rejecting a false
  positive is a human decision and goes through an owner override.

## What promotes

`merge-queue-gate` fast-forwards `main` to the **reviewed SHA**, not to whatever the queue tip is
now. Merges that land after the cut wait for the next batch. The gate promotes the SHA only when:

1. The newest `crq/promotion-review` status on it from the pinned reviewer is `success`, and it
   binds `main=<base>`. The pinned reviewer is the `cq-promotion-reviewer` App's bot user, matched
   by all three of creator type `Bot`, login `cq-promotion-reviewer[bot]` and its numeric id
   `339373542`. The identity is not a workflow literal or repo variable: it lives in the
   protected `policy/promotion-reviewer.json` (from the registration record @ `d8f132f`) — the
   merge-queue gate reads it at `GITHUB_SHA`, the signer and crq validate it on `main`, and a
   per-step lockstep test guarantees the gate actually consumes it; a missing, invalid or
   mismatched file leaves the gate refusing fail-closed. Any other creator — including
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

Two gates, one signal. Until C2, `merge-queue-gate` is the promoter and `cq-gate` (`gate.yml`)
runs report-only beside it. C2 retires `merge-queue-gate`, and `cq-gate` — which learned this
signal in PR-C: its subject is the newest queue commit carrying a trusted success bound into
`main`, every check (closure, policy, verdict, verified runs) judges `main..<subject>`, and the
push is a single main-refspec fast-forward that never writes the queue — becomes the only
component that advances `main`. Its verdicts: `promoted`/`noop`/`awaiting` (no reviewed commit
yet) are green; `refused` is red and needs a human; a tip ahead of the reviewed sha simply
waits for its own review.

## Accepted limit

Owner ruling (2026-10-04): the forgeable-status limit below was accepted for #269 and is closed
for the review signal by the pinned reviewer-bot identity — creator type `Bot` plus login
`cq-promotion-reviewer[bot]` plus numeric id `339373542`, carried in the protected
`policy/promotion-reviewer.json` from the registration record @ `d8f132f` (read by the gate at
`GITHUB_SHA`, validated by the signer and crq on `main`; a missing or invalid file refuses
fail-closed).

- A `crq/promotion-review` status now proves an authorized signer action — a completed review, or
  the owner's `crq-override` below (the same bot posts both): the signer's private key lives
  only in the dedicated `crq` account's home on the headless CachyOS signer host (per
  the registration record §Host) — outside an unprivileged agent's reach (see the residuals
  below) — and every promotion outcome is re-derived there. An agent holding the owner's token
  can no longer post a promotion-review success that the gate trusts.
- Residuals, stated plainly: until P0 (removing `ctaylor`'s passwordless sudo on neptune, and
  on the signer host removing `ctaylor` from `docker`/`wheel` and closing sshd password auth — record
  §Deviations 4) a root-capable agent can reach the signer's key, so the signal is T1-proof (no
  overeager-agent forgery), not yet T2-proof; and P1 (the owner's PAT becoming interactive-only)
  is what makes the repository as a whole, not just the signal, agent-proof.
- The crq-side audit stays **detective**. On each tick, crq checks that every `main` advance was
  authorized by a trusted bot success bound to the previous main, and corroborates it against its
  own spool records; anything else raises a loud alert. Only the newest of several promotions
  within one tick is audited.

## Owner override

The owner runs the `crq-override` tool — installed beside the signer in root-owned
`/opt/cq-reviewer/` on the signer host — from a terminal no agent can reach: from the owner's OWN machine,
`ssh` to the signer host, then `sudo -u crq`. The host is headless, so the macOS plan's login-window design
became this: the invariant that survives is that the issuing terminal is unreachable from
neptune's agents, and the session is never routed through neptune. The tool verifies the target
sha is a queue state beyond `main`, computes `main` itself, posts the status as
`cq-promotion-reviewer[bot]`, and logs the override to the signer's audit log:

```sh
sudo -u crq /opt/cq-reviewer/crq-override <sha> "<reason>"    # posts: override main=<current main sha> <reason>
```

An agent cannot produce this status through the documented paths: the key exists only in the
`crq` account's home on the signer host — out of an unprivileged agent's reach, though a root-capable
agent could reach it until P0 lands (see the accepted limit). The gate logs the `override`
prefix in its run summary.

**Accepted limit (the override is not agent-proof today).** The procedure above holds only
while the signer host's ssh and sudo are closed. Today neptune agents reach `ctaylor@` on the
signer host without a
password, and ctaylor holds NOPASSWD sudo and `docker` (root-equivalent) on the signer host — so a
root-capable agent can become root there, reach the PEM, and mint an override or any other
status. Same shape as #269's accepted forgeable-status limit: accepted for the rollout, and
closed only when BOTH (1) signer-host P0 removes ctaylor's NOPASSWD and `docker` membership and
closes sshd password auth, and (2) the owner's signer-host credential is one agents cannot use
(e.g. a FIDO `sk-ssh-ed25519` key requiring physical touch, never a copyable plain key).
Until then the override — like every path in this policy — is T1-grade, not T2-grade.

I4 still applies: an override skips the review, never the required checks.

## When the signer is offline

If the signer host — or the ssh path from crq (neptune) to the spool — is down, nothing posts a review,
so nothing promotes. crq treats ssh failure as **unknown**: no new request, no withdrawal, no
false "signer down"; after 30 minutes it alerts "signer host unreachable" (distinct from the
signer-down alert) and keeps triage. **Promotion waits; nothing fails red.** Gate runs woken
meanwhile end green with "awaiting promotion review". When the signer host returns, crq re-issues the
request and the signer-down timer restarts from recovery. The override needs the same host
(`crq-override` runs on the signer host under `crq` from the owner's own ssh), so while the host is
unreachable there is no remote override path either.

## What a red gate run means

A red run means a human must act. The causes are:

- a `crq/promotion-review` status from a creator other than the pinned `cq-promotion-reviewer[bot]`
  while no trusted review exists (a foreign status alongside a trusted one is inert, not red);
- a reviewed SHA whose required checks failed, were skipped or cancelled, or never reported
  within the timeout;
- a reviewed SHA that is off `merge-queue`;
- a review base that `main` does not contain;
- a diverged `main`;
- a rejected push.

Waiting (no review, a pending review, or a blocked review) and an already-promoted SHA are green
runs.

## The crq interface

Signer mode: every request is a full `base_sha..batch_sha` review — there are no delta items in
the spool and no agent-judged success. The spool contract (`signer/README.md` in the crq repo)
is normative; this section is the policy-level summary.

- **Item kind:** `promotion`, carrying `batch_sha` (40-hex) and `base_sha` (`main` at cut
  time), written to the spool on the signer host over ssh. At most one promotion is open at a time.
- **Priority:** a `promotion` item takes the signer's next start slot ahead of everything
  else. It never pre-empts a running review.
- **Review:** the CodeRabbit CLI over `base_sha..batch_sha`, run by the signer in its own
  detached clone and worktree at `batch_sha` on the signer host, with review configuration restored from
  `base_sha` (a head-side file cannot suppress findings) and the diff secret-scanned before any
  upload. The run counts only when the CLI exits successfully with a terminal, non-skipped
  completion. A failed, rate-limited or auth-failed run posts nothing new (or `error`) and is
  retried. It is never reported as `success`.
- **Coverage:** success comes only from the signer's own recorded clean reviews covering the
  whole range — a full `base_sha..batch_sha` run, optionally a full run the signer extends with
  its own clean internal deltas; a dirty run voids the same range's clean record. The steward
  never sees, requests or judges coverage.
- **Status:** posted by the promotion-review signer (its installation token minted from the App
  key in the `crq` user's home on the offline signer host) as the pinned reviewer bot `cq-promotion-reviewer[bot]`
  (identity per the registration record @ `d8f132f`):
  - `context`: `crq/promotion-review`
  - `state`: `pending` while reviewing; `success` only when the signer's own recorded reviews
    (a full run over `base_sha..batch_sha`, optionally preceded by a full run the signer then
    extends with its own clean internal deltas) covered the whole range with zero critical/major
    findings; `failure` when a completed review found any; `error` for a skipped, oversized,
    secret-scan-blocked or otherwise failed run (the batch is re-cut or escalated, never
    promoted)
  - `description` (140 characters at most) always carries `main=<base_sha>`, for example
    `reviewed main=<base_sha> crq#<id>`,
    `blocked: 1 critical/2 major main=<base_sha> crq#<id>`, or
    `review too_large main=<base_sha> crq#<id>`
  - `target_url`: optional link to the review record
- **After promotion:** `main` equals `batch_sha`. The next batch's base is that SHA.
