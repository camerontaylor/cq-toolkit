# Promotion policy: every-green-tip, CodeRabbit-reviewed promotion to `main`

Owner ruling, 2026-10-16. Merging into `merge-queue` stays lenient: required checks green plus
basic review, with the CodeRabbit CLI queue (crq) following up afterwards. **Promotion to `main`
is the one place a CodeRabbit review is required before merge**, and promotion reviews get first
claim on review slots. crq cuts a promotion as soon as a `merge-queue` tip beyond
`main` has all gate checks green; merges that land during an in-flight review
join the next promotion.

**Amended 2026-10-24 (owner, cq-toolkit#376): the signer review is advisory except for privileged
ranges.** The gate requires a `crq/promotion-review` success only when the promoted range
`main..<subject>` touches a path on the privileged list (`protectedPaths` in
`policy/protected-paths.json` at the trust ref — signer and reviewer config, the denylist, the
settings-drift scripts and template, attestations, `promote-gate.ts`, and crq's
signer/config/systemd). Every other range promotes on core CI green at the exact SHA, the `cq/ratchet`
verdict, and `cq/acceptance` evidence for every admitted PR; crq and the signer still review it
and still file findings, but a missing, pending or failed review never refuses. See
[Advisory signer review](#advisory-signer-review-except-privileged-ranges). Where the sections
below say a review is required, read "for a privileged range".

## When a promotion is cut

crq cuts a promotion whenever a `merge-queue` tip beyond `main` has all gate
checks green. There is no merge-count or elapsed-time threshold. The **promotion
tip** is the newest `merge-queue` commit whose gate wait list (`static`,
`denylist`, `ratchet`) has completed with success. A commit whose checks are
pending, failed or cancelled (a superseded intermediate tip) is never a
promotion tip. If no such tip exists, crq waits for checks to finish. The
**base** is `main` at cut time. The only throttles are crq's hourly start cap
(`max_starts_per_hour`), the CodeRabbit rate-limit cooldown, the signer's
own 2-per-hour start cap, and one promotion in flight at a time.

## What gets reviewed

One CodeRabbit CLI review of `main..<batch tip>`, pinned to the two SHAs (never a moving branch).
crq gives a `promotion` item **absolute priority for the next start slot**
(`max_starts_per_hour` starts per hour). It does not pre-empt a running review.

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

## Advisory signer review except privileged ranges

The gate walks `merge-queue`'s first-parent line newest-first and classifies each candidate's range
`main..<sha>` with the ONE privileged-path predicate `gates.policyDiff` uses for its
`privileged-path` finding (`privilegedPathPredicate` in `src/ops/gates/policyDiff.ts`, fed the
trust ref's list — there is no second list):

- **Ordinary range** (no privileged path): selected as the subject outright. The signer status is
  recorded in the decision output's `signer` field — `present` (a trusted success bound to the
  current `main`), `advisory-missing` (none, pending, or bound to another base) or
  `advisory-failed` (a trusted failure or a malformed success) — and is not re-read before the
  push.
- **Privileged range**: exactly the rules below — a trusted success bound to the current `main`,
  re-read immediately before the push (`signer: required`). Without one the walk moves on, so an
  older ordinary prefix of the queue can still promote while the privileged tip waits for its
  own review.
- **Fail closed**: if the list is absent at the trust ref every range is privileged; an invalid
  list refuses.

Unchanged for every range: core CI and the verdict at the exact SHA, closure, clean merges, per-PR
`cq/acceptance` evidence, the policy recompute, the `cq/promoted` replay marker, the leased
exact-SHA `--atomic` fast-forward (never a force push), and the denylist. A foreign
promotion-review status on the tip still refuses when no subject is selected.

## What promotes

`cq-gate` (`gate.yml`, armed) fast-forwards `main` to the **reviewed SHA**, not to whatever the queue tip is
now. Merges that land during an in-flight review join the next promotion.
The gate promotes the SHA only when (item 1 for privileged ranges only — see above):

1. The newest `crq/promotion-review` status on it from the pinned reviewer is `success`, and it
   binds `main=<base>`. The pinned reviewer is the `cq-promotion-reviewer` App's bot user, matched
   by all three of creator type `Bot`, login `cq-promotion-reviewer[bot]` and its numeric id
   `339373542`. The identity is not a workflow literal or repo variable: it lives in the
   protected `policy/promotion-reviewer.json` (from the registration record @ `d8f132f`) —
   `cq-gate` reads it at `GITHUB_SHA` (the retired merge-queue-gate read the same file), the signer and crq validate it on `main`, and a
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

The crq status event wakes the gate. A dispatch of `gate.yml` with `--ref main` and no
`sha` input is only a nudge: the gate resolves the subject itself. Gate runs serialize
in the single `promote` concurrency group, so a tip dispatch never displaces a pending
promotion of a reviewed sha.

One promoter at a time. `cq-gate` is the sole promoter, armed: its single explicit
`CQ_GATE_PROMOTES` switch is `'true'`, so it runs WITH `--push`. Its base rule is that
the recorded review base **equals the current `main`** (a review of an older range can
only exist below a rewound `main` and is never selected). Its subject is the newest queue
commit carrying a trusted success; every check (closure, policy, verdict, verified runs)
judges `main..<subject>`, and its verdicts are `promoted`/`noop`/`awaiting` (no reviewed
commit yet), green, with `refused` red. A tip ahead of the reviewed sha simply waits for
its own review. The old `merge-queue-gate.yml` is retired at the C2 cutover (2026-10-11):
its instance entry, its rendered workflow and (Phase 0.2) its template are deleted —
it is no longer a promoter anywhere; git history is the archive. (`merge-queue-gate`'s
ancestor rule promoted any reviewed batch behind `main`; `cq-gate`'s equality rule
promotes exactly the batch cut from the current `main`.)

**Stateful replay refusal (arms with `cq-gate`).** Each `cq-gate` promotion moves the
`cq/promoted` ref to the promoted subject in the same atomic, leased push as `main`.
Selection skips any subject at or below that marker, so a break-glass rewind to exactly the
review base cannot replay the old review (the one case the exact-base binding cannot refuse
statelessly). The marker is re-read before every promotion and **fails closed whenever it is
missing or unreadable**: deleting the ref must never silently re-enable replay. Because the
cutover freezes promotion and disarms `merge-queue-gate` before arming `cq-gate`, the marker
never has to cover `merge-queue-gate` promotions.

### C2 cutover checklist

The executable order (the plan is the source of truth; this checklist records it):

0. **Hold unrelated merges; disable + drain the NEW gate.** Unrelated queue merges and
   manual promotions stop. The new `gate.yml` workflow is disabled on GitHub and drained
   (every non-completed run cancelled, all three run inventories empty) while the old gate
   and crq keep operating for delivery.
1. **The one flip+delete PR (this change).** Flip `CQ_GATE_PROMOTES` to `'true'`, delete
   the old rendered workflow and its instance entry (template kept adopter-only), remove
   the old dispatch from sync, re-render, add the marker ruleset to settings-as-code only,
   and update this policy, the doctrine, and the retired-workflow consumers — flip and
   deletion together, no unrelated change.
2. **Deliver it through the LAST old-gate promotion.** Merge the PR, cut the batch, run
   the full signer review, and let the old gate push `S` (dispatching it with the `sha`
   input if needed).
3. **Hard freeze: stop the crq tick timer, pause, inert marker, disable + drain BOTH gates.**
   The crq tick timer stops (after the active service finishes), crq pauses, the
   runner-disabled marker lands, and both gate workflows are disabled and drained.
4. **Bootstrap `refs/heads/cq/promoted` at `S` once** — a guarded fast-forward that
   requires the marker's absence; never reset or delete it to make the procedure pass.
5. **OWNER applies the `cq-c2-replay-marker` ruleset** — deletion + non_fast_forward on
   `refs/heads/cq/*`, no bypass actors; ordinary fast-forwards by the promoter credential
   keep working.
6. **Enable the new gate, resume crq, certify a completed `noop`** at equal refs (a
   green `noop` alone never certifies promotion — the completed run does).
7. **First new-gate promotion via an ordinary non-protected docs PR**, with exact-head
   independent acceptance and green required CI, dispatched with `--ref main` and no `sha`
   input.
8. **crq retry repair selects `gate.yml` (no `sha` input)** once the old workflow is gone
   — the old workflow is selected only while it still exists on fetched `main`.

Safety invariants: the new workflow stays disabled from step 0 until step 6, so the step-1
flip cannot arm a second active promoter; no old-gate push after bootstrap; never rewind
`main` to undo the delivery; after the first new-gate promotion `cq/promoted` is a replay
high-water mark that is never rewound or deleted.

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
- Residuals, stated plainly: until P0 (removing `ctaylor`'s passwordless sudo on the agent host, and
  on the signer host removing `ctaylor` from `docker`/`wheel` and closing sshd password auth — record
  §Deviations 4) a root-capable agent can reach the signer's key, so the signal is T1-proof (no
  overeager-agent forgery), not yet T2-proof; and P1 (the owner's PAT becoming interactive-only)
  is what makes the repository as a whole, not just the signal, agent-proof.
- The crq-side audit stays **detective**. Ordinary advances qualify through the successful
  `gate.yml` run built at the previous main: its `decide` job must record a single `promoted`
  `cq-promotion-result-v1` result binding that previous main and the exact new main, with an ordinary signer disposition.
  crq reads Actions API run/job metadata and job logs, never PR comment text. Runs must
  name `.github/workflows/gate.yml` on `main`, at the exact previous main SHA, from
  schedule, workflow_run, push or workflow_dispatch; PR workflow runs never qualify. The gate itself
  already verifies independent head-bound acceptance for every admitted PR, exact-subject CI,
  closure and policy using the canonical privileged-path predicate. A green run alone, a noop,
  a dry run, another head or a privileged (`required`) disposition does not qualify.
  Missing or expired evidence falls back to the pinned signer requirement; privileged advances
  retain that requirement. The audit scans at most 30 recent successful gate runs at the previous main, so delayed observations
  can remain unverified. Procedural acknowledgement never certifies review, CI or promotion.

### Durable observations for future D11 records

`observe-prs.yml` records the full open merge-queue PR set using the existing
`observeOpenPrs` writer on `cq-state`. It runs every five minutes and on default-branch
dispatches. PR target events only dispatch that default-branch observer: they do not
check out PR code or receive the automation App key. The writer job checks out only
the default branch and uses the existing `automation` environment credential after
building trusted code. It never merges a PR and does not enable `self-merge-prs`.

Apply an owner `cq-override` label only after the final head has a durable observation.
A new head requires a new observation and a later label. Failed observations are red;
no backdated anchors are created. Already-merged heads with no recorded observation
cannot be repaired by this workflow.

### Exact procedural audit acknowledgement

New unverified-promotion alerts carry the full previous and new main SHAs and the audit
observation timestamp. After the authorized promotion route has established the qualifying
exact-head independent PASS and exact green required CI, its operator may acknowledge that
one recorded observation with:

```sh
crq.py promotion-ack <full-new-main-sha> "<disposition>" \
  --audit-from <full-previous-main-sha> --audit-at <recorded-UTC-timestamp>
```

Both flags are required together. Prefixes, `all`, missing or ambiguous observations, and
non-`UNVERIFIED` records refuse in this mode. The range, observation, reason, and acknowledgement
time persist atomically before event/status output or success. An identical retry is a no-op;
a changed disposition refuses. A rewind followed by another observation of the same range
needs its own timestamp, so an old receipt cannot acknowledge it. Historical alerts are not
migrated. Legacy broad `promotion-ack` remains an acknowledgement-only convenience for
historical audit alerts without full range SHAs and for non-audit alert families.
Audit history retains the newest 300 record positions plus older records referenced by retained
alerts, including acknowledged alerts, so exact first acknowledgements and retries remain usable.

This is a procedural record through the existing authorized operator and local queue-store
boundary, not proof of human identity. It never changes `UNVERIFIED` to verified, posts a
status, or substitutes for signer approval on privileged ranges, required CI, denylist scans,
per-PR acceptance, or replay protection. The promotion-route integration is separate work:
this command must not be deployed as an automated per-promotion route until that integration
has been reviewed and authorized. It performs no promotion, retry, or deployment itself.

## Owner override

The owner runs the `crq-override` tool — installed beside the signer in root-owned
`/opt/cq-reviewer/` on the signer host — from a terminal no agent can reach: from the owner's OWN machine,
`ssh` to the signer host, then `sudo -u crq`. The host is headless, so the macOS plan's login-window design
became this: the invariant that survives is that the issuing terminal is unreachable from
the fleet agents', and the session is never routed through an agent-reachable host. The tool verifies the target
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
while the signer host's ssh and sudo are closed. Today the fleet agents reach `ctaylor@` on the
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

If the signer host — or the ssh path from crq to the spool — is down, nothing posts a review,
so no privileged range promotes (ordinary ranges are unaffected: their review is advisory). crq treats ssh failure as **unknown**: no new request, no withdrawal, no
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
    findings; `failure` when a completed review found any critical or major finding;
    `error` for a skipped,
    secret-scan-blocked or otherwise failed run (never promoted). After CodeRabbit refuses an
    oversized range, crq splits it into prefixes at the accepted size and continues prefix by
    prefix; the full batch still needs recorded clean coverage before promotion.
  - `description` (140 characters at most) always carries `main=<base_sha>`, for example
    `reviewed main=<base_sha> crq#<id>`,
    `blocked: 1 critical/2 major main=<base_sha> crq#<id>`, or
    `review too_large main=<base_sha> crq#<id>`
  - `target_url`: optional link to the review record
- **After promotion:** `main` equals `batch_sha`. The next batch's base is that SHA.
