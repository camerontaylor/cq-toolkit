# Explicit configured agent review

`cq dev.review --reviewer=agent:reviewer` selects `roles.reviewer` from
`cq.json`. The suffix is a configured role, not a provider/model address.
The historical provider/model spelling in #352 does not describe this
binding: the shipped runner accepts the role `reviewer` only.

The binding requires readable, valid configuration, a `roles.reviewer`
provider/model specification, and a run token budget. The session engine
resolves that specification through the driver factory. A missing role,
unavailable configuration or driver, or an unsupported delivery lane refuses
the review with `needs-human`; it does not fall through to CodeRabbit.
Configuration presence alone does not prove provider availability.

## Safety and completion

Both reviewer choices use the common component collection, pre-upload scan,
host review lock and worktree drift checks. Committed, staged, unstaged and
untracked evidence must be scannable. A scanner hit or fault, an unscannable
untracked symlink, an oversized component, or a changed excluded scanner
corpus refuses before agent dispatch. The configured runner is invoked inside
`effects.withHostLock`; production effects bind that boundary to the shared
host review mutex.

Agent sessions use the read-only sandbox and read/search allowlist, with
mutation tools disabled. The session also scans outbound requests and tool
output. Only the `ai-sdk` lane can supply the required pre-upload evidence.
These are application containment checks, not a claim of OS isolation against
other processes modifying the workspace.

An `ok` engine result becomes terminal only with complete v2 coverage matching
the reviewed head, base and scope. Failed, incomplete or unverifiable review
results are blocked. Logs retain the role identity, base, head, dirty identity,
scope, completion and coverage; the ledger also retains target, cycle ID,
findings and log path. Ordinary lock, drift or log-write failures refuse
without a cycle; cancellation/budget handling can instead persist a blocked
cycle. The ledger does not separately attest the resolved provider/model.

## Author readiness and policy boundary

A configured terminal full-scope agent cycle may satisfy the review leg of
`dev.ready` at the same target/base/head/dirty identity. A current green check
and the remaining readiness prerequisites are still required. Readiness names
`agent:reviewer`, its cycle ID and the check ID, with `evidenceClass: author`
and the explicit caveat that this is not verification. A later blocked attempt
prevents an older terminal cycle from supplying readiness, including when that
older cycle came from CodeRabbit.

Agent evidence never becomes a completed CodeRabbit CLI cycle or independent
merge acceptance. This explicit choice does not implement automatic vendor
substitution, queued vendor debt policy (Q6/DEC1), or spend policy (P3).

## Offline proof and its limits

The [scripted fixture transcript](transcripts/agent-fallback-scripted.md)
connects the evidence to named tests. The composed fixture uses fake
`scripted` / `fixture-reviewer` configuration, the real config binding and
session engine, and an instrumented host-lock boundary. Git and the temporary
fixture ledger are real; model responses, scans, the lock and green check
records are scripted. It proves boundary use, not real mutex contention,
credential availability, live provider behavior or production runtime
acceptance. It does not run a check gate inside the fixture.

Existing config/refusal coverage lives in
`test/ops/dev/agentReview.test.ts`; lower-level containment coverage lives in
`test/ops/dev/effects.test.ts` and `test/harness/search-tools.test.ts`.
The R7 additions in `test/ops/dev/review.test.ts` compose config, dispatch,
log/ledger identity and readiness, and explicitly require zero agent dispatch
on safety refusal. `test/ops/dev/ready.test.ts` covers the mixed-reviewer
blocked-attempt case. Generated `docs/ops/dev.review.md` remains the schema
reference and must be regenerated rather than edited by hand.
