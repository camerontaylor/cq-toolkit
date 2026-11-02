# Bulk address live evidence, 2026-10-31

The serial explicit-PR executor ran against two real open PRs with external
review threads: [#681](https://github.com/camerontaylor/cq-toolkit/pull/681) and
[#704](https://github.com/camerontaylor/cq-toolkit/pull/704). Both now have a
verified, published repair and a resolved thread. The final batch admitted both
PRs and reported partial completion truthfully; it did not clear all feedback.
Full R5 is not complete: query discovery, configured parallel scheduling and
advisory per-head enrollment remain outside this first executor slice.

Implementation merges (all independently reviewed at their exact heads with
required CI green):

| PR                                                           | Merge                                      | Change                                                      |
| ------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------- |
| [#713](https://github.com/camerontaylor/cq-toolkit/pull/713) | `2f384e3cb1ad4732134094c098bfe48ace8e2c47` | Operation, SDK, registry CLI, allocation/aggregation        |
| [#725](https://github.com/camerontaylor/cq-toolkit/pull/725) | `65c5f2909000ddc1920359d7bb79182ccc72871a` | Per-PR unclean summaries and CLI example                    |
| [#726](https://github.com/camerontaylor/cq-toolkit/pull/726) | `8dd725c91e42642dbb80d98300d8ead4a09b3e18` | Private candidate dependency metadata and check diagnostics |
| [#727](https://github.com/camerontaylor/cq-toolkit/pull/727) | `ad9af76189855faecef6073b7db1f24b63902940` | Private POSIX bin launchers preserving installed locations  |

The final runtime was built from reviewed head
`93b9fa4a753d16d99df8c70f3458d4ae19381cb0`. The launch used `nice -n 5` on
triton, serial PR execution, one round, a one-hour deadline per PR, 20 million
tokens allocated per PR and 40 million in total. The public CLI arguments were:

```sh
cq review.addressMany --repoRoot=. --repo=camerontaylor/cq-toolkit \
  --owner=camerontaylor '--pulls=[704,681]' --maxTokens=40000000 \
  --tokensPerPr=20000000 --rounds=1 --wallMs=3600000 --push=true --json
```

The installed fleet credentials were passed only in-process, using the existing
`Z_AI_API_KEY` to `ZAI_API_KEY` naming mapping and the documented OpenCode Go
base URL. No credential values are part of this record. The operation forces
agent-only review; no inline CodeRabbit CLI review was dispatched. GitHub App
activity following a push is separate from the operation's review calls.

Final invocation, 02:05–04:06 UTC (reports retained under run IDs
`115f871a-14bc-490a-ab30-d5a7c9846c84` and
`da137cf8-30bf-4257-ae2f-394e068ae619`):

| PR   | Admitted head                              | Verified terminal head                     | New verified fixes | Reported tokens |
| ---- | ------------------------------------------ | ------------------------------------------ | -----------------: | --------------: |
| #681 | `4dc7d5c95d1d90750f9e35a87e0d668155029d71` | same                                       |                  0 |       8,047,389 |
| #704 | `ae7517982ed622a769144efd67d5b9e5d12aeed7` | `d7dedb113e5b52825b3d52f3f90fd100da2b0633` |                  1 |       3,937,273 |

Aggregate: `needs-human`, CLI exit 3; two trusted attributed results; zero
exceptions, unattributed results or non-admissions. `fixesPerRun=1` equals the
individual `0+1`. Observed tokens were `11,984,662`, with zero held allocation,
zero unresolved reservations and no allocation stop. These counts include the
reported input, output, cache-read and cache-write tokens; they are not billing
claims. Both legs retained deadline/refusal reasons and outstanding findings.

Published repair evidence across the live attempts:

- #681: [commit 4dc7d5c9](https://github.com/camerontaylor/cq-toolkit/commit/4dc7d5c95d1d90750f9e35a87e0d668155029d71)
  serializes ownership identity reads with authority-chain mutations. It was
  verified and exit-published by the earlier 00:58–01:49 UTC attempt. That attempt
  reported `fixesPerRun=1` and 5,885,458 tokens, exceeded its 5M per-PR allocation,
  and withheld admission of #704. The fixed thread's automatic reply was withheld
  while sibling work was active. After inspecting the remote patch and recorded
  verification gates, the operator [replied and resolved it manually](https://github.com/camerontaylor/cq-toolkit/pull/681#discussion_r4429916781).
- #704: [commit d7dedb11](https://github.com/camerontaylor/cq-toolkit/commit/d7dedb113e5b52825b3d52f3f90fd100da2b0633)
  guards remaining diagnostics after a completed sweep when stderr writes throw.
  It was verified and exit-published by the final batch. GitHub's remote head was
  checked after settlement. CodeRabbit marked the [external thread addressed and resolved](https://github.com/camerontaylor/cq-toolkit/pull/704#discussion_r4424532621)
  after that push; the operation itself had withheld its reply during mixed work.

This demonstrates two-PR admission, independent reports, verified fixes,
publication and truthful partial-result accounting. It does not demonstrate
fully automatic thread closure or a clean outcome on either PR. The aggregate
still says publication is `unknown`; the publication statements above come from
separate remote-head observations, not inferred aggregate metadata. Enrollment
is `not-requested`, not vendor completion. Neither repaired PR is claimed ready
to merge while other findings remain.

The live attempts also exposed deterministic setup failures before usable repair:
missing launch environment names, shared dependency relinking and relocated pnpm
shims. #726/#727 address the latter two. [#729](https://github.com/camerontaylor/cq-toolkit/issues/729)
records wasteful semantic retries after deterministic baseline-check failures.
[#728](https://github.com/camerontaylor/cq-toolkit/issues/728) retains Windows
entrypoint relocation work. The relevant narrow checks passed 105/105 for the
dependency/worker boundary and 17/17 for the shim regression; full-gate authority
was CI, not a local suite run.
