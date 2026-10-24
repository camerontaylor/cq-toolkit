# dev.cycle fixture transcript

Captured on triton from a fresh fixture repository. The composition legs are
scripted at the op seams (the dev-family repo harness: real git, a bare
`origin`, an in-repo dev ledger, scripted `check`/`review`/`address`/`open`
legs); no provider, credential, or network is touched. The fixture pins the
composition's own behaviour — leg order, publication, and the two exit
shapes — while the legs themselves carry their own transcripts
(`review-run.md`, `review-address.md`).

```sh
pnpm test:narrow test/ops/dev/cycle.test.ts test/ops/pr/open.test.ts test/ops/dev/registry.test.ts test/cli/registry.test.ts
```

Observed from the fresh-fixture run (branch `feature/x` over
`origin/merge-queue`, pushed head, seeded terminal cycle + green check):

| Scenario                                         | Legs fired                                             | Publication                                                                     | Op result                                                                                |
| ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Clean loop                                       | check → review.run → address (clean) → final check     | push + `pr.open` ready                                                          | ok; report carries the PR number and `followUp: cq review.address --source=pr:<n>`       |
| Round cap                                        | check → review.run → address (needs-human with report) | push + `pr.open` DRAFT (gaps section) + findings section composed onto the body | needs-human; reason carries the open finding, `draft PR #<n>`, and the follow-up command |
| Not-ready after a clean address (untracked file) | check → review.run → address (clean) → final check     | push + DRAFT with the gaps section, no findings section                         | needs-human naming the untracked file and the follow-up command                          |
| Red first check                                  | check only                                             | none                                                                            | failed verbatim (`dev.cycle (dev.check): …`), zero pr calls                              |
| Red final check after a clean address            | check → review.run → address → final check             | none                                                                            | failed verbatim (`dev.cycle (dev.check (final)): …`)                                     |
| Blocked review source                            | check → review.run                                     | none                                                                            | needs-human verbatim, zero pr calls                                                      |
| Push failure                                     | check → review.run → address → final check             | push refused                                                                    | needs-human naming the branch; nothing opens                                             |
| `push:false`                                     | check → review.run → address → final check             | none (opt-out)                                                                  | ok; report `pushed: false`, pr.open still runs                                           |

The round cap's DRAFT body carries pr.open's NOT-READY gaps section
(`<!-- cq:dev-readiness-gaps -->`) followed by the composition's findings
section (`<!-- cq:dev-findings -->`): the open blocking findings one line
each, then every engine-logged attempt (finding id, tier/invocation, model,
tokens, wall time) — markdown-safe through the shared `mdSafe` rule (pipes
escaped, backticks rewritten, angle brackets stripped).

The findings section is composed with the SAME managed-section protocol the
readiness section uses (`composeSection`), so a re-run replaces its own span
and never duplicates it.

Live dogfood is recorded separately in `dogfood-log.md`.
