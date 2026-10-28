# Blind rejection shadow protocol (R4B)

This standalone pure protocol is opt-in shadow scaffolding. It is not invoked
by `review.address`, changes no disposition, and provides no runtime or semantic
accuracy acceptance. Its only consumer here is scripted offline fixtures.

## Why two phases

At the pinned base `8b92da3b8eb45482139c93818c730f2d29364c68`,
`src/ops/review/addressWorker.ts` sends the original finding and fixer output
in the same rejection-verification prompt (around line 814). A reviewer can
therefore see the argument before forming an independent assessment.

`src/shared/rejectionShadowProtocol.ts` defines an alternative data boundary:

1. The engine creates an initial packet from a strict whitelist: original
   finding id/text and optional file/line; packet id; execution head/tree;
   fixed read-only tool list; remaining token/step/wall caps. Unknown fields,
   including fixer arguments and history, are rejected, also inside the finding.
   The producer must obtain the original finding before reading fixer output;
   the protocol cannot detect argument text disguised as original finding text.
2. Record the initial semantic `real | not-real | uncertain` output separately
   from an engine-owned completion receipt. Definite verdicts require citations,
   but the helper does not read those paths or verify their meaning.
3. Only a complete phase with valid output and positive remaining caps can
   construct reconciliation. Reveal the argument in a field marked `untrusted`,
   alongside the frozen initial semantic output. This adds no authority to the
   argument. An incomplete, cancelled or exhausted receipt cannot enter phase two.
4. Persist both outputs, packets and receipts in a frozen shadow record with
   `dispositionAuthority: none`. A persuasive false rejection, a genuine rejection,
   and independent uncertainty all remain observations; none can close a finding.

## Receipts and limits

Packet/head/tree/tools equality binds each supplied receipt to the expected
packet and phase. These are literal engine-supplied identities, not hashes,
attestations or proof that execution used the named tree. Model semantic output
cannot supply extra receipt fields. The future engine owns receipt provenance.
Use the constructors and their frozen return values; these types are not a
security boundary against an engine fabricating protocol state or receipts.

The scripted initial receipt allows at most four lookups; reconciliation allows
at most one. Each subtracts supplied token/step/wall usage from remaining caps;
overspend or identity/tool changes are refused. These transitions validate
transcript arithmetic only: no executor, accounting hook, lookup interceptor,
provider request or session is created here. A caller lying about usage is not
detected. The tools are fixed for both phases, chosen as `read` with optional
`grep`/`glob`; no edit, write or command tool is supported.

This protocol explicitly uses **two fresh sessions**, rather than a continuation:
initial receives no history and reconciliation receives only the retained
initial verdict and untrusted argument. A repeated session id is refused in a
receipt. This does not prove actual history isolation. A future runtime writer
must enforce fresh sessions, argument withholding, tool allowlists and lookup
admission while sharing the existing run/session budgets; no budget reset is
permitted between phases.

Existing driver `maxTokens` is a soft limit unless strict token budgeting is
explicitly configured; `maxSteps` caps main-loop completed steps and can permit
one structured-output repair. Neither is a lookup quota. Current address-worker
invocation fixes its tool allowlist and applies scan/deadline/accounting hooks,
but those mechanisms are not wired to this protocol. This file makes no new
model/provider provenance, containment, gate-execution or real-session claims.

## Scripted offline evidence and remaining integration

The named fixture `test/shared/rejectionShadowProtocol.test.ts` supplies fake
semantic outputs and engine receipts: no-leak sentinels, frozen phase one,
changed head/tree/packet/tools refusal, four-plus-one and remaining-cap arithmetic,
cancellation/incomplete/exhaustion without phase two, distinct session ids,
persuasive false rejection and genuine/uncertain verdict retention.

No live provider, CLI, network, real contention or empirical accuracy comparison
runs. Scripted verdicts are not proof of model judgement. R9 semantic comparison
remains required before treating blind assessment as an accuracy improvement.
Runtime packet assembly and disposition/report integration remain under the
shared invocation/address/report owners (R1, Q6 and P3 seams); this slice adds
no registry/configuration, provider/session adapter or new public package export.
