# CodeRabbit review guidance

CodeRabbit is advisory. Handle its findings like any other review comment:
fix substantive valid findings and explain rejected findings with concrete evidence.
No CLI cycle or vendor-outage deferral enrollment is required.

The merge bar is green `static` and `denylist` on the exact PR head plus one
independent exact-head `PASS`. The reviewer must be an independent agent or
human; sharing the author's GitHub account does not remove independence.
Post the reviewer identity, exact head SHA and `PASS` in the review comment.
See [merge policy](promotion-policy.md).

The GitHub CodeRabbit App can review opened PRs; `.coderabbit.yaml` configures
its feedback. CLI review remains optional.

Optional CLI reuse validates that a retained raw log is readable and matches
its recorded digest, when present. Historic records without a digest remain
readable but have unverified integrity. New cycles record a digest when
available; a failed hash read keeps the cycle and its findings without
integrity metadata. Reuse rescans current content under current scanner policy
before selecting a retained cycle; scanner policy is not frozen in its identity.

An unreadable retained log prevents reuse and causes a fresh dispatch. An altered
log or content the current scanner now forbids refuses review without dispatch.
