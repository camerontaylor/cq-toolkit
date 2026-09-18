# policy/templates — merge-queue workflow templates

Adoptable, parameterized templates for the cq-toolkit merge-queue doctrine:
everything a repository needs to run the queue mechanics (bootstrap the
branch, gate promotions, keep the branches level) plus the two check
patterns (required-check, affected-tests). The templates are the single
source of truth — see "The bootstrap rule" for what that commits you to.

## Files

| file                   | what it is                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init-merge-queue.yml` | dispatch-only, idempotent bootstrap of the `merge-queue` branch at `origin/main` HEAD                                                                                              |
| `merge-queue-gate.yml` | on push to `merge-queue`: wait until the required checks succeeded on that commit, then fast-forward promote it to `main` behind a merge-queue-tip guard and two merge-base guards |
| `sync-merge-queue.yml` | on push to `main`: API-only triage (zero clone) that fast-forwards a behind `merge-queue`, reconciles divergence by merge commit, and defers promotion to the gate                 |
| `live-merge.yml`       | dispatch-only live drill: runs the F5 merge-prs integration test against a fresh private scratch repo on github.com (records its runs in `docs/drills/2026-09-f5.md`)              |
| `required-check.md`    | the I4 pattern — required checks never filter triggers — with this repo's static job as the worked example                                                                         |
| `affected-tests.md`    | the per-PR reduced-test-selection pattern, its documented blind spot, and its I4 interplay                                                                                         |
| `ratchet.yml`          | required type and coverage baseline checks on pushes and pull requests                                                                                                             |
| `ratchet-propose.yml`  | post-merge baseline tightening proposals using the automation token                                                                                                                |
| `self-host/`           | the stage-2 self-hosting automation (scheduled review-loop + merge-prs run from source) as adoptable workflows — `self-host/README.md` carries its files, tokens, and wiring guide |
| `README.md`            | this guide                                                                                                                                                                         |

## Placeholder tokens

Every literal `{{TOKEN}}` in a template file is replaced by its literal
value at instantiation time, and nothing else in the file changes — with
one deliberate exception: `{{COMMANDS...}}` (last table row) names a
HAND-REPLACED slot, not a token. No literal `{{COMMANDS...}}` placeholder
appears in `required-check.md` — the worked example carries this repo's
real run steps — so an adopter swaps those steps by hand rather than by
substitution.

| token                     | used by                              | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{PROMOTE_SECRET}}`      | init, gate, sync                     | NAME of the repository secret holding a PAT with `contents: write` (branch writes: bootstrap push, ff-promote, refs PATCH, merge API), `actions: write` (sync dispatches the gate), `issues: write` (the divergence alarm), and `checks: read` (the gate's required-check wait polls the check-runs API) — a fine-grained PAT with those four permissions, or the coarse classic-PAT equivalent. Instantiated files reference it as `${{ secrets.<name> }}` — a name, never a value; a template or instantiation that embeds a token value is a denylist-class bug. |
| `{{GATE_CHECKS}}`         | gate                                 | comma list of required check names the gate waits for, e.g. `static,denylist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `{{GATE_TIMEOUT_MIN}}`    | gate                                 | minutes the gate waits for the checks before refusing to promote (default 20; never promote unchecked)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `{{RUNNER}}`              | required-check.md, affected-tests.md | `runs-on` label, e.g. `ubuntu-latest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `{{NODE_VERSION}}`        | required-check.md, affected-tests.md | Node version for `setup-node`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `{{INSTALL_CMD}}`         | required-check.md, affected-tests.md | dependency install command, e.g. `npm ci`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `{{COMMANDS...}}`         | required-check.md                    | HAND-REPLACED slot (see above): the variadic ordered run-steps of the static job. The template carries this repo's five literal steps — static gate, format check, test, Knip, build — and an adopter replaces them by hand with their own commands; no placeholder text is substituted.                                                                                                                                                                                                                                                                            |
| `{{SELFHOST_TOKEN}}`      | self-host workflows                  | NAME of the repository secret holding the automation token the entries ride (`GH_TOKEN` at run time; repo read + PR read/comment/merge scope) — instantiated files reference it as `${{ secrets.<name> }}`; a name, never a value                                                                                                                                                                                                                                                                                                                                   |
| `{{SELFHOST_DRIVER_KEY}}` | self-host workflows                  | NAME of the repository secret holding the model-provider API key the fix/conflict workers' driver reads (`Z_AI_API_KEY` at run time) — instantiated files reference it as `${{ secrets.<name> }}`; a name, never a value                                                                                                                                                                                                                                                                                                                                            |

## How instantiation works

1. Replace every `{{TOKEN}}` in the template with its literal value (the
   tables above and each template's header say which tokens it takes).
2. Drop the result, otherwise unchanged, into `.github/workflows/`.
3. Keep the provenance header the instantiator adds
   (`# instantiated from policy/templates/... — edit the template, not this
file`); it is what makes template drift visible in diffs.
4. When a NEW required check lands, remember that "required" is defined in
   THREE unlinked places, and all three must learn it:
   - `REQUIRED_WORKFLOW_CHECKS` in `scripts/denylist-scan` — the I4 policy
     data, pairing each required workflow FILE with the CHECK NAME of the
     job that must produce it (GitHub reports a job's check run under the
     job id); the self-test fail-closes on an empty or malformed list, a
     missing file, or a job renamed away from its paired name. Updated
     alone, the check's workflow shape is policed but nothing in the
     merge path requires it to pass — the check is advisory.
   - the gate's wait list — `{{GATE_CHECKS}}` in this template, instantiated
     into `.github/workflows/merge-queue-gate.yml`. Not updated, the gate
     ff-promotes past a required check that never succeeded on the queue
     sha — I4 defeated at exactly the promotion boundary it exists to guard;
     updated alone, the gate waits for a check branch protection does not
     require on PRs, so an unchecked PR can still merge into the queue
     ahead of it (the gate still stops it before promotion — belt, not
     buckle).
   - branch protection required status-check contexts, on BOTH branches —
     `merge-queue` (this is what actually blocks PR merges into the queue)
     and `main` (the promotion backstop). Updated alone, PRs hang unmergeable
     waiting for a check the rest of the system ignores, with no failing red
     check to point at — the exact I4 failure mode.

## The bootstrap rule

Every hand-carried workflow is the same template that ships in `policy/` —
nothing is throwaway. The placeholder ratchet script was replaced (H4) by the
engine-based runners `scripts/ratchet-typecheck.mjs` and
`scripts/ratchet-check.mjs`, whose committed baselines live in `baselines/`
(one schemaVersion-1 file per (target, metric), written by
`createCaptureBaseline`). Concretely, in this repo: `.github/workflows/ci.yml`
is `required-check.md` instantiated, the three queue workflows are the three
queue `.yml` templates instantiated, the live-merge drill workflow is
`live-merge.yml` instantiated, the two ratchet workflows are their matching
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
  workflows. The only push to `main` these templates ever make is the gate's
  promote, and it uses the promote PAT so the downstream `on: push: main`
  sync actually fires; sync itself never advances `main` (ahead → dispatch
  the gate).

## I3 — promotion is a pure fast-forward

Merge commits only. PRs merge into `merge-queue` with merge commits, the
queue advances only by merging, and `main` advances only by fast-forward
promotion of a fully checked `merge-queue` HEAD. The gate is the ONLY
component that advances `main`; sync's ahead case never writes `main`
itself — it dispatches the gate, so there is exactly one promotion path and
it is always behind the required-check wait and the merge-base guards.
Never squash, never rewrite history, never force-push, never touch `main`
by any other path. The gate guards promotion with a merge-queue-tip guard
plus two merge-base checks, in order: if the gated sha is already an
ancestor of `main`, the promote is a logged no-op; if the gated sha is not
the CURRENT `merge-queue` tip, the gate refuses (a manual dispatch may never
promote an off-queue or stale commit — the tip's own gate run supersedes
it); if `main` is not an ancestor of the gated sha (main diverged),
the gate refuses and a human merges `main` into `merge-queue`; only then
does it push `<sha>:refs/heads/main` — an update the server would reject as
non-ff anyway if the guards had somehow raced.

## Action pinning

Every `uses:` in these templates and their instantiations is pinned to an
immutable commit SHA (never a mutable `@v5` tag — tags can be retargeted
after review). Required-check jobs additionally set
`persist-credentials: false` on checkout: they run repo code, and the
checkout token must not survive into it. The two queue-mechanics checkouts
that push with the promote PAT (the gate's promotion checkout and the init
bootstrap) deliberately KEEP the persisted credential — they run no repo
code — and say so in a comment beside the pin.
