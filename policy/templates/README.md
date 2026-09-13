# policy/templates — merge-queue workflow templates

Adoptable, parameterized templates for the cq-toolkit merge-queue doctrine:
everything a repository needs to run the queue mechanics (bootstrap the
branch, gate promotions, keep the branches level) plus the two check
patterns (required-check, affected-tests). The templates are the single
source of truth — see "The bootstrap rule" for what that commits you to.

## Files

| file | what it is |
| --- | --- |
| `init-merge-queue.yml` | dispatch-only, idempotent bootstrap of the `merge-queue` branch at `origin/main` HEAD |
| `merge-queue-gate.yml` | on push to `merge-queue`: wait until the required checks succeeded on that commit, then fast-forward promote it to `main` behind two merge-base guards |
| `sync-merge-queue.yml` | on push to `main`: API-only triage (zero clone) that keeps `main` and `merge-queue` level |
| `required-check.md` | the I4 pattern — required checks never filter triggers — with this repo's static job as the worked example |
| `affected-tests.md` | the per-PR reduced-test-selection pattern, its documented blind spot, and its I4 interplay |
| `README.md` | this guide |

## Placeholder tokens

Every `{{TOKEN}}` is replaced by literal text at instantiation time. Nothing
else in a template changes.

| token | used by | meaning |
| --- | --- | --- |
| `{{PROMOTE_SECRET}}` | init, gate, sync | NAME of the repository secret holding a PAT with `contents: write`, used for branch writes (bootstrap push, ff-promote, refs PATCH, merge API) and the check-runs API. Instantiated files reference it as `${{ secrets.<name> }}` — a name, never a value; a template or instantiation that embeds a token value is a denylist-class bug. |
| `{{GATE_CHECKS}}` | gate | comma list of required check names the gate waits for, e.g. `static,denylist` |
| `{{GATE_TIMEOUT_MIN}}` | gate | minutes the gate waits for the checks before refusing to promote (default 20; never promote unchecked) |
| `{{RUNNER}}` | required-check.md, affected-tests.md | `runs-on` label, e.g. `ubuntu-latest` |
| `{{NODE_VERSION}}` | required-check.md, affected-tests.md | Node version for `setup-node` |
| `{{INSTALL_CMD}}` | required-check.md, affected-tests.md | dependency install command, e.g. `npm ci` |
| `{{COMMANDS...}}` | required-check.md | the variadic ordered run-steps of the static job; this repo's instantiation is exactly four: typecheck ratchet, lint, test, build |

## How instantiation works

1. Replace every `{{TOKEN}}` in the template with its literal value (the
   tables above and each template's header say which tokens it takes).
2. Drop the result, otherwise unchanged, into `.github/workflows/`.
3. Keep the provenance header the instantiator adds
   (`# instantiated from policy/templates/... — edit the template, not this
   file`); it is what makes template drift visible in diffs.
4. When a NEW required check lands, extend `REQUIRED_WORKFLOW_FILES` in
   `scripts/denylist-scan` — that constant is the I4 policy data, and the
   self-test fail-closes on an empty or missing-file list.

## The bootstrap rule

Every hand-carried workflow is the same template that ships in `policy/` —
nothing is throwaway except the placeholder ratchet script
(`scripts/ratchet-typecheck.mjs`, whose baseline lives in
`baselines/typecheck.json`). Concretely, in this repo: `.github/workflows/ci.yml`
is `required-check.md` instantiated, the three queue workflows are the three
`.yml` templates instantiated, and `denylist.yml` (which predates the
templates) carries the required-check trigger shape with the denylist job
body and a provenance comment pointing back at `required-check.md`. If you
find yourself editing a file under `.github/workflows/`, stop: edit the
template here and re-instantiate, or the repo drifts from its own policy.

## THE ENTITLEMENT FACTS

- Personal GitHub accounts get HTTP 422 from the native merge-queue API
  (verified 2026-09): the documented merge-queue endpoints are effectively
  organization-plan features for these accounts. That failure is why this
  queue is branch-based — `merge-queue` is an ordinary branch, PRs target
  it, and promotion is a push.
- The refs API PATCH (`repos/{owner}/{repo}/git/refs/heads/{branch}`) with
  `force=false` is the server-side fast-forward invariant: the server itself
  rejects any non-fast-forward update with 422. An ff-only queue therefore
  needs no client-side trust — even a buggy workflow cannot move a ref
  backwards or sideways, because the server refuses. `force=true` appears
  nowhere in these templates.
- Related mechanics fact: `GITHUB_TOKEN` pushes do not trigger other
  workflows. Every push these templates make (the gate's promote, the sync's
  fast-forward) uses the promote PAT, so the downstream `on: push: main`
  sync actually fires.

## I3 — promotion is a pure fast-forward

Merge commits only. PRs merge into `merge-queue` with merge commits, the
queue advances only by merging, and `main` advances only by fast-forward
promotion of a fully checked `merge-queue` HEAD. Never squash, never rewrite
history, never force-push, never touch `main` by any other path. The gate
guards promotion with two merge-base checks, in order: if the gated sha is
already an ancestor of `main`, the promote is a logged no-op; if `main` is
not an ancestor of the gated sha (main diverged), the gate refuses and a
human merges `main` into `merge-queue`; only otherwise does it push
`<sha>:refs/heads/main` — an update the server would reject as non-ff anyway
if the guards had somehow raced.
