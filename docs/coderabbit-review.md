# CodeRabbit review guidance

CodeRabbit is advisory. Handle its findings like any other review comment:
fix substantive valid findings and explain rejected findings with concrete evidence.
No CLI cycle or vendor-outage deferral enrollment is required.

The merge bar is green `static` and `denylist` on the exact PR head, one independent review of that head, and no unaddressed review comments.

The independent review is an agent PASS posted with `cq-review-post`, a human’s PASS, or a crq review with the `crq-findings` marker, posted by crq under the queue host’s login, whose reviewed range ends at the head and whose findings are all addressed. A clean crq run posts nothing and does not count.

Every thread and finding, including Codex, CodeRabbit, bot and minor findings, must be fixed or answered with a reason, and every thread resolved before merge.
Reviewer independence is between agents or humans, not GitHub accounts.
See [merge policy](promotion-policy.md), including its implementation limit.

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
