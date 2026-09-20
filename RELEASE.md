# Release v1.0.0 — `@camerontaylor/cq-toolkit`

Release-PR body for **T5.1** (`release: v1.0.0`). Instantiates the plan §6
publication checklist and the plan §11 DoD→evidence traceability table.
Branch `lane/p5-release` off `origin/main` `51c81eb` (T4.4, ff-promoted);
target `merge-queue`. The version bump to `1.0.0` is in this PR — the
`npm publish` is **not** (`STATUS.md` has no `AUTOPUBLISH=yes`); it is owner
action, recorded under "MISSING" below and in `STATUS.md` "For the owner".

## Goal

T5.1 · publication checklist executed mechanically; release PR drafted.
Breakdown: `ws-k-selfhost-publication.md` stage 3 item 9; plan §6 (every
checkbox); plan §11 (every row).

## Stack

parent: `merge-queue`; children: none (T5.2 branches from the promoted
`main`).

## Claims (acceptance checks this PR satisfies)

- [ ] ws-k stage 3 item 9: `npm pack` tarball inspected against the denylist,
      `files` allowlist, publish dry-run — **met** (see §6 rows below).
- [ ] ws-k acceptance "Release PR maps every DoD item to its evidence link
      (plan §11 table instantiated)" — **met** (table below; unproduced rows
      are explicitly `MISSING`).
- [ ] plan §6 "npm publish dry-run + `npm pack` inspection shows no
      denylisted strings in the tarball; `files` allowlist" — **met**.
- [ ] plan §6 "README doctrine sections present (I1–I11)" — **met**.
- [ ] plan §6 "release lands whole: single version tag on each repo; DoD
      checklist verified in the release PR description" — tag lands in **T5.2**.

## Deferred to

- `v1.0.0` git tag on toolkit `main` → **T5.2** (after this PR promotes).
- fixtures flip-to-published PR + fixtures tag → **T5.2/T5.3**.
- `npm publish 1.0.0` → **owner** (`AUTOPUBLISH=no`, final 2026-09-14).
- Soak log + ratchet self-evidence + `docs/dod-evidence.md` → **T4.5
  parallel lane / owner** (marked `MISSING` below).

## Invariants exercised

I2: single-identity reviewer deviation (fresh non-author reviewer comment,
README §3 step 8) — recorded. I3: version bump lands through `merge-queue` →
ff-promotion; no direct `main` write, no force/squash. I5: baselines
untouched; `pack-audit` evidence is non-passing if absent. I4: required
checks unfiltered — the release PR runs the full CI + denylist + pack-audit
set.

## Publication checklist — plan §6

