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

## Retired author-enrollment route (S2b-ii)

The SDK no longer exposes `dev.review --action=enroll|status|fallback` or the
`author-v1` client forced command. Managed CodeRabbit review is submitted
through the queue's `review-v1` route (see [queue client](queue-client.md)); an
unsupported server is reported, never worked around with a direct CLI launch.

The Python author server modules (`author_lease.py`, `author_quota.py`,
`author_transport.py` and the `author-v1` dispatcher route) are retained: the
deployed runner still imports them. No installed author SSH identity and no
nonterminal author queue item exists, so no new v1 author request can be
created through the SDK.

Optional CLI reuse validates that a retained raw log is readable and matches
its recorded digest, when present. Historic records without a digest remain
readable but have unverified integrity. New cycles record a digest when
available; a failed hash read keeps the cycle and its findings without
integrity metadata. Reuse rescans current content under current scanner policy
before selecting a retained cycle; scanner policy is not frozen in its identity.

An unreadable retained log prevents reuse and causes a fresh dispatch. An altered
log or content the current scanner now forbids refuses review without dispatch.
