# Release runbook — v1.0.0

Operator record for the phase-5 release (T5.1 → T5.3). It states exactly what
the autonomous run did, what it could not do, and the remaining owner steps —
each with the command to run and the evidence to check. Nothing here is a
substitute for the release PR: [`RELEASE.md`](../RELEASE.md) is the DoD record
of record (plan §6 + §11).

## What the run did

| step                       | result                                                                                                                                                                                                                      | evidence                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| T5.1 publication checklist | release PR [#200](https://github.com/camerontaylor/cq-toolkit/pull/200) `release: v1.0.0`, merged `93bbf19cda7ec84720f048d67679c150a4658ba1`, ff-promoted (`main` = `93bbf19`)                                              | PR checks green; [RELEASE.md](../RELEASE.md)                                                                    |
| version bump               | `package.json` + `package-lock.json` `0.0.0` → `1.0.0`; `bin` fixed to `dist/cli.js`; `prepack` build hook added                                                                                                            | [package.json](../package.json)                                                                                 |
| tarball audit              | `npm pack` at the release-candidate head: 273 paths, only `dist/`, `policy/`, `LICENSE`, `README.md`, `package.json`; denylist clean (9 classes); sha256 `699a72dab4e48bacb5b6c59946da5ef701e88883e2bb2e073c5cfd0087ff71c4` | [`docs/release-evidence/pack-audit.log`](release-evidence/pack-audit.log), CI pack-audit run                    |
| publish dry-run            | `npm publish --dry-run` exit 0 at `1.0.0`, no `bin` correction warning, nothing uploaded                                                                                                                                    | [`docs/release-evidence/publish-dry-run.log`](release-evidence/publish-dry-run.log)                             |
| CHANGELOG                  | v1.0.0 entry generated from merged PR titles grouped by workstream                                                                                                                                                          | [CHANGELOG.md](../CHANGELOG.md)                                                                                 |
| tag                        | annotated `v1.0.0` on `main` `93bbf19` (`c320a17d5239733bd80abd32d9478e96c709a8cb`)                                                                                                                                         | `git ls-remote --tags origin v1.0.0`                                                                            |
| fixtures flip              | **NOT executed — publish-gated** (see below)                                                                                                                                                                                | [`docs/release-checklist.md`](https://github.com/camerontaylor/cq-fixtures/blob/main/docs/release-checklist.md) |
| publish                    | **NOT performed** — `AUTOPUBLISH=no` (owner decision 2026-09-14, final)                                                                                                                                                     | [`RELEASE.md`](../RELEASE.md) "For the owner"                                                                   |

### Deviations recorded during the release

- **Fixtures flip could not be prepared before publish.** `scripts/flip-to-published.sh 1.0.0`
  in `cq-fixtures` rewrites the `file:` dependency to `1.0.0` and then runs
  `npm install --package-lock-only`; with `1.0.0` unpublished the registry
  returns `ETARGET`, and the script restores `package.json` +
  `package-lock.json` and keeps `toolkit.lock` by design. No half-flip PR was
  fabricated. The flip is therefore a post-publish step (below), exactly as
  `cq-fixtures/docs/release-checklist.md` already labels it ("prepared, NOT
  executed — phase-5 human step").
- **CLI review base vs. moving `merge-queue`.** The two CodeRabbit CLI cycles
  were pinned at task-start `51c81eb`; `merge-queue` advanced with #195/#198
  and later T4.5 (#201) during review. The branch was caught up by merge
  commits (never a force-push) and the final head was covered by fresh
  non-author reviewer rounds plus the spec audit (recorded in the PR body).

## Remaining owner steps

### 1. Publish `1.0.0` to npm

Run from a clean checkout of the promoted `main` SHA (`93bbf19`); the
`prepack` hook builds `dist/` automatically, so no manual build is needed.

```sh
set -euo pipefail
pack_dir="$(mktemp -d)"                        # fresh dir: no stale tarball can be hashed
git clone https://github.com/camerontaylor/cq-toolkit
cd cq-toolkit
git checkout 93bbf19cda7ec84720f048d67679c150a4658ba1
npm ci
npm whoami                                     # confirm the publish identity
npm pack --pack-destination "$pack_dir"         # sanity: dist/ present, sha256 matches
shasum -a 256 "$pack_dir"/*.tgz                  # expect 699a72da… (dist+policy+LICENSE+README+package.json)
npm publish --access public
npm view @camerontaylor/cq-toolkit@1.0.0 version dist.tarball
```

The tarball audit in [`release-evidence/pack-audit.log`](release-evidence/pack-audit.log)
is the pre-publish evidence; `npm pack` must reproduce the recorded sha256
(`699a72da…`) before publishing.

### 2. Flip `cq-fixtures` to the published version

Only after step 1 succeeds:

```sh
set -euo pipefail
cd cq-fixtures                         # a failed cd aborts before any rm
git switch -c lane/p5-flip origin/main
scripts/flip-to-published.sh 1.0.0     # now resolves; rewrites pkg+lock, removes toolkit.lock
rm -rf vendor node_modules
npm ci && npm run build && npm test
git add package.json package-lock.json
git rm toolkit.lock
git commit -m "chore(release): flip to published @camerontaylor/cq-toolkit@1.0.0"
```

Open the PR against fixtures `main` and take it through the fixtures review
protocol (its own two-cycle/gates path), then merge and tag `v1.0.0` on
fixtures `main`. The checklist row "Flip to the published version" and
"Release lands whole" (fixtures side) are satisfied only when the flipped
tree's full gate run is green — never flip-and-tag blind.

### 3. Research-repo status lines (owner edits; the run does **not** edit these)

The plan/spec/ADR live in the private research repo. Flip, with owner
sign-off:

- `plans/adr/0001-worker-driver-seam.md` — `Status: proposed` → **accepted**.
- `specs/portable-code-quality-toolkit-spec.md` — `Status: pending approval`
  → approved/released as appropriate.
- `plans/toolkit-v1-plan.md` — plan status line.
- `plans/toolkit-v1-plan.md` §11 DoD table — record the release evidence links
  from [`RELEASE.md`](../RELEASE.md) and the npm listing.

### 4. Configure `secrets.GH_TOKEN` on `cq-toolkit` (DoD 2 soak)

The scheduled `self-review-loop` / `self-merge-prs` workflows exit red at
their `GH_TOKEN` assert, so the ws-k stage-2 soak is a recorded **NOT MET**
phase-4 deviation (0 PRs processed end-to-end). Set `secrets.GH_TOKEN` so the
automations can classify/reply/resolve/merge PRs; the soak criterion can then
be re-run and recorded. Evidence: [`SELF-HOSTING.md`](../SELF-HOSTING.md)
§Soak, [`docs/dod-evidence.md`](dod-evidence.md) DoD 2.

### 5. Fixtures driver-axis CI (matrix rows)

The fixtures model-axis matrix carries honest zeros for the driver-axis lanes
(they errored on CI) and a loud rc-4 for the ACP lane (backend dead). The
phase-4 exit gate recorded 2 ws-j FAIL rows and 1 DEFERRED→T5.2. Fix the
driver-side CI setup so those cells produce real scored rows; see the
fixtures J5 record and `cq-fixtures/docs/release-checklist.md`.

## Post-release checklist (both repos)

- [ ] `@camerontaylor/cq-toolkit@1.0.0` on the npm registry (step 1).
- [ ] fixtures flipped, green, merged, tagged `v1.0.0` (step 2).
- [ ] research-repo status lines flipped (step 3).
- [ ] `secrets.GH_TOKEN` set; soak re-run (step 4).
- [ ] fixtures driver-axis CI green (step 5).
- [ ] release PR body / `RELEASE.md` "MISSING" rows reconciled.