| #   | Item                                                                     | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | npm name availability + reservation                                      | met     | `@camerontaylor/cq-toolkit@0.0.0` reserved 2026-09-14 — [registry listing](https://www.npmjs.com/package/@camerontaylor/cq-toolkit)                                                                                                                                                                                                                                                                                                                                                 |
| 2   | MIT LICENSE at repo creation, both repos                                 | met     | [toolkit LICENSE](LICENSE) · [fixtures LICENSE](https://github.com/camerontaylor/cq-fixtures/blob/main/LICENSE)                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | Denylist CI scan green in both repos                                     | met     | toolkit main `51c81eb` [run 35526705340](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526705340) · fixtures main `6768530` [run 35523233647](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233647) · [patterns.yml](policy/denylist/patterns.yml) · self-test legs in [`scripts/denylist-scan`](scripts/denylist-scan)                                                                                                                               |
| 4   | No history hygiene needed by construction                                | met     | greenfield births: cq-toolkit [#1](https://github.com/camerontaylor/cq-toolkit/pull/1) · cq-fixtures [#1](https://github.com/camerontaylor/cq-fixtures/pull/1)                                                                                                                                                                                                                                                                                                                      |
| 5   | Secrets posture: CI uses GitHub secrets only                             | met     | workflows read `secrets.*`; no repo-tree `*.env*` — [.github/workflows](.github/workflows)                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | `npm publish --dry-run` + `npm pack` inspection clean; `files` allowlist | met     | [`docs/release-evidence/publish-dry-run.log`](docs/release-evidence/publish-dry-run.log) · [`pack-audit.log`](docs/release-evidence/pack-audit.log) · [`tarball-listing.txt`](docs/release-evidence/tarball-listing.txt) · CI [run 35526170637](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526170637)                                                                                                                                                               |
| 7   | README doctrine sections I1–I11                                          | met     | [README §Doctrine](README.md#doctrine-i1i11) · canonical [policy/DOCTRINE.md](policy/DOCTRINE.md)                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | Agent scratch dirs gitignored in both repos                              | met     | [toolkit .gitignore](.gitignore) · [fixtures .gitignore](https://github.com/camerontaylor/cq-fixtures/blob/main/.gitignore) · scratch-dir denylist class                                                                                                                                                                                                                                                                                                                            |
| 9   | Every §10 design debt dispositioned before the tag                       | partial | DD-1 [spike](docs/dd-1-abort-spike.md) · DD-2 [normalization](docs/dd-2-usd-normalization.md) · DD-3/DD-8 [reverify-2026-09](docs/reverify-2026-09.md) · DD-9 [budget](docs/dd-9-api-equivalent-budget.md) · DD-4 fixtures [PR 12](https://github.com/camerontaylor/cq-fixtures/pull/12) · DD-5/DD-6 no v1 action (plan §10) · **DD-7** → op-result taxonomy in [docs/ops](docs/ops/) — consolidated disposition table `MISSING: docs/dod-evidence.md (T4.5 parallel lane / owner)` |
| 10  | Release lands whole: one tag per repo; DoD verified here                 | partial | this PR · **MISSING: `v1.0.0` tag refs (T5.2, after promote)**                                                                                                                                                                                                                                                                                                                                                                                                                      |

## DoD traceability — plan §11

| Spec DoD item (verbatim anchor)                                                                                                             | Delivered by                            | Evidence at release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Two public MIT repos; toolkit on npm; denylist CI green in both                                                                          | WS-K (+ WS-J scaffold)                  | Both repos public + MIT ([toolkit](https://github.com/camerontaylor/cq-toolkit) · [fixtures](https://github.com/camerontaylor/cq-fixtures)); denylist green [toolkit run](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526705340) / [fixtures run](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233647); **MISSING: npm listing of `1.0.0` — publish pending owner (`AUTOPUBLISH=no`)**                                                                             |
| 2. Toolkit self-hosts: merge-queue (ff-promotion, no paths-ignore), only-tightening ratchets, review-loop + merge-prs automation            | WS-K stages 0–2, WS-H, WS-E, WS-F       | [SELF-HOSTING.md](SELF-HOSTING.md) · [pack-audit workflow run](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526705393) · [T4.1 self-host switch PR 182](https://github.com/camerontaylor/cq-toolkit/pull/182) · H4 drills [docs/drills/2026-09-h4.md](docs/drills/2026-09-h4.md); **MISSING: soak log ≥5 promotions + automation-authored PR evidence (T4.5 parallel lane / owner) · MISSING: ratchet only-tightening + monotonic-guard drill evidence (T4.5 parallel lane / owner)** |
| 3. SDK kernel: atomic ops + plan runner cover all six clusters; every op standalone from TS and via CLI                                     | WS-A + WS-C/D/E/F/G/H + WS-I            | Generated op reference [docs/ops/](docs/ops/) (one page per op) · [inventory cross-check](docs/inventory-crosscheck.md) · [CLI contract](src/cli/README.md) · from-source smoke [`scripts/smoke-run-plan.mjs`](scripts/smoke-run-plan.mjs) · CI [run 35526705393](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526705393)                                                                                                                                                             |
| 4. Pluggable worker seam: ≥2 working drivers + ADR                                                                                          | WS-B; ADR-0001                          | Four conformance lanes — [src/driver/README.md](src/driver/README.md) · [acp driver](docs/acp-driver.md) · [acp strategy](docs/acp-driver-strategy.md) · live drivers [run 34915473781](https://github.com/camerontaylor/cq-toolkit/actions/runs/34915473781); **ADR-0001** is in the private research repo (`plans/adr/0001-worker-driver-seam.md`) with status line still `proposed` — **MISSING: ADR-0001 status flip to accepted (owner; the run does not edit research-repo files)**           |
| 5. Fixtures/eval repo: scored suites for fixer-worker + review-classifier; per-role comparison tables (outcome/cost/wall time); CI-runnable | WS-J                                    | Real-driver matrix [fixtures PR 13](https://github.com/camerontaylor/cq-fixtures/pull/13) · snapshot tables [PR 16](https://github.com/camerontaylor/cq-fixtures/pull/16) · suite CI green main `6768530` [run 35523233617](https://github.com/camerontaylor/cq-fixtures/actions/runs/35523233617) · J6 release wiring [PR 17](https://github.com/camerontaylor/cq-fixtures/pull/17)                                                                                                                |
| 6. Webfront untouched; zero webfront-isms — enforced by denylist                                                                            | WS-K; greenfield everywhere             | [policy/denylist/patterns.yml](policy/denylist/patterns.yml) carries every listed class; green in both repos (runs above); repo births contain no carried history (PR 1 each)                                                                                                                                                                                                                                                                                                                       |
| 7. No staging: one coherent v1 release                                                                                                      | plan §1, §7 (release = P4 single event) | This release PR checks every DoD box · [CHANGELOG.md](CHANGELOG.md) v1.0.0 (merged PR titles by workstream); **MISSING: `v1.0.0` tag refs on toolkit + fixtures (T5.2/T5.3)**                                                                                                                                                                                                                                                                                                                       |

## Pre-PR CLI review

(Filled during the two CodeRabbit CLI cycles / owner-authorized
substitutions per `docs/coderabbit-review.md` §3b.)

- pinned base: `origin/merge-queue` @ `51c81eb`
- cycle 1: _pending_
- cycle 2: _pending_

## Verification

- `npm ci` — clean install.
- `npm run build` — exit 0.
- `npm run format:check`, `npm run check:static`, `npm run knip` — see
  "Cycle gate runs" in the PR body once run (owner order 2026-09-20: local
  `npm test` is **not** run by this lane; CI runs the suite).
- pack audit reproduction (CI `.github/workflows/pack-audit.yml`):
  `npm pack` → untar outside the tree → `files` allowlist assertion →
  `denylist-scan` over the unpacked tree with the tarball's own
  `patterns.yml`. Result **PASS**; tarball sha256
  `docs/release-evidence/pack-audit.log`; 273 paths, all under
  `dist/`, `policy/`, `LICENSE`, `README.md`, `package.json`.
- `npm publish --dry-run` — exit 0 at `1.0.0`, nothing uploaded.

## Deviation

- **No in-harness Agent/Task tool** on the `pi-opencode` lane harness
  (provider exposes no selectable modes and no in-process subagent tool), so
  T5.1's mechanical artifacts were authored lane-side by the leader rather
  than delegated to a fresh executor slice. Review and audit rounds remain
  **fresh paseo agents** per PROTOCOL §3 steps 5–7.
- **`package.json` `bin` fix**: `./dist/cli.js` was auto-corrected and
  **stripped** by `npm publish` (`bin[cq] script name dist/cli.js was
invalid and removed`) — meaning the `cq` bin would not have shipped. Fixed
  to `dist/cli.js`; `publish --dry-run` now emits no correction warning and
  the packed `package.json` carries `{"cq":"dist/cli.js"}`.
- **CLI-cycle substitution** (if applied): recorded verbatim per owner order
  2026-09-20 under "Pre-PR CLI review".

## For the owner

- `npm publish --access public` of `1.0.0` from the promoted `main` SHA.
- Flip research-repo status lines: ADR-0001 → accepted; plan §6/spec status;
  plan §11 DoD table; the parallel T4.5 evidence (`SELF-HOSTING.md` soak,
  `docs/dod-evidence.md`, ratchet drill evidence) fills the `MISSING` rows.
- Tag `v1.0.0` on fixtures after publish; merge the fixtures flip PR.
