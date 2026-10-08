# Review-debt disposition preparation — #241, #242 (PR #238 round 3)

Status: explicit owned follow-up **preparation** by the R lane, recorded
2026-10-02 at release-branch head with #238 integrated (queue tip
`70de728`). Both issues are the explicitly owned issues for their findings;
per doctrine no thread closes without a fixing SHA, so nothing here closes
them. No shared-seam file was written in this engagement, and no test was
run or added: B08 holds the host Vitest slot, and test additions wait for
the conductor's head-bound slot grant.

**Rechecked 2026-10-08** at `merge-queue` `4cf42d5`. Both issues are still
open, and every source and test anchor cited below is unchanged
(`src/driver/schema.ts:155` still accepts any finite `retryAfterMs`). The
slot and file-ownership constraints in the last section describe the
2026-10-02 coordination state. Test selection now follows the
[focused-checks contract](../focused-checks-contract.md).

## #241 — round-3 low findings follow-ups (head `0027bc5`)

| #       | Finding                                                                    | Classification                          | Notes                                                                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 241-1   | Pin I8 precedence (aborted beats schema fault) with one assertion per lane | Bounded, test-only                      | `test/driver/*` conformance additions (ai-sdk ≈:363, claude-agent ≈:472, subprocess ≈:534 per the issue). Slot-blocked; seam-family test files.                                                                                                                                                                                                  |
| 241-2   | Compile invocation schema once on the success path (`compileOutputSchema`) | Bounded, internal source refactor       | Reshapes `compileOutputSchemaFault` (`src/driver/common/structured.ts:203`) for reuse by `validateStructured`. **Not barrel-exported** (the barrel exposes only `toOutputSchema`/`validateStructured`), so no packed-declaration change expected. Still a shared driver-family source file → awaits seam-owner handoff, then independent review. |
| 241-3   | Derive served-model matrix `lanes` from `LANE_IDS`                         | Bounded, test-only                      | `test/driver/served-model.test.ts:43`. Slot-blocked.                                                                                                                                                                                                                                                                                             |
| 241-rej | Fixture hit order (rejected upstream)                                      | Dispositioned — rejected with mechanism | Both scanners end in `return hits.sort()`, so asserted arrays are enumeration-order-independent. No action.                                                                                                                                                                                                                                      |

## #242 — reject negative `retryAfterMs` in the WorkerResult mirror

Fix as specified: `retryAfterMs: z.number().nonnegative().exactOptional()`
(`src/driver/schema.ts:155`) plus a `failsParse` case beside the
window-bounds test in `test/kernel/types.test.ts`.

Producer sweep (read-only, this engagement, at `70de728` content): every
first-party producer already emits nonnegative values —

- ai-sdk `retryAfterMsFromValue` (`src/driver/ai-sdk/index.ts:1599`):
  delay-seconds form matches `\d+` only; HTTP-date form is floored with
  `Math.max(0, at - Date.now())`.
- claude-agent `retryAfterMsFromText` (`src/driver/claude-agent/index.ts:1525`):
  captures `\d+` seconds only.
- acp, subprocess and harness: no `retryAfterMs` producer exists.

Classification: **bounded fix, no producer-side dependency, no
declaration-surface change expected** (declared type stays `number`).
`schema.ts` is seam-family → the write itself waits for the seam owner;
`conformance.ts:734-736` currently asserts finite-only, and may be widened
to nonnegative in the same change if its owner agrees.

## Dependencies that gate execution (both issues)

1. **Host Vitest slot** — every test addition needs the conductor's
   explicit head-bound grant; B08 owns the slot now.
2. **Seam-family file ownership** — `src/driver/schema.ts`,
   `src/driver/common/structured.ts`, `test/driver/*`,
   `test/kernel/types.test.ts` are shared post-#238 surfaces; per the
   standing instruction there are **no shared-seam writes** in this
   engagement.
3. **Independent non-author review** at the fixing head — author
   self-approval is not acceptance; the fixes join the normal
   checkpoint/CLI/review pipeline for their owning lane, and the final API
   baseline is generated only after they land (baseline must postdate all
   source changes on the release candidate).
