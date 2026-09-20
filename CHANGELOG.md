# Changelog

All notable changes to `@camerontaylor/cq-toolkit`. Entries are generated
from merged pull-request titles, grouped by the v1 workstreams of
`plans/toolkit-v1-plan.md` §7 and the `plans/breakdown/ws-*.md` files
(both in the private research repo — they are not published here).
Links default to the
`camerontaylor/cq-toolkit` repository; WS-J links are repo-qualified.

## v1.0.0 — 2026-09-21

First coherent v1 release: the frozen kernel contracts, the pluggable driver
seam (four conformance-passing lanes), the gate/ledger trio, the sweep,
review-loop, merge-prs and analyze op families, the CLI and shipped plan
library, the ratchet + merge-queue doctrine templates, and the self-hosting
release tooling — together with the fixtures/eval repo.

### WS-A — Kernel: op contract, plan runner, journal, budget governor

- T1.1 Types freeze — op contract, result taxonomy, plan/journal types, driver seam types ([#7](https://github.com/camerontaylor/cq-toolkit/pull/7))
- T1.2 Plan runner, run manifest, NDJSON journal, replay resume ([#8](https://github.com/camerontaylor/cq-toolkit/pull/8))
- T1.3 Budget governor + rescue lane ([#9](https://github.com/camerontaylor/cq-toolkit/pull/9))
- T1.6b: DD-9 api-equivalent budget — costBasis, maxUsd on modeled cost, independent maxTokens ([#12](https://github.com/camerontaylor/cq-toolkit/pull/12))
- fix(kernel): close review-debt #17 non-frozen items — mirror-only numeric domains, ISO journal timestamps, I10 wording ([#113](https://github.com/camerontaylor/cq-toolkit/pull/113))

### WS-B — Driver seam, drivers and harness

- T1.4 Minimal harness, price map, driver-conformance suite, ai-sdk driver ([#10](https://github.com/camerontaylor/cq-toolkit/pull/10))
- T1.5: subprocess driver (resumed) — 2nd conformance lane, observed-model check, hygiene rider ([#11](https://github.com/camerontaylor/cq-toolkit/pull/11))
- T1.6: claude-agent driver (optional peer) — install matrix, DD-1 spike, DD-2, eval axes ([#13](https://github.com/camerontaylor/cq-toolkit/pull/13))
- VB1C gate fixes: reasoning semantics, routeFor guard, barrel exports, table pin ([#32](https://github.com/camerontaylor/cq-toolkit/pull/32))
- T1.8 step 1: ACP driver strategy — protocol subset, seam mapping, discovery, cut line (no code) ([#34](https://github.com/camerontaylor/cq-toolkit/pull/34))
- T1.8 step 2: the acp driver — fourth lane on the frozen seam (probes, driver, fixture, eval column) ([#37](https://github.com/camerontaylor/cq-toolkit/pull/37))
- fix(live): the deepseek leg requests the served id — costUSD honest for the unpriced served model ([#57](https://github.com/camerontaylor/cq-toolkit/pull/57))
- fix(live): the deepseek leg requests the served id — costUSD honest for the unpriced served model ([#58](https://github.com/camerontaylor/cq-toolkit/pull/58))
- fix(live): the deepseek eval cell requests the served id (conductor decision) ([#59](https://github.com/camerontaylor/cq-toolkit/pull/59))
- fix(live): the zai ai-sdk eval cell requests the coding wire served id ([#60](https://github.com/camerontaylor/cq-toolkit/pull/60))
- fix(eval-infra): abort verdict gates the spike exit status; GLM constants split per lane (PR #52/#60 threads) ([#101](https://github.com/camerontaylor/cq-toolkit/pull/101))
- fix(acp): close the two PR #97 follow-ups — malformed reported usage is an error run; an unsendable rejection terminates ([#115](https://github.com/camerontaylor/cq-toolkit/pull/115))
- fix: last two regrowth findings — quoted cmd.exe argv elements; catch wrappers rejected at scan ([#119](https://github.com/camerontaylor/cq-toolkit/pull/119))
- fix: close the PR #114/#118/#119 follow-ups — index bounds, drain-then-exit, verified ref scoping, anchored keys, outer cmd quotes ([#123](https://github.com/camerontaylor/cq-toolkit/pull/123))

### WS-C — Gate trio, ledger and check adapters

- feat(gates): CheckRunner contract + vitest/eslint/tsc adapters (C1) ([#62](https://github.com/camerontaylor/cq-toolkit/pull/62))
- feat(gates): baselineProbe + regressionGate + drift-surviving fingerprints (C2) ([#67](https://github.com/camerontaylor/cq-toolkit/pull/67))
- feat(gates): hackDetector + worker-commit gate (C3) ([#73](https://github.com/camerontaylor/cq-toolkit/pull/73))
- feat(ledger): novel-error ledger with recurrence, suppression, escalation (C4) ([#78](https://github.com/camerontaylor/cq-toolkit/pull/78))
- fix(ledger): close the PR #78 review cluster (ENOENT containment, parse bounds, lock staleness, publish modes, lock receiver) ([#93](https://github.com/camerontaylor/cq-toolkit/pull/93))
- fix(ledger): PR #93 review follow-ups — ancestor walk for nested ENOENT, lstat fault propagation ([#95](https://github.com/camerontaylor/cq-toolkit/pull/95))
- fix(kernel,cli,review): lossless walks see ALL own keys; fetch caps validate (PR #31/#63 threads + #76) ([#103](https://github.com/camerontaylor/cq-toolkit/pull/103))

### WS-D — Sweep: planner, worktrees, salvage, PR ops

- feat(sweep): planSweep, git-mutation mutex, worktreeFor (D1) ([#138](https://github.com/camerontaylor/cq-toolkit/pull/138))
- feat(sweep): salvage classifier + age-based cleanup (D2) ([#156](https://github.com/camerontaylor/cq-toolkit/pull/156))
- feat(pr): tracker-first assemblePrs + fleet run report (D3) ([#165](https://github.com/camerontaylor/cq-toolkit/pull/165))
- feat(plans): shipped sweep + test-fix plans, e2e scratch-repo sweep (D4) ([#172](https://github.com/camerontaylor/cq-toolkit/pull/172))

### WS-E — Review-loop ops

- feat(review): fetchReviewState + shared thread vocabulary + I11 trap tests (E1) ([#63](https://github.com/camerontaylor/cq-toolkit/pull/63))
- feat(review): classifyThreads decision table + planReviewBatch (E2) ([#71](https://github.com/camerontaylor/cq-toolkit/pull/71))
- feat(review): replyAndResolve + verifyReviewOutcome + prWorktree (E3) ([#75](https://github.com/camerontaylor/cq-toolkit/pull/75))
- E4: fixReviewItem op + shipped review-loop plan (+ review-debt #121 #122) ([#140](https://github.com/camerontaylor/cq-toolkit/pull/140))
- E5: live review-loop integration — seeded threads fixed/replied/resolved, re-run a no-op ([#157](https://github.com/camerontaylor/cq-toolkit/pull/157))

### WS-F — Merge-prs ops

- feat(merge): classifyPrs — the I2 acceptance decision table (F1) ([#125](https://github.com/camerontaylor/cq-toolkit/pull/125))
- feat(merge): planMergeOrder — topological stacked ordering (F2) ([#131](https://github.com/camerontaylor/cq-toolkit/pull/131))
- feat(merge): executeMerges effects seam + diagnoseMergeFailure (F3) ([#133](https://github.com/camerontaylor/cq-toolkit/pull/133))
- feat(merge): resolveConflict agent + shipped merge-prs plan (F4) ([#136](https://github.com/camerontaylor/cq-toolkit/pull/136))
- test(merge): live 3-PR stack drill — merge commits only, seeded conflict resolved by union (F5) ([#154](https://github.com/camerontaylor/cq-toolkit/pull/154))
- fix(merge): VB3F batch-gate remediation — propagation-aware prompt, seam docs ([#162](https://github.com/camerontaylor/cq-toolkit/pull/162))
- fix(cost,merge): account fix/conflict spend, pin merge heads, worker dispatch (#185, #186) ([#191](https://github.com/camerontaylor/cq-toolkit/pull/191))
- fix(merge): re-read the forge base ref before executing merges (#193) ([#196](https://github.com/camerontaylor/cq-toolkit/pull/196))

### WS-G — Analyze/remediate ops

- feat(analyze): collectFailures + clusterErrors with honest confidence (G1) ([#135](https://github.com/camerontaylor/cq-toolkit/pull/135))
- feat(analyze): renderAnalysisReport + applyRemediation with ast-grep codemod path (G2) ([#151](https://github.com/camerontaylor/cq-toolkit/pull/151))
- feat(analyze): playbook registry with quarantine, shipped analyze plan, e2e fixture (G3) ([#164](https://github.com/camerontaylor/cq-toolkit/pull/164))

### WS-H — Ratchets and merge-queue doctrine

- T0.3 Merge-queue workflow templates + instantiation ([#3](https://github.com/camerontaylor/cq-toolkit/pull/3))
- feat(ratchet): captureBaseline + metric adapters (H1) ([#61](https://github.com/camerontaylor/cq-toolkit/pull/61))
- feat(ratchet): checkRatchet + monotonic guard (H2) ([#74](https://github.com/camerontaylor/cq-toolkit/pull/74))
- feat(ratchet): proposeBaselineUpdate (H3) ([#86](https://github.com/camerontaylor/cq-toolkit/pull/86))
- feat(ratchet): self-host swap + template drills (H4) ([#105](https://github.com/camerontaylor/cq-toolkit/pull/105))
- fix(ratchet): close review-debt #72 and #69 — guarded direction snapshot, non-throwing message mapper, temp ownership at open ([#107](https://github.com/camerontaylor/cq-toolkit/pull/107))
- fix(ratchet): close review-debt #79/#80 — the monotonic guard decodes JSON-escaped string fields before comparing ([#108](https://github.com/camerontaylor/cq-toolkit/pull/108))
- fix(ratchet): close review-debt #66 and #68 — family barrel surface + per-path capture lock ([#109](https://github.com/camerontaylor/cq-toolkit/pull/109))
- fix(ratchet): close review-debt #87 — authoritative proposal verdict, git-accurate ref rules, skip-path pins ([#110](https://github.com/camerontaylor/cq-toolkit/pull/110))
- fix(ratchet): close the PR #108/#109/#110 follow-ups — key-presence fail-closed, lock-compromise containment, git-accurate ref rules ([#118](https://github.com/camerontaylor/cq-toolkit/pull/118))
- fix(ratchet,ops): close review-debt #120 — exact normalization key, (head,base)-scoped PR lookup, lifecycle pin, stale enumerations ([#124](https://github.com/camerontaylor/cq-toolkit/pull/124))
- fix(ratchet): land the property-position key anchors for real + the discriminating fixture ([#126](https://github.com/camerontaylor/cq-toolkit/pull/126))
- fix: close the PR #124/#126/#127 follow-ups — template-first edit, delimiter-aware key anchors, all coverage roots ([#128](https://github.com/camerontaylor/cq-toolkit/pull/128))
- test(ratchet): the discriminating key-presence pin for the delimiter-aware anchors (PR #128 review) ([#129](https://github.com/camerontaylor/cq-toolkit/pull/129))
- test(ratchet): pin the direction-key delimiter path (PR #129 review) ([#130](https://github.com/camerontaylor/cq-toolkit/pull/130))
- chore(ratchet): tighten baselines (1 metric) ([#198](https://github.com/camerontaylor/cq-toolkit/pull/198))

### WS-I — CLI and shipped plan library

- feat(cli): op registry, I1 output/exit machinery, CLI framework, from-source smoke (I1) ([#64](https://github.com/camerontaylor/cq-toolkit/pull/64))
- fix(cli): close the PR #64 review-debt cluster — bin mapping, throwing schema gates, cyclic plans, backslash roots ([#106](https://github.com/camerontaylor/cq-toolkit/pull/106))
- fix(registry): close review-debt #82 — the strictness gate unwraps wrapper-hidden object schemas ([#112](https://github.com/camerontaylor/cq-toolkit/pull/112))
- feat(cli): T4.2 CLI completeness — registry closure, I1 conformance, TS/CLI parity ([#192](https://github.com/camerontaylor/cq-toolkit/pull/192))
- feat(cli): T4.3 plan subcommands + per-plan CLI smoke ([#194](https://github.com/camerontaylor/cq-toolkit/pull/194))

### WS-K — Self-hosting and publication

- T0.1 Repo birth — MIT license, ignores, denylist scan live ([#1](https://github.com/camerontaylor/cq-toolkit/pull/1))
- T0.2 Toolchain skeleton, required static check, placeholder ratchet ([#2](https://github.com/camerontaylor/cq-toolkit/pull/2))
- T0.4 Doctrine text I1-I11 (docs-only — the I4 proof) ([#4](https://github.com/camerontaylor/cq-toolkit/pull/4))
- T0.5 Package-name check, placeholder reservation (blocked on credentials), DD-8 re-verification ([#5](https://github.com/camerontaylor/cq-toolkit/pull/5))
- VB0T batch gate: resolve all 7 cross-PR findings ([#6](https://github.com/camerontaylor/cq-toolkit/pull/6))
- T1.7: stage-1 self-hosting — from-source smoke, pack audit, live-drivers wiring ([#52](https://github.com/camerontaylor/cq-toolkit/pull/52))
- chore(coderabbit): Configure reviews and require two pre-PR cycles ([#116](https://github.com/camerontaylor/cq-toolkit/pull/116))
- build!: Implement agent mechanical tooling ([#132](https://github.com/camerontaylor/cq-toolkit/pull/132))
- feat(selfhost): T4.1 stage-2 automation switch — scheduled review-loop + merge-prs from source ([#182](https://github.com/camerontaylor/cq-toolkit/pull/182))
- docs: T4.4 generated op reference + README doctrine + policy adoption guide ([#197](https://github.com/camerontaylor/cq-toolkit/pull/197))

### Review-debt burn-down (RD lane)

- review-debt (RD-E): doctrine I2 freshness, docs accuracy, eslint rule tests ([#27](https://github.com/camerontaylor/cq-toolkit/pull/27))
- fix(kernel): runner resume-safety and journal integrity (review-debt RD-C) ([#31](https://github.com/camerontaylor/cq-toolkit/pull/31))
- review-debt RD-D: gate promotion invariants, repo-wide action pinning, scan self-test controls, demo credential gate ([#33](https://github.com/camerontaylor/cq-toolkit/pull/33))
- fix(kernel,driver,harness): review-debt fixes — RD-B (#14 #15 #18 #19 #24 #26 #29) ([#36](https://github.com/camerontaylor/cq-toolkit/pull/36))
- fix(acp): land the PR-37 review-debt cluster (RD-F, issues #38-#51) ([#53](https://github.com/camerontaylor/cq-toolkit/pull/53))
- fix(acp): close the PR #37 review cluster — token-count validation, observed-only pricing, session-scoped permission asks ([#97](https://github.com/camerontaylor/cq-toolkit/pull/97))
- fix(acp): a pre-pin mode report is STALE pin evidence — snapshot the update seq before the pin ([#99](https://github.com/camerontaylor/cq-toolkit/pull/99))
- fix(acp): close review-debt #54/#55 — resolved .cmd/.bat shims launch through cmd.exe on win32 ([#111](https://github.com/camerontaylor/cq-toolkit/pull/111))
- fix: four PR-review follow-ups — root-skipped permission test, drain-before-exit, array own-key validation, lockfile bin ([#114](https://github.com/camerontaylor/cq-toolkit/pull/114))
- fix(coverage): broaden the coverage ratchet basis — all src/** files count (review-debt #117) ([#127](https://github.com/camerontaylor/cq-toolkit/pull/127))
- fix(denylist): repo-relative probe_path guard + quoted mapping-key triggers (#134, cq-fixtures#5 upstream) ([#177](https://github.com/camerontaylor/cq-toolkit/pull/177))
- feat(plans): export merge-prs and analyze plan builders through the plans barrel (#147, #167) ([#178](https://github.com/camerontaylor/cq-toolkit/pull/178))
- fix(merge): scope the realMergeEffects gh spawn to repoRoot, strip inherited GH_REPO (#163) ([#180](https://github.com/camerontaylor/cq-toolkit/pull/180))
- fix(analyze): sha256-truncated report handle (#155) + newline-join diff block extension (#159) ([#181](https://github.com/camerontaylor/cq-toolkit/pull/181))
- fix(sweep): the strand-retry pushes only the recorded scanned commit sha (#174) ([#184](https://github.com/camerontaylor/cq-toolkit/pull/184))
- fix(pr): tracker-body serialization + sweep tracker-branch create/push (#171, #173) ([#188](https://github.com/camerontaylor/cq-toolkit/pull/188))
- fix(sweep): review-debt sweep 3 — #150 #174 #175 #176 ([#189](https://github.com/camerontaylor/cq-toolkit/pull/189))
- fix(driver): default-deny child env for subprocess workers (#183) ([#190](https://github.com/camerontaylor/cq-toolkit/pull/190))
- fix(denylist): reject Windows-plain-name probe_path segments (fixes #187) ([#195](https://github.com/camerontaylor/cq-toolkit/pull/195))

### WS-J — Fixtures/eval repo (cq-fixtures)

- F0.1 repo birth — license, ignores, denylist scan, layout skeleton ([#1](https://github.com/camerontaylor/cq-fixtures/pull/1))
- J1: result-row + comparison-table schema, suite interface, decision stubs (+T1.5 hygiene rider) ([#2](https://github.com/camerontaylor/cq-fixtures/pull/2))
- J2: thin-custom runner over toolkit ops + CI skeleton ([#6](https://github.com/camerontaylor/cq-fixtures/pull/6))
- J3: micro-suites — 5 seeded faults (fixer-worker) + 10 labeled threads (review-classifier) ([#10](https://github.com/camerontaylor/cq-fixtures/pull/10))
- J4: CI smoke on PR, model-axis matrix on dispatch, DD-4 schema-compliance dimension, cost column proof ([#12](https://github.com/camerontaylor/cq-fixtures/pull/12))
- J5 — real-driver matrix: four-wide lanes, served-id routing, review-debt #11/#5 closure ([#13](https://github.com/camerontaylor/cq-fixtures/pull/13))
- J5 snapshot 2026-09-18 — first live real-driver matrix tables + README ([#16](https://github.com/camerontaylor/cq-fixtures/pull/16))
- J6: package-boundary dist leg, flip script, release checklist ([#17](https://github.com/camerontaylor/cq-fixtures/pull/17))
- fix(runner+ci): account the ACP preflight probe inside the governor/journal (fixes #14) ([#18](https://github.com/camerontaylor/cq-fixtures/pull/18))
- VB4J: label snapshot Scored column as probes ([#19](https://github.com/camerontaylor/cq-fixtures/pull/19))

### npm

- `@camerontaylor/cq-toolkit@1.0.0` — publish pending owner action
  (`AUTOPUBLISH=no`); the `0.0.0` reservation remains on the registry until
  the owner publishes. See `RELEASE.md`.
