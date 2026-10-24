# review.address fixture transcript

Captured on triton from fresh fixture repositories. The spawned production
CLI uses a scripted provider factory, real git, a hermetic executable
gitleaks through production scanner composition, the dev ledger and the
production `review.run` re-review. No provider credentials or network are
used. The fixture omits `review.denylistPatternsFile`, exercising portable
default scanning. Each invocation starts a fresh repository.

```sh
pnpm test:narrow --include-integration test/e2e/review/review-address.e2e.test.ts test/cli/registry.test.ts
```

Each fixture executes this command with temporary paths and its configured
worker model/token budget:

```sh
node test/fixtures/address-cli/entry.mjs review.address --repoRoot=<fixture>/repo --source=local --base=<seed-sha> --record=<fixture>/findings.json --journalDir=<fixture>/journal
```

Observed results from the fresh fixture run:

| Worker   | Budget | CLI exit | fixesPerRun | Open blocking | Token usage       |
| -------- | -----: | -------: | ----------: | ------------: | ----------------- |
| scripted |   1000 |        0 |           1 |             0 | input 8, output 4 |
| defer    |   1000 |        3 |           0 |             1 | input 4, output 2 |
| scripted |      1 |        3 |           0 |             1 | input 2, output 1 |

Success produces one commit touching only `src/a.ts`, with the seeded
commit as its parent, after edit, feedback and reviewer closure. Actual
re-review returns no findings. The deferred finding stays open at the
round cap. The one-token budget case reports the settled call's three
tokens honestly, restores the partial edit and starts no further provider
call. Cost is absent for the unpriced scripted models. All three stdout
artifacts retain their full report and exactly match
`<journalDir>/review-address-report.json`.

Separate SDK tests exercise the PR cycle with a fake forge, in-memory git
and scripted driver: engine-owned candidate gates, verified publication
before reply/resolve, a human sibling retaining its open finding while
the successful sibling publishes, and publication opt-out. Real-git causal
tests hold a sibling edit uncommitted while related checks and reviewer
closure run; neither gate can borrow that content. Legacy review-loop tests
pin both execution orders for unchanged evidence and refuse journal-only
resolve carry when the authenticated reply is absent.
The follow-up checkpoint also spawns the successful local CLI through a
symlink alias to the repository root, and tests canonical task identity,
outside-symlink refusal, fresh-checkout dependency reuse, nested governor
accounting, follow-up discussion, and same-file/fileless human settlement
without blocking a verified sibling's publication. Benign feedback/closure
prose mentioning an index, budget, cancel or upload reaches rescue and leaves
sibling work eligible; actual driver stops, parent cancellation and candidate
mutation still refuse and retain evidence.

Live dogfood is recorded separately in `dogfood-log.md`. `dev.cycle` is
sequenced after S6 and is unavailable for this slice's initial exercise.
