# Specification behaviour tests — 2026-10-30

Test-only work on `tests/spec-behaviour-20261030`. Immutable base and initial HEAD:
`a030b84ac6291d251085a17c357db53f44ac0bf5`, merge-base with intended target
`origin/merge-queue`. No production edits or existing expectation changes.

## Authority and evolution

`docs/current-contract-and-backlog.md` (last change `631cce4c`) supersedes the
September specification and pre-October-16 plans. Current doctrine and later owner
interventions take precedence over historical implementation plans. Research was
read-only in `/home/ctaylor/.paseo/worktrees/2g1md6x3/toolkit-queue-20261028`
at `57d426dd645777ef4748bfe59f7793c1702d0591`, beginning with
`plans/upcoming-20261027/README.md`. That index records October-28 acceptance and
October-30 status: E1/E2 landed; proposed E3/E4 behaviour is not presumed current.
Implementation is used to find seams, not as independent specification evidence.
Owner Q32 clarification permits added assertions but requires independently accepted,
currently sourced oracle changes to existing expectations; none were made here.

## Requirement-to-test map

Paths below are relative to the repository unless explicitly marked research.
Existing adequate cases are retained rather than duplicated.

| Area                              | Current intent and provenance / supersession                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Added discriminating cases and existing coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix / approval                    | Contract §9; `docs/adr/0003-approval-token.md` (`f3f802d1`), narrowed by ADR index N5/N6/N11/N12 (index `1587e6d4`): exact subject/state binding, single spend, clean tree with only byte-verified rendered-report exemption. `docs/adr/0006-fix-engine-cli-compositions.md` (`4d34a8b4`) and research `specs/cq-next-step-slice-spec.md` §§core engine/escalation distinguish unattended fix engine from attended analyze/apply. October-23/24 owner decisions supersede an attended loop for the engine. | `test/ops/fix/escalation.test.ts`: package cap exhaustion escalates without consuming a sibling's rescue slot; state remains immutable. Existing `test/ops/analyze/{approval,applyRemediation}.test.ts` cover forged approval, digest/state drift, clean-tree refusal, single-use replay, partial rollback and stranded-file reporting; `test/ops/fix/runFix.test.ts` covers composition. No artificial approval requirement added to `runFix`.                                                                                                    |
| Signer                            | `apps/crq-python/signer/README.md` (`6a41a61b`, registration provenance `d8f132f`): strict bounded regular-file request, byte hash and filename identity, durable result OR claim blocks replay; trust requires bot login + numeric ID + type; newest trusted verdict wins. Later rename-aware scan/final-post handling preserved.                                                                                                                                                                         | Seven cases in `apps/crq-python/test_crq_signer.py`: exact-byte positive control plus renamed filename; malformed schema/date/type rejects before token/CLI; both durable markers preserve evidence on invalid replay; symlink/oversize refusal; identity spoofing and newest failure; original JWT verifies while altered bytes fail; forged App metadata rejected before signing. RSA key and metadata are ephemeral local fixtures, never installed credentials.                                                                                |
| Queue promotion                   | `docs/promotion-policy.md` (`c461b029`): October-16 every-green-tip policy; October-24 #376 makes signer advisory for ordinary ranges, trusted exact-base signer mandatory for privileged changes. Doctrine I3 (`30323856`) assigns FF-only advancement to gate, not queue engine; never force push.                                                                                                                                                                                                       | Two cases in `apps/crq-python/test_promotion_retry.py`: repeated observation closes once without dispatch/push; each forged signer identity component leaves pending state unchanged. Existing retry cases cover scheduling/backoff. Real Git FF/lease/race and main-only refspec coverage lives in `test/selfhost/promote-gate.test.ts`, not a fabricated direct-push queue path.                                                                                                                                                                 |
| Promotion / ratchets / self-merge | Contract §§11/13/17–19; doctrine I3/I5: incomplete summary cannot establish success, adopted thresholds only tighten, independent PASS bound to exact current head. Self-merge remains off by default.                                                                                                                                                                                                                                                                                                     | `test/selfhost/promote-gate.test.ts`: foreign-tip newer success cannot override current-tip failure, either row order. Existing gate real bare-remote cases cover FF/races. Existing `test/selfhost/self-merge-prs-recheck.test.ts` covers stale head, own identity, API failure and protected branch; `test/ops/ratchet/{monotonicGuard,verifyRatchet}.test.ts` cover directions, trusted baseline and missing summaries. No self-merge activation.                                                                                               |
| Git cleanup                       | Historical research `plans/breakdown/ws-d-sweep-ops.md`: strict clean includes untracked; cleanup bounded by run prefix and age, default dry-run, dirty removal requires explicit force. Current contract supersedes historical protocol rules. Later research `plans/upcoming-20261027/fix-engine-lane.md` disk-bound cleanup is a candidate, not authority for new destructive behaviour. Source helper extraction `a35ef28c` / test relocation `a317003d` supply provenance only.                       | `test/ops/sweep/cleanup.test.ts`: real temp Git worktree with unpublished commit survives stale directory time because branch tip is fresh; verifies tip, branch and committed content. Existing real-Git smoke and conservative dirty-worktree cases retained. No network/remote required. **Unresolved:** surviving specification does not clearly promise indefinite protection of every aged unpushed branch; this test does not claim that guarantee.                                                                                         |
| Forge / merge                     | Current contract exact-head review and retry-free engine composition, ADR 0006 and doctrine I8: moved-head refusal, complete pagination, provider failure escalates without agent conflict retry or blocking siblings. Historical research WS-D review plans subordinate to current contract.                                                                                                                                                                                                              | `test/ops/review/fetchReviewState.test.ts`: rate limit on second GraphQL page refuses partial snapshot. Existing adapter pagination/cursor/cap/malformed cases and `test/ops/review/traps.test.ts` cover transport shapes. `test/ops/merge/runPrs.test.ts`: rate-limit one PR once, still merge independent sibling, no conflict agent/second pass; existing moved-head cases prevent merge. Final new tests use bounded injected offline effects.                                                                                                 |
| Sandbox / capture / parsers / ACP | `docs/sandbox-container-image.md` (`68c75548`): container model-only network isolation; host launchers experimental. Doctrine I5 plus historical research WS-C requires real parser captures and indeterminate incomplete evidence. Research WS-H separates raw capture from adoption guards. `docs/acp-driver.md` (`80f7743e`) and strategy (`79238534`): isolated spawn per invocation, no retry/pooling; output-schema validation belongs to each invocation.                                           | `test/sandbox/backend.test.ts`: child flags cannot become container network/privilege options. `test/ops/ratchet/captureBaseline.test.ts`: missing summary preserves previous bytes and subsequent valid capture recovers. `test/ops/gates/adapters.test.ts`: two real-capture exit-zero negative controls; inconsistent ESLint counts/messages must be indeterminate (**red**). `test/driver/acp.test.ts`: invalid schema result cannot leak schema to next run on same driver. Existing permission/mode/cancellation/conformance cases retained. |

