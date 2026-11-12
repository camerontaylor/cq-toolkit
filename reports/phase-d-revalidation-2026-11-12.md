# Phase D conformance revalidation: issues #1186-1195, #1197-1199

Read-only inventory. Verified against **origin/main = `039697dd0a9d5b29ff5ede7b4c40258ba70a7c6b`**
(merge of PR #1548), fetched 2026-11-12. Every pinned reference below was re-checked by direct
blob reads of `origin/main:<path>`; line numbers are exact at that head unless marked DRIFT.
No source was edited and no issue state was changed. Issue bodies quoted/paraphrased from
GitHub; none of the 13 issues has any comment.

Verdicts: **OPEN** = evidence holds at the pinned semantics (line drift noted where hunks
moved); **STALE-FIXED** = the premise is gone from main; **PARTIALLY FIXED** = part of the
issue landed, the core gap remains.

| Issue                                                    | Verdict           | Owner lane        | Size | Group        |
| -------------------------------------------------------- | ----------------- | ----------------- | ---- | ------------ |
| #1186 review.address ownership store bound               | STALE-FIXED       | review            | M    | none (close) |
| #1187 dev denylist exit-0 unreadable report fail-open    | OPEN              | dev               | S    | G1           |
| #1188 non-`.snap` files under `__snapshots__/` editable  | OPEN              | gates/sweep       | S    | G2           |
| #1189 negative usage on driver rejection enlarges budget | OPEN              | dev               | S    | G1           |
| #1190 cq.json read faults swallowed                      | OPEN (site drift) | dev/pr            | S    | G3           |
| #1191 ratchet canonical baseline TOCTOU                  | OPEN              | ratchet           | S    | G4           |
| #1192 no-vendor-sdk-in-kernel silent on computed source  | OPEN (latent)     | lint              | S    | G5           |
| #1193 merge resolver pushes without scan-before-push     | OPEN              | merge             | M    | G6           |
| #1194 cancellation settlement throws on ordinary repos   | OPEN (line drift) | review            | S    | G7           |
| #1195 CLI/analyze/sweep spend-on-throw residue           | OPEN              | cli/analyze/sweep | S-M  | G8           |
| #1197 sessionsDir inside workspace accepted              | OPEN              | driver            | XS   | G9           |
| #1198 expectation changes not reported as oracle dispute | OPEN              | fix/sweep         | M    | G10          |
| #1199 dispatch log records not shape-checked             | PARTIALLY FIXED   | review/adapters   | XS   | G11          |

---

## 1. #1186 — STALE-FIXED: the caller/store premise no longer exists on main

**The claim (2026-11-10, pinned at `b320dcc0`):** every `review.address` run takes ownership
through an append-only per-repository store in the git common dir
(`src/ops/review/internal/addressOwnership.ts`), `MAX_RECORDS = 64` at `:37`, refusal
"address ownership: bound reached; attended compaction required" at `:46`, `bounded()` throws
at `:402/:429/:543`, quarantine markers make the refusal permanent, ~21 single-PR runs fill
the store. Every `review.address` run was the caller (`src/ops/review/address.ts:3344`
`return await runOwned();`).

**What main looks like now:**

- Commit **`78dba3cdd` 2026-11-10 "refactor(review): Remove durable ownership store and
  legacy registry"** deletes `src/ops/review/internal/addressOwnership.ts` (-1158 lines) and
  the pinned bounds test `test/ops/review/addressManyWorktree.authorityBounds.test.ts`
  (-451 lines), plus `addressManyWorktree.authorityMigration/-StoreDamage/-ownershipRotation/-ownershipGuardDamage` tests.
- `src/ops/review/internal/addressOwnership.ts` **does not exist at `039697dd0`**. Repo-wide
  grep finds no `cq-review-address-ownership`, no `MAX_RECORDS`, no "attended compaction
  required", no quarantine marker writer. The pinned bounds test file is missing from main's tree.
- `src/ops/review/address.ts` retains ownership vocabulary but no store: ownership-guard
  refusal prose at `:1083-1085` ("a run refused before it holds ownership (admission/active-guard
  refusal)"), observation failure reason "observation: ownership not held" at `:1102`. The
  `runOwned()` call the issue cites at `:3344` is gone (file shrank; that region is now gate/stop logic).
- Replacement coordination: `src/ops/review/internal/addressCheckoutOwnership.ts` +
  `src/adapters/lock/slotLock.ts` (advisory flock slots, "Never unlink these lock files...",
  `SlotBusyError`/`IncompleteSlotError`), with a documented attended recovery:
  `scripts/recover-review-checkout.mjs` (+183) and `docs/review-address-checkout-recovery.md` (+50),
  and legacy-store migration support in `src/adapters/git/legacyReviewRegistry.ts` (+84).
  The bounded-terminal residue that remains is in `addressEvidence.ts` ("terminal receipt
  bound reached" `:605`, `:733`; per-session, unrelated to the old cross-run store).

**Callers of the old API today:** none; only test imports of the _new_ module
`addressRunLifecycle.js` (`test/ops/review/addressWorker.terminalCapture.test.ts:4`).

**Consequence:** the issue's proposed fix (base-record generational compaction inside the
store) designs machinery that no longer exists. Recommend **close as fixed-by-removal**
(parent decision). If any residue deserves a new issue, candidates are: (a) attended recovery
for the new slot locks is documented but the recovery UX is a script, not an op; (b) the
`addressEvidence.ts` terminal bounds are per-session by design. Neither recreates #1186's
cross-run store failure mode. The area was actively reworked (address.ts last touched by
merge `62ee234cf` "Merge origin/main into ownership redesign"), not forgotten.

---

## 2. OPEN issues with exact current evidence

### #1187 — dev denylist: exit 0 with missing/unparseable report treated as clean (OPEN)

- `src/ops/dev/denylist.ts:424-429` (was `:418-428` at pin):
  ```ts
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    if (result.exitCode === 1) {
      throw new Error('gitleaks reported findings but wrote an unreadable report — the upload is refused');
    }
    report = [];
  }
  ```
  Exit 0 + unreadable/missing report → empty finding list → upload proceeds.
- `:418-421` throws only for exit codes other than 0/1 (including `null` = killed).
- `timedOut` is declared on the run-command type at `:367` and read nowhere in the decision path.
- `:479` `if (result.exitCode === 1 && report.length === 0)` is a separate exit-1 empty-report check; the fail-open hole is the exit-0 catch above.
- File's only change since the pin is `f7c259c11` 2026-11-11 (fail-closed work elsewhere in the same file; the catch is untouched).
- Proposed fix (from issue, still valid): in the catch, throw on every exit code; add a `timedOut` check before parsing; count unmapped rows in the diagnostic instead of silently dropping.
- Tests: `test/ops/dev/denylist.test.ts`.

### #1188 — non-`.snap` files under `__snapshots__/` editable when protectTests is false (OPEN)

- `src/ops/gates/protectedPaths.ts:112-115` (exact):
  ```ts
  export function isProtectedConfigPath(path: string): boolean {
    return (
      PROTECTED_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(path)) || /\.snap$/i.test(path)
    );
  }
  ```
- `__snapshots__` appears only in the test-root pattern at `:7` (protected only when `protectTests`).
- `src/ops/sweep/stagePaths.ts:36` (exact): `protectTests ? isProtectedStagePath(path) : isProtectedConfigPath(path)`.
- Defaults: `src/ops/fix/registry.ts:39` `protectTests: z.boolean().default(false)`;
  `src/ops/review/addressWorker.ts:1700` (was `:1676` at pin) `protectTests: false`.
  So `fix.run` and `review.address` default to config-only protection.
- Note `protectedPaths.ts:100-101` — `PROTECTED_STAGE_PATH_PATTERNS` ends with `...PROTECTED_CONFIG_PATH_PATTERNS, /\.snap$/i`; the proposed fix adds `/(?:^|\/)__snapshots__\//i` to the config snapshot branch (`:112-115`), not the stage set.
- Tests: `test/ops/gates/protectedPaths.patternLiveness.test.ts` (currently `.snap`-only at the analogous spot).

### #1189 — negative usage on driver rejection enlarges the budget (OPEN)

- `src/ops/dev/cycle.ts:1497-1520` `usageOf(err)`: type-checks only (`typeof input !== 'number' || ...`); accepts negative and non-safe-integer values; **also note: a `reasoning` key present with all four required fields undefined passes and yields `NaN` arithmetic downstream** (add to the fix's test matrix).
- Metering: `:1440` `partial = usageOf(err);` fed to metering; spend at `:1432` `if (Number.isFinite(total)) spend(total);`; `spentTokens` accumulated at `:450`, remaining at `:599` `runMaxTokens - spentTokens`. A `{input:-100, output:0, cacheRead:0, cacheWrite:0}` rejection lowers `spentTokens` and enlarges the allowance.
- Success path already validates: `src/shared/knownUsage.ts:60-69` `validTokens` = `Number.isSafeInteger(value) && value >= 0` — but it is module-private (not exported), so the fix either exports it or re-declares the same predicate.
- Unchanged since the pin except hunk drift (usageOf moved `:1474` → `:1497`).
- Tests: `test/ops/dev/cycle-budget.test.ts` (plus `cycle-controls.test.ts` nearby).

### #1190 — cq.json read faults swallowed at 8 sites (OPEN, SITE DRIFT — re-pin before fixing)

The `.catch(() => null)` pattern on `cq.json` now has **8** cq.json sites (issue said 7; the set moved):

1. `src/ops/pr/open.ts:282` (unchanged from pin)
2. `src/ops/dev/check.ts:452` (was `:407`)
3. `src/ops/dev/cycle.ts:537` (was `:523`)
4. `src/ops/dev/denylist.ts:535` — **new since the pin** (`checkScannerFor`, falls back to no repo-specific scanner)
5. `src/ops/dev/registry.ts:266` (was `:220/295/383` — the registry consolidated; one site remains, in the reviewer-effects wiring)
6. `src/ops/dev/agentReview.ts:43` — indirect via injected `deps.readFile(...).catch(() => null)`, maps null to needs-human "agent reviewer requires cq.json" (`:45-46`)
7. `src/ops/review/run.ts:144` — **new since the pin**; null → `needs-human` "cq.json is required" (`:146-147`), so a read fault is already non-silent here; only the errno distinction is missing
8. `src/ops/fix/runFix.ts:238` — **false positive**, it reads `remote.origin.url`, not cq.json; exclude.

**Fixed since the pin:** `src/ops/dev/ready.ts:118-140` now uses the correct form:
ENOENT → null, any other errno → `needs-human` with `faultText(err)`. The issue's claim for ready.ts is stale.

**Correct exemplar (unchanged):** `src/ops/pr/registry.ts:71` `if (code === 'ENOENT') configText = null; else ... refuse publication`.

Proposed fix shape stands: one shared helper (suggested `src/shared/`, e.g. `readCqConfigText(repoRoot)`) returning null on ENOENT and throwing a typed errno error otherwise; swap the 7 real sites; map the throw to needs-human with path + errno. Decide (parent): include `denylist.ts:535` and `review/run.ts:144` in the helper swap or keep the issue's literal site list.

### #1191 — ratchet canonical baseline TOCTOU (OPEN)

- `src/ops/ratchet/verifyRatchet.ts:405-406` resolves once:
  ```ts
  trust = await gitRevParse(input.repo, input.trustRef);
  subject = await gitRevParse(input.repo, input.subject);
  ```
  (pin cited `:383`; hunks shifted, semantics unchanged). `subject` is used for the range/diff/guard (`:413-421` region).
- `:450` (was `:425`): `results.push(await judgeRatchet(def, input, trust, measured));` — passes the **original `input`**, not the resolved subject.
- `judgeRatchet` (`:305`) reads the canonical baseline by the unresolved ref: `:328` `readCanonicalBaseline(input.repo, trust, ...)`, `:330-332` `readCanonicalBaseline(input.repo, input.subject, path, def, 'the subject ref')`.
- Since the pin, `d1ec0c02e` 2026-11-10 added the trust-ref path (the `:328` line) — same class, same one-line fix: pass `{ ...input, subject }` (and consider the same for `trust`, which the issue predates).
- Advisory only; ratchet workflows are disabled. Tests nearby: `test/ops/ratchet/checkRatchet.*.test.ts` family; the issue's injected-git acceptance test has no exact existing file.

### #1192 — no-vendor-sdk-in-kernel silent on computed import source (OPEN, latent)

- `lint/rules/no-vendor-sdk-in-kernel.mjs`: `sourceText()` returns `null` for non-literal/substitution-bearing sources (`:19-26`); `checkSource` does `if (source === null) return;` (`:31-32`). Unchanged since 2026-09-16 (`8444b2689`, Oxlint migration).
- Scope unchanged: `.oxlintrc.json:120-123` `"files": ["src/kernel/**", "src/driver/types.ts"]`.
- Latent: the only dynamic import in scope is the literal `import('proper-lockfile')` (`src/kernel` region — verified at pin; no computed import exists on main today). RuleTester file exists: `lint/rules/no-vendor-sdk-in-kernel.test.ts`.

### #1193 — merge resolver pushes with bash, no pre-upload scan (OPEN)

- `src/ops/merge/resolveConflict.ts:611` (was `:601`): `toolPolicy: { allow: ['read', 'edit', 'bash'], mode: 'allowlist' }`.
- Design comments confirm the agent pushes: `:17` "this agent MUST push the resolved branch over the network"; `:3` file header; `:366` ok value = "the resolved branch was pushed". No scanner/denylist/gitleaks reference in the file.
- Reachable via `merge.resolveConflict` / `merge.runPrs` (registry entries `src/ops/merge/registry.ts:317,394`) with a `modelSpec`.
- Self-host still withholds the stage: `src/selfhost/self-merge-prs.ts:108` `SELFHOST_DISABLES_CONFLICT_RESOLUTION = true`, used at `:618`.
- Exposure is for CLI/SDK callers who enable the stage. Overlap boundary: **#1213** (OPEN, merge lane) is the classifier accepting reviews without a head bound / no P0-P1 parse — different file (`classifyPrs.ts`), different defect. Do not merge the two.

### #1194 — cancellation settlement throws on ordinary repo shapes (OPEN, line drift ~+8..+24)

- `src/ops/review/internal/addressEvidence.ts` `terminalPath()` `:466-480` (was `:456-458` region): refuses `!allowGlob && /[*?\[\]{}]/.test(file)` → `throw new Error('terminal literal file refused')`; also `stat.isFile()` false, `stat.nlink !== 1`, `isSymbolicLink()` → "terminal file refused"; realpath alias check.
- `verify()` tracked-entry loop `:793-797`: regex `^(100644|100755) ...` over `git ls-files --stage`; any other mode → `throw new Error('terminal foreign index entry unsupported')` (`:797`) — symlinks (120000) and gitlinks (160000) included.
- `safeFile` in `src/ops/review/addressWorker.ts:433-449`: `/[*?\[\]{}]/.test(path)` → "finding must name one literal repository-relative file"; `stat.nlink > 1` → "finding must name one ordinary unlinked file" (`:447-448`). Callers throughout `:1257-1755`.
- README promise still present: `src/ops/review/README.md:103-104` — "Git operations use literal pathspecs and path lists use NUL delimiters, retaining pathspec-like names, Unicode, whitespace, newlines".
- The issue's proposed fix (per-mode handling of 120000/160000, `:(literal)` pathspecs, accept `nlink > 1` for foreign files, relax `safeFile` for bracketed paths) maps onto current code unchanged in substance. Note this code now runs under the NEW slot-ownership architecture (#1186's replacement), so the fix should be validated against current admission/cancellation flow.

### #1195 — spend on every exit: thrown-path residues (OPEN)

- Op side attaches usage on throw: `src/ops/review/run.ts:1185-1208` — the fold runs on rejection and rides the `usageSummary` carrier on the error, best-effort (`:1199-1206`), plus ok-result fold at `:1193`. (Pin cited `:1144-1169`; shifted.)
- CLI thrown paths drop it: `src/cli/main.ts` — `'thrown'` reportError calls at `:620-628` (run-plan), `:672-680` (plan subcommand), `:873-879` (op subcommand), `:913-919` (last-resort) pass message-only prose. The result validator at `:788-810` already accepts and schema-checks a `usageSummary` key on ok results (`KnownUsageSummarySchema`), so the machine artifact contract has a validated slot the thrown path never fills.
- `reportError` lives in `src/cli/output.ts:191` — the emitter change lands there.
- analyze: `src/ops/analyze/agenticRemediation.ts:306-312` reports usage via `currentJobContext()?.reportResult(...)` only; terminal verdicts `error` → failed `:314-321`, `budget` → `:328`, `aborted` → indeterminate `:330-334` carry no usage on the result. Standalone (no job context) callers get nothing.
- sweep: `src/ops/sweep/taskLoop.ts` — driver call `:545-592`; `driverThrew` set at `:593`; usage read only after normal return `:597-600` (`attempt.usage = worker.usage`); thrown attempt row writes `usage: undefined` / `requests: null` at `:743-753`. A rejecting driver's usage (if the rejection carries it, validated non-negative like #1189) is dropped.
- Issue point 4 (Sops-analyze.30 codemod/refusal UNSPENT case) was NOT re-verified, per task scope.
- Tests: `test/ops/analyze/agenticRemediation.test.ts`, `test/cli/output-contract.test.ts` + `test/cli/machine-mode-pins.test.ts` (artifact shape), sweep task-loop tests.

### #1197 — sessionsDir accepted inside the bound workspace (OPEN, XS)

- `src/driver/sessions-dir.ts:24-36` `defaultSessionsDir()`: `CQ_SESSIONS_DIR` override used as given; durable XDG default otherwise. No workspace comparison anywhere.
- Callers use it as the fallback for a caller-supplied `sessionsDir`, unchecked: `src/driver/acp/index.ts:907`, `src/driver/ai-sdk/index.ts:693`, `src/driver/claude-code/cli.ts:478`, `src/driver/claude-code/sdk.ts:410` (all `this.sessionsDir ?? defaultSessionsDir()`).
- "never inside the workspace" exists only as comments: `src/driver/ai-sdk/index.ts:77`, `src/driver/acp/index.ts:149-153`. `git grep realpath src/driver` hits comments/README only, no enforcement.
- Fix (unchanged): refuse when `realpath(sessionsDir)` is inside/equal `realpath(workspace)`, in the shared resolver path before any session file is created.

### #1198 — expectation changes not reported as oracle dispute (OPEN, M)

- Tamper kinds have no expectation-change kind: `src/ops/gates/hackDetector.ts:162-170` — `'suppression' | 'deleted-test-file' | 'new-skip-only' | 'removed-test' | 'protected-config' | 'tautological-assertion'`.
- Sweep invokes the detector after the attempt: `src/ops/sweep/taskLoop.ts:1177` (was `:1104-1108` region) `const tamper = await hackDetector({ diff: patch });`. Gate set is `['paths', 'tamper', 'commit']` (`:999`, `:1029`); a non-pass verdict fails the attempt; there is no "report and continue" class.
- Contract text present: `docs/current-contract-and-backlog.md:41` item 10 with the RI4 clarification (oracle-specific finding + current ruling + independent acceptance; "otherwise report the oracle dispute unchanged").
- `git grep -iE "expectation|oracle"` over src finds no implementation. The proposed `expectation-changed` observation (hunk-level before/after on assertion lines, surfaced in attempt + fix-run reports and the review/address renderer) is a new feature; renderer landing spot is the review report rendering (see `src/ops/review/findings.ts` / report paths — renderer file to be chosen by the implementer).
- Tests: `test/ops/gates/hackDetector.*.test.ts` family; `test/ops/fix/validate.test.ts`.

### #1199 — dispatch log shape check (PARTIALLY FIXED; core gap OPEN, XS)

Landed since the pin (`8d35d74c2` 2026-11-07 "write version 1 in the dispatch log and fix-run report"):

- `src/ops/review/replyAndResolve.ts:109` `DISPATCH_RECORD_VERSION = 1`; `DispatchRecord` now carries `version` (`:117-118`).
- `src/adapters/store/dispatchLog.ts` `parseDispatchLine` (`:21-33`): refuses non-object lines and any version other than absent/1; writes carry `version: 1` (`record()` refuses other versions).

Still exactly the issue's remaining hazard:

- `dispatchLog.ts:32` `return { ...(value as Omit<DispatchRecord, 'version'>), version: DISPATCH_RECORD_VERSION };` — a **bare cast after the object check**. A well-formed line with `actionId` renamed to `id` (or missing `actionId`, wrong `kind`, non-string `resultRef`) loads as a valid record. Readers `src/plans/review-loop.ts:1076` (`.map((record) => record.actionId)` — undefined keys never match → **repost**) and `:1873`.
- Remaining fix (from the issue): strict zod schema per line (actionId/kind/resultRef/at), keep `v`-absent-reads-as-1 semantics (already implemented as version-absent → v1), throw on shape mismatch like a mid-file parse error.
- Tests: no dedicated `dispatchLog` test file found on main; coverage presumably in review-loop/responder tests — add a focused test.

---

## 3. Grouped fix boundaries (G1-G11, non-overlapping file sets)

Groups are bounded so parallel workers do not touch the same files. "Tests" lists the
affected/new test files (all `pnpm test:narrow`-eligible named files; no full suite).

### G1 — dev lane, S (issues #1187, #1189; one PR feasible)

- Files: `src/ops/dev/denylist.ts`, `src/ops/dev/cycle.ts` (usageOf + metering only), possibly export from `src/shared/knownUsage.ts`.
- Tests: `test/ops/dev/denylist.test.ts`, `test/ops/dev/cycle-budget.test.ts` (+ `test/ops/dev/cycle-controls.test.ts` if the meter path is exercised).
- Content: #1187 throw-on-unreadable-at-any-exit + `timedOut`; #1189 non-negative per-field validation on the rejection path (reuse `validTokens`; mark usage-partial; NaN edge).
- Dependencies: none. Note `src/shared/knownUsage.ts` is shared — if exported, `knip` triggers (new export), coordinate.

### G2 — gates/sweep, S (issue #1188)

- Files: `src/ops/gates/protectedPaths.ts` (one pattern in `isProtectedConfigPath`), `src/ops/sweep/stagePaths.ts` (test only, no source change expected).
- Tests: `test/ops/gates/protectedPaths.patternLiveness.test.ts` (new case), optionally a stagePaths case.
- Dependencies: none.

### G3 — shared cq.json helper, S (issue #1190)

- Files: new `src/shared/readCqConfigText.ts` (or similar); swaps at `src/ops/pr/open.ts:282`, `src/ops/dev/check.ts:452`, `src/ops/dev/cycle.ts:537`, `src/ops/dev/denylist.ts:535`, `src/ops/dev/registry.ts:266`, `src/ops/dev/agentReview.ts:43`, `src/ops/review/run.ts:144` (errno message only).
- Tests: new helper test + focused cases in `test/ops/dev/agentReview.test.ts` and the ops' existing test files; `pr.open` test.
- Dependencies: touches `cycle.ts` (region `:537`, disjoint from G1's `:1400-1520`) and `denylist.ts` (region `:535`, disjoint from G1's `:410-480`) — safe to parallelize but sequence after G1 merges to keep diffs trivially clean. New file → `knip` triggers.

### G4 — ratchet, XS (issue #1191)

- Files: `src/ops/ratchet/verifyRatchet.ts` (one-line `{ ...input, subject }`; consider trust too).
- Tests: new injected-git test (no exact existing file; family at `test/ops/ratchet/`).
- Dependencies: none.

### G5 — lint, XS (issue #1192)

- Files: `lint/rules/no-vendor-sdk-in-kernel.mjs`, `lint/rules/no-vendor-sdk-in-kernel.test.ts`.
- Tests: RuleTester `computedSource` case; `import('proper-lockfile')` stays clean.
- Dependencies: none (rule file, not src; `knip` not triggered by rule internals).

### G6 — merge lane, M (issue #1193)

- Files: `src/ops/merge/resolveConflict.ts` (resolver pushes; withhold credentials from worker env; scan `base..HEAD` before push; `escalate` on hit). Possibly a scanner plumbing touch in `src/ops/merge/registry.ts` (type imports only).
- Tests: new resolveConflict scan-before-push tests (fixture worker + stub scanner).
- Dependencies: none with #1213 (different file), but coordinate with the merge lane so the two PRs do not both touch merge config plumbing.

### G7 — review lane, S (issue #1194)

- Files: `src/ops/review/internal/addressEvidence.ts` (`terminalPath` `:466-480`, `verify()` `:793-797`), `src/ops/review/addressWorker.ts` (`safeFile` `:433-449`), `src/ops/review/README.md` (`:103-104` reconciliation).
- Tests: new addressManyWorktree cancellation fixture tests (tracked symlink, gitlink, `pages/[id].tsx`, both `core.symlinks` settings); the old bounds/cancellation test family on main is `test/ops/review/addressManyWorktree.cancellation.test.ts` (still present).
- Dependencies: none file-wise, but validate against the NEW slot-ownership architecture (#1186 removal) — cancellation/cleanup flow changed there. Review lane should own this together with any #1186 closure work.

### G8 — CLI/analyze/sweep, S-M (issue #1195)

- Files: `src/cli/output.ts` (reportError `:191` — emit usageSummary when present), `src/cli/main.ts` (pass err through to the four `'thrown'` sites), `src/ops/analyze/agenticRemediation.ts` (standalone result usage on error/budget/aborted), `src/ops/sweep/taskLoop.ts` (read usage off the rejection, validated like #1189).
- Tests: `test/ops/analyze/agenticRemediation.test.ts`, `test/cli/output-contract.test.ts`, `test/cli/machine-mode-pins.test.ts`, sweep task-loop tests (the driver-throw row).
- Dependencies: taskLoop.ts region `:590-600`/`:730-760` is disjoint from G10's `:1177` — parallelizable; sequence G10 after G8 merges if the same worker pool owns both (same sweep file).
- Scope note: issue point 4 (Sops-analyze.30 codemod UNSPENT case) needs its own re-verification at main before folding in — deliberately excluded from the boundary above.

### G9 — driver lane, XS (issue #1197)

- Files: `src/driver/sessions-dir.ts` (shared containment check) — callers at `acp/index.ts:907`, `ai-sdk/index.ts:693`, `claude-code/cli.ts:478`, `claude-code/sdk.ts:410` route through it or take the same guard.
- Tests: new `test/driver/` sessions-dir containment test (inside-workspace refusal, symlink-out acceptance).
- Dependencies: none.

### G10 — fix/sweep feature, M (issue #1198)

- Files: `src/ops/gates/hackDetector.ts` (new finding kind or a parallel detector), `src/ops/sweep/taskLoop.ts` (observation on attempt rows `:1177` region + report plumbing), fix-run report rendering, review/address report renderer (file TBD by implementer), `docs/current-contract-and-backlog.md` untouched (contract already states the requirement).
- Tests: `test/ops/gates/hackDetector.*` new case; task-loop attempt-report test; `test/ops/fix/validate.test.ts`.
- Dependencies: G8 (same file `taskLoop.ts`) — sequence G8 first, or assign G8+G10 to one worker. Largest open surface; the "report and continue" (observation, never a verdict) design must not alter the `['paths','tamper','commit']` failure semantics at `:999/:1029`.

### G11 — adapters, XS (issue #1199 remainder)

- Files: `src/adapters/store/dispatchLog.ts` (zod shape check in `parseDispatchLine` `:21-33`; `DispatchRecord` type import from `src/ops/review/replyAndResolve.ts` — no change expected there).
- Tests: new focused dispatchLog test (renamed-field refusal, legacy unversioned load, `v:2` throw).
- Dependencies: none.

### Closed boundary (no group)

- #1186: recommend parent closes as fixed-by-removal (`78dba3cdd`). If residue is refiled, it lands in the review lane, not a Phase D group.

---

## 4. Overlap boundary with #1212/#1213 (titles only, not duplicated)

- **#1212** (OPEN, pr lane): `pr.open` publishes title/body/dispositions comment without the publication scanner (`src/ops/pr/open.ts:422-455` region at `888a03e7`). Distinct from G3 (G3 changes only the cq.json read at `open.ts:282`). No file conflict beyond the same file at different regions.
- **#1213** (OPEN, merge lane): merge classifier accepts APPROVED/COMMENTED without head bound; no P0/P1 parse on PASS (`src/ops/merge/classifyPrs.ts`). Distinct from G6/#1193 (resolver push-channel capability vs classifier review acceptance). Do not merge the fixes.

## 5. Open questions for the parent

1. #1186: close as fixed-by-removal, or refile the new-architecture residue (attended recovery UX; terminal bounds)?
2. #1199: version half landed (`8d35d74c2`) — downgrade/split the issue, or keep open until the zod shape check lands (G11)?
3. #1190: helper-swap scope — the issue's 7 sites or the re-pinned 8 (adds `denylist.ts:535`, `review/run.ts:144`; drops nothing; `runFix.ts:238` is a false positive)?
4. G8/G10 share `taskLoop.ts` — sequence G8 → G10 or single owner?
5. #1195 point 4 (Sops-analyze.30) needs a fresh re-verification pass before folding into G8.

## Method note

All evidence above was collected with `git show origin/main:<path>` / `git grep <pat> origin/main -- <path>`
at head `039697dd0` and `gh issue view` (bodies, states, comment counts). No working-tree files were
modified; the only local state change is the `git fetch origin main` ref update.
