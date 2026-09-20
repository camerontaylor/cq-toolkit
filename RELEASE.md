# Release v1.0.0 — `@camerontaylor/cq-toolkit`

Release-PR body for **T5.1** (`release: v1.0.0`). Instantiates the plan §6
publication checklist and the plan §11 DoD→evidence traceability table.
Branch `lane/p5-release`, cut at task-start `origin/main` `51c81eb` (T4.4,
ff-promoted) and caught up to `merge-queue` `0d76ed5` via merge commit
`ac261fc` (PRs #195, #198); target `merge-queue`. The version bump to
`1.0.0` is in this PR — the `npm publish` is **not**: the conductor's
`STATUS.md` (private research repo) records `AUTOPUBLISH=no` as final (owner
decision 2026-09-14), so there is no unattended publish. Publish is owner
action, recorded under `MISSING` below and in `STATUS.md` "For the owner".

## Goal

T5.1 · publication checklist executed mechanically; release PR drafted.
Breakdown: `ws-k-selfhost-publication.md` stage 3 item 9; plan §6 (every
checkbox); plan §11 (every row).

## Stack

parent: `merge-queue`; children: none (T5.2 branches from the promoted
`main`).

## Claims (acceptance checks this PR satisfies)

- [x] ws-k stage 3 item 9: `npm pack` tarball inspected against the denylist,
      `files` allowlist, publish dry-run — **met** (see §6 rows below).
- [x] ws-k acceptance "Release PR maps every DoD item to its evidence link
      (plan §11 table instantiated)" — **met** (table below; unproduced rows
      are explicitly `MISSING`).
- [x] plan §6 "npm publish dry-run + `npm pack` inspection shows no
      denylisted strings in the tarball; `files` allowlist" — **met**.
- [x] plan §6 "README doctrine sections present (I1–I11)" — **met**.
- [ ] plan §6 "release lands whole: single version tag on each repo; DoD
      checklist verified in the release PR description" — tag lands in **T5.2**.

## Deferred to

- `v1.0.0` git tag on toolkit `main` → **T5.2** (after this PR promotes).
- fixtures flip-to-published PR + fixtures tag → **T5.2/T5.3**.
- `npm publish 1.0.0` → **owner** (`AUTOPUBLISH=no`, final 2026-09-14).
- Soak log + `docs/dod-evidence.md` → **T4.5 parallel lane / owner**
  (marked `MISSING` below).

## Invariants exercised

I2: single-identity reviewer deviation (fresh non-author reviewer comment,
PROTOCOL §3 step 8) — recorded. I3: version bump lands through `merge-queue`
→ ff-promotion; no direct `main` write, no force/squash. I5: baselines
untouched; `pack-audit` evidence is non-passing if absent. I4: required
checks unfiltered — the release PR runs the full CI + denylist + pack-audit
set.

## Publication checklist — plan §6

