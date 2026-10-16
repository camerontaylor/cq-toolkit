# ADR-0005 — Architecture revision: a layered monorepo with policy as the primary library

- **Status:** accepted in principle by the owner on 2026-10-16 (rulings D-A, D-B, D-C, D-P, D-E′, D-G, D-J, ADR-0005-D-H)
- **Supersedes in part:** ADR-0001 §lanes (four → three), ADR-0002 Annex B (configuration resolver), ADR-0003 §rescue, the kernel "freeze rule"; ADR-0003 §lane classification awaits the Phase 1.8 contract decision
- **Keeps in force:** ADR-0004 (trust boundaries) in substance; I1–I11 doctrine

## Context

The toolkit shipped as one 77k-LOC package whose layering exists in test fakes and injected
seams rather than package boundaries. Measured on `main` @ a0135831: ops are 70–85 % pure
decision logic behind injected I/O seams; ~5.9k LOC of source is unreachable from any runtime
entry; the governor's HARD budget path cannot bind; three import cycles and one layering
inversion exist; 1,205 lines of deciding bash are duplicated across workflows; twelve review and
promotion decisions are encoded twice in two languages (toolkit TS and crq Python); and the
test suite (1.5× source) re-asserts invariants at five layers with per-family fakes, which forced
a host-wide test-rationing apparatus. The spec's contract ("every op invokable standalone from TS
and via the CLI", "anti-monolith") is met in letter and missed in the default wiring: although
individual pure ops (e.g. `gates.hackDetector`) run directly and governance is optional, the
shipped compositions cannot run without the driver factory, the registry's directory scan and
the self-host layer being importable. The signer and crq remain deployed in the live environment;
backwards compatibility is not a constraint (owner, 2026-10-16).

## Decision

1. **Layer rule, enforced by lint:** dependency arrows point from importer to dependency:
   `@cq/ops → @cq/policy`; `@cq/adapters → @cq/ops` (adapters implement ops-owned ports);
   `@cq/agent-runtime → @cq/ops, @cq/policy`; `@cq/github-app → @cq/policy, @cq/adapters`;
   `@cq/cli → @cq/github-app, @cq/adapters, @cq/agent-runtime, @cq/ops, @cq/policy`. Private
   apps/workspaces assemble above these packages. Policy never imports I/O, a driver or a forge.
   Ops never spawn, read `process.env` or construct drivers; they receive explicit deps. Start
   with six publishable packages (`policy`, `ops`, `adapters`, `agent-runtime`, `github-app`,
   `cli`); split further only on concrete dependency-isolation pressure.
2. **`@cq/ops` is the adopter entry point; `@cq/policy` is its pure foundation.** Pure functions and data (presets with `extends`,
   prompts as `.md` files, decision tables, doctrine) with per-domain subpath entries. "Just the
   smarts" for an address-review cycle is `@cq/policy/review` + `@cq/ops/review` with fakes.
3. **One typed `Forge` port (GitHub implementation) and one `Git` adapter**, each shipping its
   fake from a `./testing` subpath. `@cq/testing` publishes the fake forge, fake git, scripted
   fake driver and virtual clock.
4. **Three driver lanes**, each its own package with optional vendor peers: `driver-ai-sdk`
   (first-party, in-process, toolkit harness), `driver-claude-code` (CLI primary, Agent SDK
   optional), `driver-acp` (on `@agentclientprotocol/sdk`, endpoint profiles; carries codex via
   `codex-acp`). Cost is computed once at the worker boundary from `@cq/policy/pricing` data.
   A shared `driver-core` is a later boundary.
   `@ai-sdk/harness` (`HarnessV1`) is not adopted as the seam (P5: sandbox-mandatory, upstream-
   pinned vendor versions, no cost normalisation, patch-level breaking changes); its data shapes
   are copied, and a gated `HarnessV1Lane` may be added later for runtimes the toolkit will not
   hand-write.
5. **The kernel is a plan interpreter plus journal plus budget _mechanism_.** Governance _policy_
   (opt-ins, advisory refusal, lane classes) is injected from `@cq/policy/budget`. Reservations
   and honest stop stay. Rescue and the approval-token-as-prerequisite for trusted local
   mutation are removed; an approval _capability_ callback replaces the latter, with a signed
   verifier only for unattended services. The contract revision in Phase 1.8 must decide whether
   lane classification remains keyed by `(lane, provider, model)` so HARD can bind, or whether
   the class is removed and recorded explicitly in `reservation-opened`. Until then,
   `classifyDispatch`, the lane table and the `hard`/`advisory` types remain live; Phase 0 does
   not remove them.
