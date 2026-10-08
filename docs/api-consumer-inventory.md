# W3.1 tooling and packed-consumer dependency inventory

Status: preparation only, recorded 2026-10-02 on the preserved API-tooling
branch `codex/w3-1-api-report-tooling` (head `b780c0a`, clean, based on
`merge-queue` `dd247ca`). This inventory deliberately does **not** finalize
exports, the root barrel, or the API baseline: per the completion plan the
final report is generated only after the J/INV/P/CFG/FG public consumers
are stable, and the package/lock lease is not with this lane. No test run,
no build, and no baseline were executed here (the host Vitest slot is held
elsewhere and this engagement runs no tests at all).

## Preserved tooling state (`b780c0a`)

Three commits on top of `dd247ca`, no other files touched:

| File                       | What it provides                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/api-report.mjs`   | `--draft` report over `package.json` `exports` + reachable declaration graph (SHA-256 per file), fail-closed on symlinks/escapes; baseline-compare mode fails when `baselines/api-report.json` is absent. Node builtins only — no npm dependency added, no lockfile touch. |
| `test/api-report.test.mjs` | Vitest coverage for determinism, graph scoping, unsafe-target refusal, draft markers.                                                                                                                                                                                      |
| `docs/api-report.md`       | Draft-state contract: `"draft": true`, `"baselineStatus": "not-established"`; baseline deferred until S/J/INV/P/CFG/FG integrations land.                                                                                                                                  |

Tooling inputs and their current state on this branch:

- `package.json` `exports`: **root-only** (`.` → `./dist/index.js`);
  version metadata is `1.0.1` here because the 0.2 metadata commit
  (`ee05478`) lives on the release preparation branch, not on the queue.
  Never reconcile by mixing branches: the package/lock/0.2 metadata
  reconciliation happens at the API handoff on the release candidate.
- Build outputs: the report requires `pnpm run build` first; `dist/` was not
  built in this engagement.
- Declaration reachability: the graph walks `.d.ts`/`.d.mts`/`.d.cts`
  relative imports only; external package imports are out of scope by
  design.

## Consumers that must stabilize before final exports/barrel/baseline

The wave-2 gate ("API exports/report after all seam consumers") binds the
final baseline to these lanes:

| Consumer         | Public surface it owns                           | State relevant to W3.1                                                                                                                                 |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S (#238, merged) | Seam v2 types, DriverFactory, conformance        | Landed on queue `70de728`; **this branch must normal-merge the queue** before any report regeneration — `dd247ca` predates the entire seam v2 surface. |
| J (W2.2/W2.4)    | Governed `runPlan`, journal/reservation surfaces | #235/#236 merged; W2.4 gaps owned by J. Changes here shift `dist/kernel` declarations.                                                                 |
| INV (W3.2/W2.5)  | `invokeOp`/direct CLI governed invocation        | Not started; depends on J. Expected to add public surface → new subpath/export decisions land with INV.                                                |
| P (W2.6/W3.5)    | Pricing normalizer, provider admission helpers   | B09 preparation; runner integration via J handoff. Pricing exports (`computeCostUSD`, `priceOf`) already public.                                       |
| CFG (W3.6)       | Config resolver/schema, sandbox entry point      | B10 preparation; unset-env relaxation removal is a behavior change with declared-surface impact.                                                       |
| FG (slice F)     | Fixtures governance contract over `runPlan`      | B13 design done separately; implementation pending. Primarily consumes; direct surface impact unlikely but gated anyway.                               |

Subpath decisions (RS-7) cannot be finalized while INV/COMP may still add
entrypoints: today's root-only map is a placeholder, not a decision.

## Packed-tarball consumer requirements still open (W3.1 integration)

These are the gaps between the preserved tooling and the full W3.1 row;
none is started here, by design:

1. **Subpath exports** per RS-7 — expand `package.json` `exports` from
   root-only once the consumer set above is stable; private internals
   (everything not in the export map) must stay unpacked/unreachable.
2. **No vitest runtime import** in shipped `dist/` and declarations —
   needs a packed-tarball audit step, not just the report.
3. **Consumer packed-tarball smoke**: install the actual `.tgz` into an
   empty consumer, exercise the root and every declared subpath plus both
   bins, with the optional peer absent and present.
4. **CI report-drift wiring** — the compare mode joins CI only after the
   baseline exists; a package script (`pnpm run api:report` or equivalent)
   is also still unwired deliberately.
5. **Final baseline generation** — last, on the promoted release candidate,
   after every source change below is landed, then reviewed in a separate
   change.

## Review-debt interaction (#241/#242, prepared separately by R)

Both open #238 follow-ups are classified as **bounded, non-surface
changes**, and both must land before the final baseline anyway (the
baseline must postdate all source changes on the candidate):

- #241(2) compile-once schema refactor is internal to the driver family —
  `compileOutputSchemaFault` is not barrel-exported (the barrel exposes
  only `toOutputSchema`/`validateStructured`), so no declaration-surface
  change is expected.
- #242 `retryAfterMs` nonnegative tightening keeps the declared type
  `number` and every first-party producer already emits nonnegative values
  (ai-sdk `\d+` delay-seconds and `Math.max(0, …)` HTTP-date floor;
  claude-agent `\d+` text capture; subprocess emits none), so no
  declaration-surface change is expected either.

Full disposition and blockers live in the R lane's
`docs/release-evidence/review-debt-disposition-241-242.md` on the release
preparation branch.

## Required follow-up sequence (owned, not started here)

1. Normal-merge `origin/merge-queue` (≥ `70de728`) into this branch — no
   rebase/force — before any further tooling work; re-verify the report
   against the seam v2 declaration tree.
2. After J/INV/P/CFG/FG stabilize: expand exports/subpaths, add consumer
   smoke fixtures, wire the package script + CI drift check.
3. At release-candidate freeze: generate the baseline (separate reviewed
   change), then hand the package/lock lease to R for 0.2 metadata.