| #   | Item                                                                     | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | npm name availability + reservation                                      | met     | `@camerontaylor/cq-toolkit@0.0.0` reserved 2026-09-14 — [registry listing](https://www.npmjs.com/package/@camerontaylor/cq-toolkit)                                                                                                                                                                                                                                                                                                                                           |
| 2   | MIT LICENSE at repo creation, both repos                                 | met     | [toolkit LICENSE](LICENSE) · [fixtures LICENSE](https://github.com/camerontaylor/cq-fixtures/blob/main/LICENSE)                                                                                                                                                                                                                                                                                                                                                               |
| 3   | Denylist CI scan green in both repos                                     | met     | toolkit main `0d76ed5` [run 35528053823](https://github.com/camerontaylor/cq-toolkit/actions/runs/35528053823) · fixtures main `6768530` [run 35523233647](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233647) · [patterns.yml](policy/denylist/patterns.yml) · self-test legs in [`scripts/denylist-scan`](scripts/denylist-scan)                                                                                                                         |
| 4   | No history hygiene needed by construction                                | met     | greenfield births: cq-toolkit [#1](https://github.com/camerontaylor/cq-toolkit/pull/1) · cq-fixtures [#1](https://github.com/camerontaylor/cq-fixtures/pull/1)                                                                                                                                                                                                                                                                                                                |
| 5   | Secrets posture: CI uses GitHub secrets only                             | met     | workflows read `secrets.*`; no repo-tree `*.env*` — [.github/workflows](.github/workflows)                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | `npm publish --dry-run` + `npm pack` inspection clean; `files` allowlist | met     | [`publish-dry-run.log`](docs/release-evidence/publish-dry-run.log) · [`pack-audit.log`](docs/release-evidence/pack-audit.log) (tarball sha256 `34dca185901e037a3ccad5c853ad49f40e9297b41db9f99aa9e6c565a2441138`) · [`tarball-listing.txt`](docs/release-evidence/tarball-listing.txt) · CI [pack-audit workflow](.github/workflows/pack-audit.yml) (green on this PR head)                                                                                                   |
| 7   | README doctrine sections I1–I11                                          | met     | [README §Doctrine](README.md#doctrine-i1i11) · canonical [policy/DOCTRINE.md](policy/DOCTRINE.md) · fixtures [README](https://github.com/camerontaylor/cq-fixtures/blob/main/README.md) (suite/scoring schema)                                                                                                                                                                                                                                                                |
| 8   | Agent scratch dirs gitignored in both repos                              | met     | [toolkit .gitignore](.gitignore) · [fixtures .gitignore](https://github.com/camerontaylor/cq-fixtures/blob/main/.gitignore) · scratch-dir denylist class                                                                                                                                                                                                                                                                                                                      |
| 9   | Every §10 design debt dispositioned before the tag                       | partial | DD-1 [spike](docs/dd-1-abort-spike.md) · DD-2 [normalization](docs/dd-2-usd-normalization.md) · DD-3/DD-8 [reverify-2026-09](docs/reverify-2026-09.md) · DD-9 [budget](docs/dd-9-api-equivalent-budget.md) · DD-4 fixtures [PR 12](https://github.com/camerontaylor/cq-fixtures/pull/12) · DD-5/DD-6 no v1 action (plan §10) · DD-7 op-result taxonomy in [docs/ops](docs/ops/) — consolidated disposition table `MISSING: docs/dod-evidence.md (T4.5 parallel lane / owner)` |
| 10  | Release lands whole: one tag per repo; DoD verified here                 | partial | this PR · **MISSING: `v1.0.0` tag refs (T5.2, after promote)**                                                                                                                                                                                                                                                                                                                                                                                                                |

## DoD traceability — plan §11

| Spec DoD item (verbatim anchor)                                                                                                             | Delivered by                            | Evidence at release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Two public MIT repos; toolkit on npm; denylist CI green in both                                                                          | WS-K (+ WS-J scaffold)                  | Both repos public + MIT ([toolkit](https://github.com/camerontaylor/cq-toolkit) · [fixtures](https://github.com/camerontaylor/cq-fixtures)); denylist green [toolkit run](https://github.com/camerontaylor/cq-toolkit/actions/runs/35528053823) / [fixtures run](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233647); **MISSING: npm listing of `1.0.0` — publish pending owner (`AUTOPUBLISH=no`)**                                                                                                                                                                                                                                                                                                                                                                       |
| 2. Toolkit self-hosts: merge-queue (ff-promotion, no paths-ignore), only-tightening ratchets, review-loop + merge-prs automation            | WS-K stages 0–2, WS-H, WS-E, WS-F       | [SELF-HOSTING.md](SELF-HOSTING.md) · [T4.1 self-host switch PR 182](https://github.com/camerontaylor/cq-toolkit/pull/182) · H4 drills [docs/drills/2026-09-h4.md](docs/drills/2026-09-h4.md) · **ratchet self-evidence**: only-tightening [PR 198](https://github.com/camerontaylor/cq-toolkit/pull/198) (`proposeBaselineUpdate`, main `0d76ed5`, [ratchet run 35528053788](https://github.com/camerontaylor/cq-toolkit/actions/runs/35528053788)) + monotonic-guard drill [PR 199](https://github.com/camerontaylor/cq-toolkit/pull/199) (loosening baseline, [ratchet run FAILS 35527069990](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527069990), closed-not-merged); **MISSING: soak log ≥5 promotions + automation-authored PR evidence (T4.5 parallel lane / owner)** |
| 3. SDK kernel: atomic ops + plan runner cover all six clusters; every op standalone from TS and via CLI                                     | WS-A + WS-C/D/E/F/G/H + WS-I            | Generated op reference [docs/ops/](docs/ops/) (one page per op) · [inventory cross-check](docs/inventory-crosscheck.md) · [CLI contract](src/cli/README.md) · from-source smoke [`scripts/smoke-run-plan.mjs`](scripts/smoke-run-plan.mjs) · CI [run 35528053780](https://github.com/camerontaylor/cq-toolkit/actions/runs/35528053780)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4. Pluggable worker seam: ≥2 working drivers + ADR                                                                                          | WS-B; ADR-0001                          | Four conformance lanes — [src/driver/README.md](src/driver/README.md) · [acp driver](docs/acp-driver.md) · [acp strategy](docs/acp-driver-strategy.md) · live drivers [run 34915473781](https://github.com/camerontaylor/cq-toolkit/actions/runs/34915473781); **ADR-0001** is in the private research repo (`plans/adr/0001-worker-driver-seam.md`) with status line still `proposed` — **MISSING: ADR-0001 status flip to accepted (owner; the run does not edit research-repo files)**                                                                                                                                                                                                                                                                                                     |
| 5. Fixtures/eval repo: scored suites for fixer-worker + review-classifier; per-role comparison tables (outcome/cost/wall time); CI-runnable | WS-J                                    | Real-driver matrix [fixtures PR 13](https://github.com/camerontaylor/cq-fixtures/pull/13) · snapshot tables [PR 16](https://github.com/camerontaylor/cq-fixtures/pull/16) · suite CI green main `6768530` [run 35523233617](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233617) · J6 release wiring [PR 17](https://github.com/camerontaylor/cq-fixtures/pull/17)                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6. Webfront untouched; zero webfront-isms — enforced by denylist                                                                            | WS-K; greenfield everywhere             | [policy/denylist/patterns.yml](policy/denylist/patterns.yml) carries every listed class; green in both repos (runs above); repo births contain no carried history (PR 1 each)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7. No staging: one coherent v1 release                                                                                                      | plan §1, §7 (release = P4 single event) | This release PR carries the DoD checklist with each evidenceable row linked; it does **not** yet claim all rows complete — publication, soak, `docs/dod-evidence.md`, ADR acceptance and tags are marked `MISSING` above and gate the tag · [CHANGELOG.md](CHANGELOG.md) v1.0.0 (merged PR titles by workstream); **MISSING: `v1.0.0` tag refs on toolkit + fixtures (T5.2/T5.3)**                                                                                                                                                                                                                                                                                                                                                                                                            |

## Pre-PR CLI review

Two CodeRabbit CLI cycles (`coderabbit review --agent --base-commit`), the
second mandatory even though the first was non-empty; stopped at two per
`docs/coderabbit-review.md` §5. Both used the task's immutable base pinned
against the intended target at task start:
`BASE = git merge-base origin/merge-queue <authored-head> = 51c81eb` (the
owner override's live `origin/main` at launch).

| cycle | reviewed HEAD | dirty-diff identity | NDJSON log                 | terminal                                                          | findings | dispositions                                         |
| ----- | ------------- | ------------------- | -------------------------- | ----------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| 1     | `3d6455b`     | clean tree          | `/tmp/p5-cr-cycle1.ndjson` | `complete` / `review_completed`, exit 0, no error/action_required | 3 minor  | 1 fixed (`b488cb7`), 2 rejected (Dismissed findings) |
| 2     | `b488cb7`     | clean tree          | `/tmp/p5-cr-cycle2.ndjson` | `complete` / `review_completed`, exit 0, no error/action_required | 1 major  | fixed (`04b67fd`)                                    |

No third CLI cycle is run (the two-cycle cap is final). While this PR was in
author-side review, the parallel lane promoted #195 and #198 to
`merge-queue`/`main`; the catch-up merge `ac261fc` brings that already
independently reviewed upstream delta, and this PR's own finding-addressing
commits are covered by the fresh non-author reviewer rounds and the spec
audit on the final head (recorded deviation below). No unresolved
critical/major finding coexists with this PR.

## Review rounds

- round 1: 7 findings (1 high, 4 medium, 2 low) — **all fixed** (see
  "Round-1 dispositions"); fresh reviewer `53b7f81` (paseo
  `pi-opencode/opencode-go/deepseek-v4.1-flash`, thinking medium), posted as
  a PR comment.
- round 2: 5 findings (2 medium, 3 low) — **all fixed** (evidence-log
  identity + dirty-diff recording, PR-body regeneration, CodeRabbit
  rate-limit wording, `scripts/probe-acp.mjs` client version, gate-row
  labelling); fresh reviewer `6cf37ae` (paseo
  `pi-opencode/opencode-go/deepseek-v4.1-flash`, thinking high), posted as a
  PR comment. The round-2 fixes are in the commit immediately following the
  reviewed head; the final head is re-reviewed in round 3.
- round 3: 4 findings (1 high, 1 medium, 2 low) — **all fixed**: added a
  `prepack` build hook so `npm publish` from the promoted `main` SHA cannot
  ship a `dist`-less tarball; recorded the `npm ci` + build prerequisite in
  the evidence logs; widened the dirty-diff label to the round-1 batch;
  corrected the Codex rate-limit wording in the PR-body appendix. Fresh
  reviewer `2045d34` (paseo `pi-opencode/opencode-go/deepseek-v4.1-flash`,
  thinking medium), posted as a PR comment.
- round 4 (final-head verification after the high fix): _pending_ (fresh
  paseo reviewer, thinking high).
- VB5 batch gate (final goal T5.3): _pending_.

### Round-1 dispositions

| #   | Sev    | Fix                                                                                                                                                                                                                                                               |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | high   | Fixed — caught up to `merge-queue` `0d76ed5`; pack-audit + dry-run regenerated for the final content (the `CLIENT_VERSION` fix, uncommitted at capture, committed as `88dc0e3`; dirty-diff identity recorded in each log); new tarball sha256 inlined (§6 row 6). |
| 2   | medium | Fixed — `CHANGELOG.md` adds #195 (RD) and #198 (WS-H); every merged PR is now present.                                                                                                                                                                            |
| 3   | medium | Fixed — `CHANGELOG.md` intro qualifies the plan/breakdown paths as the private research repo (dead relative links removed).                                                                                                                                       |
| 4   | medium | Fixed — the `AUTOPUBLISH=no` basis is inlined; `STATUS.md` qualified as the private research repo.                                                                                                                                                                |
| 5   | medium | Fixed — the three deterministic gate runs are recorded under "Verification"; dangling "Cycle gate runs"/"spec audit below" references removed.                                                                                                                    |
| 6   | low    | Fixed — the tarball sha256 is inlined instead of the log path.                                                                                                                                                                                                    |
| 7   | low    | Fixed — `docs/naming.md` version claim updated; ACP `clientInfo.version` aligned via `CLIENT_VERSION = '1.0.0'`.                                                                                                                                                  |

## Review threads (bots)

_pending_ — the CodeRabbit App was rate-limited when the PR was opened
(`Review limit reached`); threads are listed and each given one fate (fix /
dismiss / defer→issue) before merge once the App review posts.

## Dismissed findings

- **Cycle-1 finding 2** (minor, `CHANGELOG.md`): use an `Unreleased` heading
  until the `v1.0.0` tag exists. **Rejected** — the dated `v1.0.0` heading is
  the release this PR cuts; the tag is created in T5.2 on the promoted SHA as
  part of the same release event (plan §1 "no staging", §6 "release lands
  whole"). Renaming it to `Unreleased` would require a further post-review
  commit after tagging to restore the dated heading.
- **Cycle-1 finding 3** (minor, `docs/release-evidence/README.md`): the
  referenced `pack-audit.log` and `publish-dry-run.log` must be tracked.
  **Rejected** — both are committed in `3d6455b`
  (`git show --stat 3d6455b` lists `docs/release-evidence/pack-audit.log`
  582 lines, `publish-dry-run.log` 295 lines, `tarball-listing.txt` 273
  lines) and are in the reviewed diff; the README claim is accurate.

## Verification

Three deterministic gate runs per `docs/coderabbit-review.md` §5 (before
cycle 1, between cycles, after cycle-2 addressing); all commands exit 0:

| gate run                   | `format:check` | `check:static`                 | `knip` | `denylist`                       |
| -------------------------- | -------------- | ------------------------------ | ------ | -------------------------------- |
| pre-cycle-1                | 0              | 0 (`0 error(s) <= baseline 0`) | 0      | 0 (`tree scan clean, 9 classes`) |
| between cycles (`b488cb7`) | 0              | 0                              | 0      | 0                                |
| post-cycle-2 (`04b67fd`)   | 0              | 0                              | 0      | 0                                |
| post-catch-up (`88dc0e3`)  | 0              | 0                              | 0      | 0                                |

Plus the three whitespace/conflict-marker checks
(`git diff --check BASE HEAD`, `--cached`, unstaged) — all clean; `npm ci`
and `npm run build` exit 0. Owner order 2026-09-20: local `npm test` is
**not** run by this lane (CI runs the suite; tests are written in the same
commit as any code).

- pack audit reproduction (CI `.github/workflows/pack-audit.yml`):
  `npm ci` → `npm run build` → `npm pack` (the new `prepack` hook builds
  automatically, so a publish from a clean checkout cannot ship a `dist`-less
  tarball) → untar outside the tree → `files` allowlist assertion →
  `denylist-scan` over the unpacked tree with the tarball's own
  `patterns.yml`. Result **PASS**; tarball sha256
  `34dca185901e037a3ccad5c853ad49f40e9297b41db9f99aa9e6c565a2441138`; 273
  paths, all under `dist/`, `policy/`, `LICENSE`, `README.md`,
  `package.json`; packed `bin` = `{"cq":"dist/cli.js"}`.
- `npm publish --dry-run` — exit 0 at `1.0.0`, no `bin` auto-correction
  warning, nothing uploaded.

## Deviation

- **Catch-up merge after the CLI base was pinned.** Per the owner override,
  `BASE = live origin/main = 51c81eb` at task start. The parallel phase-4
  lane then promoted #195 and #198 to `merge-queue`/`main` (`0d76ed5`).
  Because the two CLI cycles are capped at two and the CLI base is immutable
  per task, no third cycle was run; instead the branch was caught up by merge
  commit `ac261fc` (never a force-push), evidence was regenerated for the
  final content (committed as `88dc0e3`, dirty-diff identity recorded in the
  logs), and the final head is covered by the fresh non-author reviewer
  rounds plus the spec audit. The upstream delta (#195/#198) was
  independently reviewed and merged under its own protocol.
- **No in-harness Agent/Task tool** on the `pi-opencode` lane harness
  (provider exposes no selectable modes and no in-process subagent tool), so
  T5.1's mechanical artifacts were authored lane-side by the leader rather
  than delegated to a fresh executor slice. Review and audit rounds remain
  **fresh paseo agents** per PROTOCOL §3 steps 5–7.
- **`package.json` `bin` fix** (round-1 verified): `./dist/cli.js` was
  auto-corrected and **stripped** by `npm publish`
  (`bin[cq] script name dist/cli.js was invalid and removed`) — the `cq` bin
  would not have shipped. Fixed to `dist/cli.js`; the packed `package.json`
  now carries it.
- **`prepack` build hook** (round-3 high finding): `dist/` is gitignored and
  was built only by explicit CI steps, so `npm publish` from the promoted
  `main` SHA would have packed a tarball with no `dist/` (npm exits 0 and
  silently drops a missing `files` entry) — a broken `1.0.0`. Added
  `"prepack": "npm run build"` so `npm pack`/`npm publish` always build the
  shipped artifacts.
- **Version-claim alignment** (round-1 finding 7): `docs/naming.md` updated
  and ACP `clientInfo.version` aligned to `1.0.0`. Deriving the client
  version from the manifest at runtime is a post-v1 candidate (recorded,
  not a release blocker).
- **CLI-cycle substitution**: none applied — both cycles completed.

## For the owner

- `npm publish --access public` of `1.0.0` from the promoted `main` SHA
  (the `prepack` hook builds `dist/` automatically; the tarball audit in
  `docs/release-evidence/pack-audit.log` is the post-build evidence).
- Flip research-repo status lines: ADR-0001 → accepted; plan §6/spec status;
  plan §11 DoD table; the parallel T4.5 evidence (`SELF-HOSTING.md` soak,
  `docs/dod-evidence.md`) fills the remaining `MISSING` rows.
- Tag `v1.0.0` on fixtures after publish; merge the fixtures flip PR.