6. **The sandbox is the container.** `images/worker` ships the runtime; seatbelt/bwrap launchers
   leave the core for `experimental/` and their positive-control assertions re-home to the image.
   The harness keeps env scrub, shell-free git argv, process-group kill and bounded output, and
   exposes structured read tools instead of a nine-spelling command grammar.
7. **GitHub identity is a package.** `@cq/github-app` owns the roles manifest, token minting,
   trust-set acceptance, promotion-reviewer pin + predicate (single implementation), check-run
   posting, settings-as-code apply + drift. `@cq/workflows` generates YAML from a typed spec;
   decisions move into `cq` subcommands; templates carry ≤40 inline bash lines.
8. **crq is rewritten in TypeScript, signer included** (owner ruling ADR-0005-D-H): smarts in
   `@cq/policy`/`@cq/ops` subpaths (later `@cq/review-queue`), daemons as `apps/queue-runner` and
   `apps/promotion-signer`. The signer's custody model is unchanged (dedicated user, root-owned
   pinned install, forced-command spool, re-deriving verifier). Before cutover, install the TS
   signer from a hash-pinned packed artifact and re-run the signer S2 evidence: custody and modes,
   install-grant and scratch-creator readback, transport-negative and spool round-trip checks,
   policy-data consumption, restart recovery, and pre/post runtime-artifact hashes; re-record the
   attestation. Characterize the live ceres source and shadow the TS signer while Python remains
   the sole issuer. Keep frozen paths in place until the TS signer reads `@cq/policy/queue`; retire
   Python only after the TS signer posts real `crq/promotion-review` statuses under observation.
   The owner schedules the cutover, including drain and rollback.
9. **cq-fixtures becomes `packages/eval`** in the workspace, keeping a public-surface boundary
   test (revises the spec's two-repo decision).
10. **The blanket type freeze and migration-PR rule are retired**; persisted and wire schemas
    (journal, plan JSON, CLI output) are versioned now, and one coherent contract revision
    (`OpContext`, `spend`, outcome algebra, journal events) lands with producers and consumers
    together. The `test:narrow` local test command remains until the `ops` package cut lands;
    per-package test suites replace it then. CI remains the full-suite authority; host admission
    (`heavy-lock`) stays until a fleet-level replacement exists.
11. **Documentation:** a ≤8-document canonical set declared in `docs/README.md`; post-acceptance
    notes folded into ADR text; process identifiers (other than I1–I11) removed from product
    surfaces; history archived.

## Owner rulings this ADR amends

D8 (`resolveConfig` kept internal) → replaced; ADR-0002 Annex B → superseded (carrying the
2026-10-11 `_URL` ruling); the kernel freeze rule → retired; the spec's two-repo decision →
revised (`packages/eval`); D7/D7b → preserved (container backend kept as the image seed, seatbelt
moved not deleted); the 2026-10-11 local-testing policy → unchanged until the `ops` cut, then
per-package suites with host admission retained; D11 protected paths → kept, regexes move in
lockstep under D-P.

D-J: one completed CodeRabbit CLI review cycle, with dispositions for every finding, and an
independent review of the final head are required before merge-readiness; material changes get a
targeted re-review.

## Consequences

- Positive: an adopter can import a decision function with zero infrastructure; tests become
  per-package and parallel; every policy decision exists once; the three CLI lanes become
  reachable and live-testable; the self-host deployment becomes one supported consumer rather
  than the shape of the library.
- Negative: 300–350 file touches; a period where two package layouts coexist unless Phase 1 (in
  place) completes before Phase 2 cuts; the owner's 2026-10-11 local-testing policy must be
  re-stated for per-package suites; crq's rewrite is a real project with a fresh evidence cycle.
- Risks: `@ai-sdk/harness` / ACP / pi churn (mitigated: the seam stays ours, lanes are adapters);
  over-splitting (mitigated by starting with the six packages above. If later isolation pressure
  justifies Shape L, fold `store` into `git`, `pricing` into `kernel`, `driver-core` and `harness`
  into `runtime`, `workflows` into `github-app`, and `review-queue` into `ops/queue`; these are
  candidates, not additional Phase 0 packages).

## Alternatives considered

- Subpath exports inside the single package: improves API shape, does not isolate dependencies,
  does not fix the registry scan or the test topology. Rejected as insufficient.
- Cut packages immediately without breaking edges first: cycles become package-resolution
  failures; rejected (L1 trade-off table).
- Adopt pi agent core as the in-process substrate: rejected on structured-output gap and unsafe
  unattended bash tool (P4); borrow its cost tiers and hook shapes instead.
- Adopt `@ai-sdk/harness` as the seam: rejected (P5), shapes copied.
- pi-durable for wait/resume: watch; one bounded spike on the review loop (P6).