The parser fixtures `test/fixtures/check-outputs/{vitest,eslint}.json` originate in
`9930b8c60109e4d72e9632e2400840b2dec59fca`, whose commit records genuine captured
outputs (capture paths include `/private/tmp/cq-gates-fixtures.TA8IFi/`). No additional
tool-version or capture-command metadata was established. The new missing-message
case explicitly labels its mutation as fault injection, not a newly recorded output.

Raw capture already permits measuring a worse value. This work does not endorse
loosening adopted thresholds: existing adoption/verification guards cover that.
Whether global I5 should also prohibit every worsening raw capture is a scope
ambiguity, not a basis for inventing an oracle from current code.

## Observations

Twenty new cases (nine Python, eleven TypeScript, counting the two parser rows).
All execution used canonical named `pnpm test:narrow` on triton. Automatic wrapper
stale-dist bootstrap was used; no manual build, full suite, dependency install or
new dependency was requested. No production fixes or publishing actions.

The sole retained red: ESLint output still has positive `errorCount`, but its
messages are absent. The adapter returns `parsed` with no failures instead of
`indeterminate`. This violates the I5 incomplete-evidence rule; assertion retained.
Eleven sandbox tests are skipped by existing platform guards on Linux, not by this
change. ACP is the existing offline fake-protocol integration harness.

During development, an incorrect new forge test runner argument invoked the default
read transport instead of the intended fake and failed; it was corrected to the
third argument and rerun green. Initial Python mock and container-flag assertion
setup errors were also corrected. These are not product regressions or claimed
successful executions. Final results below supersede those intermediate runs.

Canonical final result lines (load/uptime stamps included):

Final `pnpm run check:static`, `pnpm run format:check`, `pnpm run knip` and
`git diff --check` passed. The earlier static check caught the incorrect injected
runner argument described above; the final check passed after correction.

```text
test:narrow result="pass" exit=0 files=2 projects="python" tests="34/34" failed=0 skipped=0 wait="0.0s" duration="0.7s" nice=5 load="8.7" uptime="1046192s" source="explicit" ran="apps/crq-python/test_crq_signer.py,apps/crq-python/test_promotion_retry.py"
test:narrow result="pass" exit=0 files=2 projects="pure,integration" tests="111/111" failed=0 skipped=0 wait="0.0s" duration="14.1s" nice=5 load="1.6" uptime="1046073s" source="explicit" ran="test/driver/acp.test.ts,test/driver/process-inventory.test.ts"
test:narrow result="pass" exit=0 files=7 projects="pure,process" tests="276/276" failed=0 skipped=0 wait="0.0s" duration="23.4s" nice=5 load="8.3" uptime="1046143s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/fix/escalation.test.ts,test/ops/merge/runPrs.test.ts,test/ops/ratchet/captureBaseline.test.ts,test/ops/review/fetchReviewState.test.ts,test/ops/sweep/cleanup.test.ts,test/selfhost/promote-gate.test.ts"
test:narrow result="pass" exit=0 files=7 projects="pure,process" tests="256/256" failed=0 skipped=0 wait="0.0s" duration="28.0s" nice=5 load="6.0" uptime="1046221s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/analyze/applyRemediation.test.ts,test/ops/analyze/approval.test.ts,test/ops/fix/runFix.test.ts,test/ops/ratchet/monotonicGuard.test.ts,test/ops/ratchet/verifyRatchet.test.ts,test/selfhost/self-merge-prs-recheck.test.ts"
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="108/120" failed=1 skipped=11 wait="0.0s" duration="7.5s" nice=5 load="3.5" uptime="1046405s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/gates/adapters.test.ts,test/sandbox/backend.test.ts"
```
