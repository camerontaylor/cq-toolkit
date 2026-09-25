// Sweep lane (WS-D, goal D4) — the 'sweep.unit' op: the per-package pipeline
// as ONE composition. A unit's stages are a DATAFLOW (worktreeFor's workspace
// feeds the probe's cwd, the baseline FailureSet feeds the gate, the staged
// set feeds both the tamper scan and the commit), and the frozen Job carries
// `input` as static JSON — so, per the merge-prs precedent, the whole
// pipeline is ONE op that composes the atomic ops in memory:
//
//   worktreeFor → baselineProbe → baseline snapshot (run state) → fixer
//   (via the frozen Driver seam) → baselineProbe again → regressionGate →
//   stage → stage-path allowlist → hackDetector → commit → push.
//
// TWO BINDING SURFACES:
//   - makeSweepUnitOp(bindings) — the SDK seam: every effect injected (git,
//     the check runner, the Driver, the pusher). Library consumers inject
//     fakes; the binding knobs are plain data.
//   - bindingsFromDispatch(input) — the registry seam: builds the bindings
//     from the JSON-serializable SweepUnitDispatchInput (the plan job's
//     input), binding the REAL effects input-driven exactly like
//     worktreeFor's registry entry: real subprocess worktree effects, the
//     REAL subprocess driver over the input's driver section (binary,
//     provider/model over a RoutingTable — plain data; keys read from env at
//     dispatch), real probes over subprocessRunCheck, the real git push
//     (args-array `push -u origin <branch>`, inside a git mutex on the
//     run-state dir). LIMITS, honestly: the prompt is a caller TEMPLATE
//     ({package}/{fixer}/{worktree} placeholders; the shipped default is
//     deliberately generic — the toolkit bakes in no vendor prompt), and a
//     custom Driver OBJECT cannot cross the JSON boundary (pass its config:
//     binary + routing table + sessions dir).
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Budget, Driver, ModelSpec, SandboxPolicy, ToolPolicy } from '../../driver/types.js';
import { SubprocessDriver } from '../../driver/subprocess/index.js';
import { withServedModelAssertion } from '../../driver/served-model.js';
import { defaultRoutingTable } from '../../driver/subprocess/routing.js';
import type { RoutingTable } from '../../driver/subprocess/routing.js';
import { SessionStore } from '../../harness/session.js';
import type { AdapterName, CheckCommand, FailureSet, RunCheck } from '../gates/checkRunner.js';
import { subprocessRunCheck } from '../gates/checkRunner.js';
import { makeBaselineProbe } from '../gates/baselineProbe.js';
import type { BaselineProbeInput } from '../gates/baselineProbe.js';
import { hackDetector } from '../gates/hackDetector.js';
import type { TamperFinding } from '../gates/hackDetector.js';
import { isProtectedStagePath, PROTECTED_STAGE_PATTERNS } from '../gates/protectedPaths.js';
import { regressionGate } from '../gates/regressionGate.js';
import type { RegressionReport } from '../gates/regressionGate.js';
import { makeGhRunner } from '../review/gh.js';
import type { GhFn } from '../review/gh.js';
import type { WorkUnit } from './planSweep.js';
import { makeGitMutex } from './gitMutex.js';
import type { GitMutex } from './gitMutex.js';
import { makeSubprocessWorktreeEffects, makeWorktreeFor } from './worktreeFor.js';
import type { Op, OpResult } from '../../kernel/types.js';
import type { SweepWorkspace, WorktreeForInput, WorktreeMutexConfig } from './worktreeFor.js';

// ---------------------------------------------------------------------------
// Naming + run-state derivation
// ---------------------------------------------------------------------------

/** The per-unit branch segments, derived EXACTLY the way worktreeFor derives them. */
export interface SweepUnitSegments {
  /** The work kind segment: the sanitized fixer label. */
  kind: string;
  /** The package slug segment: the sanitized package name. */
  slug: string;
  /** The full branch `<runPrefix>/<kind>/<slug>`. */
  branch: string;
}

/**
 * The ONE branch derivation shared by the sweep plan builder (the assembler's
 * static input) and this op (the worktreeFor input): kind = fixer, slug =
 * package, both NORMALIZED to safe segments — every run of non-alphanumerics
 * folds to a single '-' and leading/trailing dashes trim (so `@scope/pkg`
 * derives `scope-pkg`, not the dispatchable-`-scope-pkg` the old fold
 * produced). Names a normalization cannot rescue (an EMPTY segment, a '..'
 * run, a '.lock' suffix) are refused by the worktreeFor boundary — loudly,
 * at run time; this fold feeds that boundary, it does not replace it.
 * Normalization can COLLIDE distinct packages (`@a/b` and `a.b` both derive
 * `a-b`); the plan builder resolves collisions deterministically (a `-2`
 * suffix in unit order, the planner's job-id idiom) and ships the RESOLVED
 * kind/slug on the enriched unit job (SweepUnitDispatchInput.kind/slug) so
 * the op, the branch, the run-state markers, and the assembler all agree.
 */
export function sweepUnitSegments(
  runPrefix: string,
  unit: Pick<WorkUnit, 'package' | 'fixer'>,
): SweepUnitSegments {
  const kind = normalizedSegment(unit.fixer);
  const slug = normalizedSegment(unit.package);
  return { kind, slug, branch: `${runPrefix}/${kind}/${slug}` };
}

/** Fold every run of non-alphanumerics to one '-', then trim the dashes. */
function normalizedSegment(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * The run-state dir of one sweep run: NESTED under `worktreesDir` as
 * `<worktreesDir>/.cq-state/<sanitized run prefix>` — one gitignore rule
 * (worktreesDir) covers the worktrees AND the state, and the dot-prefixed
 * `.cq-state` sibling of the kind dirs cannot collide with a derived tree
 * (worktreeFor's path-occupant reservation check only tests the exact
 * `<dir>/<kind>/<slug>` paths, and kind/slug must start alphanumeric).
 * Derived deterministically from the config, NEVER inside any worktree. The
 * namespace keeps sequential sweeps with different run prefixes from reading
 * each other's baseline snapshots (a stale baseline would be fabricated
 * evidence, I7). The unit op writes its per-unit records here —
 * `baseline/<kind>/<slug>.json` (never read back; the probe always re-runs)
 * and `committed/<kind>/<slug>.json` (jTPa8: written only by a unit whose
 * fix is on the remote; the assemble leg's source of truth) — so a worktree
 * carries no untracked tool state: a tree's strict-clean is unpolluted by
 * bookkeeping, a reuse is automatically I7-clean, and salvage never sees a
 * completed unit as dirty because of it.
 *
 * COLLISION-RESISTANT (review-debt #175 item 4): the namespace segment is
 * INJECTIVELY encoded, not folded. The old fold mapped `cq/run.one` and
 * `cq/run-one` onto the same `.cq-state/cq/run-one`, so sequential runs
 * overwrote each other's baseline snapshots — fabricated evidence (I7). The
 * encoder keeps `[a-z0-9_-]` verbatim (so `cq/one` and `cq/09-16a` keep
 * their familiar paths) and percent-encodes every other UTF-8 byte as
 * lowercase `%xx` — which neutralises `.`/`..` path segments AND keeps the
 * output case-insensitive-safe: uppercase input is encoded (`Foo` → `%46oo`),
 * so `cq/Foo` and `cq/foo` never share a dir on a case-insensitive
 * filesystem. An EMPTY segment gets a reserved `%empty` marker so `cq//one`
 * cannot collapse onto `cq/one` and a leading empty segment cannot make the
 * joined namespace absolute.
 */
export function sweepRunStateDir(
  repoRoot: string,
  worktreesDir: string,
  runPrefix: string,
): string {
  const namespace = runPrefix
    .split('/')
    .map((segment) => stateNamespaceSegment(segment))
    .join('/');
  return resolve(repoRoot, worktreesDir, '.cq-state', namespace);
}

/**
 * Injective, filesystem-safe encoding of one run-state namespace segment:
 * `[a-z0-9_-]` pass through verbatim and every other UTF-8 byte becomes
 * lowercase `%xx`. Distinct run prefixes therefore ALWAYS derive distinct
 * state dirs (review-debt #175 item 4) — including on a case-insensitive
 * filesystem, because UPPERCASE input is encoded (`Foo` → `%46oo`) and the
 * escape alphabet is lowercase-only, so two outputs can never differ only by
 * case. A literal `%` is itself encoded (`%25`) so the encoding cannot
 * alias. `.` is encoded — which keeps `.`/`..` from ever acting as path
 * segments and keeps the namespace free of dot-files.
 *
 * An EMPTY segment is reserved as `%empty` (CLI r1 major): encoding `''` as
 * `''` let `cq//one` collapse onto `cq/one` when the segments are joined and
 * resolved, and a leading empty segment (`/one`) made the joined namespace
 * ABSOLUTE — escaping the state dir entirely. `%empty` cannot be produced by
 * any non-empty input because the encoder only ever emits `%` as part of a
 * two-hex-digit escape.
 */
function stateNamespaceSegment(raw: string): string {
  if (raw === '') return '%empty';
  let encoded = '';
  for (const byte of Buffer.from(raw, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[a-z0-9_-]/.test(character)) encoded += character;
    else encoded += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return encoded;
}

/** The baseline-snapshot subdir of the run-state dir (sweepRunStateDir-scoped). */
export const SWEEP_RUN_STATE_BASELINE_DIR = 'baseline';

/** The committed-marker subdir of the run-state dir (jTPa8). */
export const SWEEP_RUN_STATE_COMMITTED_DIR = 'committed';

/** The scanned-commit-sha record subdir of the run-state dir (review-debt #174). */
export const SWEEP_RUN_STATE_SCANNED_DIR = 'scanned';

/** The worktreeFor family's default git wall clock (600s), for the unit op's adapter. */
export const DEFAULT_UNIT_GIT_TIMEOUT_MS = 600_000;

/** Compatibility export for the single shared protected-path taxonomy. */
export const DEFAULT_PROTECTED_STAGE_PATTERNS = PROTECTED_STAGE_PATTERNS;

// ---------------------------------------------------------------------------
// The SDK binding surface
// ---------------------------------------------------------------------------

/** Everything one unit's pipeline needs, bound per run by the caller. */
export interface SweepUnitBindings {
  /** Repository the worktrees check out from. */
  repoRoot: string;
  /** Parent dir for worktree checkouts (the worktreeFor seam). */
  worktreesDir: string;
  /** The run's reserved branch prefix. */
  runPrefix: string;
  /** The base the worktrees check out (and the PRs target). */
  base: string;
  /**
   * Run-state dir for this sweep run — where the unit writes its baseline
   * snapshot and its committed marker, OUTSIDE every worktree (a tree
   * carrying untracked state would never be strictly clean: reuse would
   * break and salvage would preserve completed units). Default:
   * sweepRunStateDir(repoRoot, worktreesDir, runPrefix) — derived from the
   * config, namespaced by the sanitized run prefix.
   */
  runStateDir?: string;
  /**
   * RESOLVED branch segments (jTPa1): when the plan builder disambiguated a
   * slug collision, it ships the resolved kind/slug here so the op's branch,
   * worktree derivation, and committed marker agree with the assembler.
   * Absent: derived via sweepUnitSegments.
   */
  segments?: SweepUnitSegments;
  /**
   * Propose-only mode: any non-empty staged set is routed to needs-human
   * before probing or committing. Used by test-fix so workers never publish.
   */
  proposeOnly?: boolean;
  /**
   * The pipeline mode (UC §1 row 3): 'fix' (default) runs the full pipeline;
   * 'prep' = probes only — worktreeFor → baselineProbe → snapshot, no
   * fixer/driver invocation, no gates, no commit, no push, no marker.
   */
  mode?: 'fix' | 'prep';
  /**
   * The git-mutex binding (jVgCc) for the unit's worktree mutations —
   * concurrent sibling units at the caller's concurrency serialize their
   * prune/add/ref sections on ONE lockfile instead of racing. Absent = no
   * mutex (single-unit or caller-serialized runs); the shipped dispatch
   * binding DEFAULTS it to a repo-level lock.
   */
  mutex?: WorktreeMutexConfig;
  /** The probe's wire-format adapter. */
  adapter: AdapterName;
  /** The check execution seam (probes NEVER cache — two calls, two runs, I7). */
  runCheck: RunCheck;
  /** The per-package check command, resolved against the unit's worktree. */
  checkCommand: (unit: WorkUnit, worktreePath: string) => CheckCommand;
  /** The fixer worker, on the frozen Driver seam (vendor-neutral, I1). */
  driver: Driver;
  /** Model identity for the fixer invocation (plain data, never a vendor handle). */
  modelSpec: ModelSpec;
  /** Sessions dir backing the per-unit session record (the workspace IS the worktree). */
  sessionsDir: string;
  /** Tool policy for the fixer invocation; default an 'edit'-only allowlist. */
  toolPolicy?: ToolPolicy;
  /**
   * Sandbox preference for the fixer invocation; default `{level: 'none'}`.
   * PRODUCTION callers should set this (the subprocess driver does not
   * enforce the level itself — it narrows the tool surface and records the
   * unenforced request per run): the binding exists so a deployment can
   * turn it on without touching this composition.
   */
  sandboxPolicy?: SandboxPolicy;
  /**
   * Wall-clock cap for one git subprocess of the unit's worktree adapter;
   * default DEFAULT_UNIT_GIT_TIMEOUT_MS (the worktreeFor family's 600s).
   */
  gitTimeoutMs?: number;
  /** Budget caps for the fixer invocation; default uncapped. */
  budget?: Budget;
  /** The fixer prompt — caller-composed data (the toolkit bakes in no vendor prompt). */
  prompt: (unit: WorkUnit, worktree: SweepWorkspace) => string;
  /** The git transport for the stage, diff, and commit steps. */
  git: GhFn;
  /**
   * The push leg: publish the unit's branch to its remote AFTER a commit
   * (never otherwise — an uncommitted or no-op unit pushes nothing), so the
   * branch exists on the remote before pr.assemblePrs opens its PR. OPTIONAL:
   * absent = local-only run (no push is attempted). A push failure fails the
   * unit — the commit stays local, and a PR for an unpushed branch would be
   * a fabricated deliverable.
   */
  pushBranch?: (repoRoot: string, branch: string) => Promise<void>;
  /**
   * The staged-path allowlist: regex SOURCES (hackDetector's pattern
   * precedent, compiled with `new RegExp`, `g`/`y` stripped) every staged
   * path must match. AFTER staging, any staged path matching none of the
   * patterns fails the unit naming the offenders. The protected-path guard
   * runs even when this optional scope is absent.
   */
  stagePathAllowlist?: { patterns: string[] };
}

/**
 * One unit probe leg, NARROWED to gateable evidence: the probe completed and
 * parsed (verdict clean/failing, a FailureSet present — a bail or an
 * unparseable run never reaches the report, it fails the unit instead).
 */
export interface UnitProbe {
  verdict: 'clean' | 'failing';
  attempts: number;
  failureSet: FailureSet;
}

/**
 * The unit op's report — every stage's evidence, plain JSON. FIX mode sets
 * every field; PREP mode (probes only) stops after the baseline snapshot and
 * reports `mode: 'prep'` with the probe/worktree evidence ONLY — the
 * post-fix fields are omitted (a fabricated empty regression/tamper verdict
 * would claim evidence no scan collected).
 */
export interface SweepUnitReport {
  package: string;
  fixer: string;
  /** The worktree the unit ran in (create or I7 reuse). */
  worktree: SweepWorkspace;
  /** The pipeline mode this unit ran in ('fix' default; 'prep' = probes only). */
  mode: 'fix' | 'prep';
  /** The BEFORE probe (the baseline; never cached — I7). */
  baseline: UnitProbe;
  /** The AFTER probe. Present in 'fix' mode only. */
  final?: UnitProbe;
  /** The regression gate's decision over the two probes. Present in 'fix' mode only. */
  regression?: RegressionReport;
  /** The tamper scan of the STAGED fix (empty = clean). Present in 'fix' mode only. */
  tamperFindings?: TamperFinding[];
  /** true when the fix was committed; false when nothing was staged (an idempotent re-run). Present in 'fix' mode only. */
  committed?: boolean;
  /** The sha of the commit that carried the SCANNED set (review-debt #174:
   * the strand-retry pushes ONLY a commit this op verified — this is the
   * evidence, persisted to the run-state `scanned/` record, that a
   * stranded push is re-publishing a scanned commit and not an unscanned
   * driver-self-commit). Present when `committed` is true. */
  committedSha?: string;
  /** true when the unit's branch was pushed to its remote. Present in 'fix' mode only. */
  pushed?: boolean;
  /** The branch the unit's PR carries (`<runPrefix>/<kind>/<slug>`). */
  prBranch: string;
}

/**
 * The unit fault CLASS carried as a stable `[CLASS]` prefix on every
 * `failed` error — the rescue policy's classification seam (arm-a §4.2
 * step 5, I8: rescue POLICY lives in the plan/runner layer; the op only
 * reports the class).
 */
export type SweepUnitFaultClass = 'probe' | 'infra' | 'regression' | 'tamper' | 'scope' | 'unknown';

/** Retryable classes for the rescue lane (arm-a §4.2 step 5): transient
 * evidence/infrastructure faults. TAMPER findings and SCOPE violations are
 * verdicts about the WORK (never retried — they route to preserve + the
 * failure report). */
export const RETRYABLE_FAULT_CLASSES: readonly SweepUnitFaultClass[] = [
  'probe',
  'infra',
  'regression',
];

/** Classify a unit's failed error text by its `[CLASS]` prefix. */
export function sweepUnitFaultClass(error: string): SweepUnitFaultClass {
  if (error.startsWith('[PROBE]')) return 'probe';
  if (error.startsWith('[INFRA]')) return 'infra';
  if (error.startsWith('[REGRESSION]')) return 'regression';
  if (error.startsWith('[TAMPER]')) return 'tamper';
  if (error.startsWith('[SCOPE]')) return 'scope';
  return 'unknown';
}

/** Prefix a class tag onto a unit fault message (stable, machine-readable). */
function tagged(cls: Exclude<SweepUnitFaultClass, 'unknown'>, message: string): string {
  return `[${cls.toUpperCase()}] ${message}`;
}

/**
 * The 'sweep.unit' op factory: the per-package pipeline as ONE composition —
 * worktreeFor → baselineProbe → baseline snapshot (run state) → fixer (via
 * the Driver seam) → baselineProbe again → regressionGate → stage →
 * stage-path allowlist → hackDetector → commit → push — over the injected
 * SweepUnitBindings. Every stage's fault is a `failed` result naming the
 * stage (no throws across the op seam, no fabricated progress); a REGRESSION
 * verdict, an out-of-scope staged path, or a tamper finding fails the unit
 * WITHOUT committing — the tree stays dirty, salvage preserves it, and no PR
 * is assembled.
 *
 * Pipeline contract, in order:
 *   1. worktreeFor — create or STRICT-clean reuse (the tree never carries
 *      baseline state — it lives in the run-state dir — so a reuse is
 *      automatically clean; the probe below always re-runs, I7). Mutating
 *      sections serialize on the bindings' git mutex when configured (jVgCc).
 *   2. baseline probe — the BEFORE FailureSet; bail/indeterminate is a unit
 *      failure (no trustworthy baseline, no honest gate).
 *   3. the baseline snapshot is written to the run-state dir
 *      (baseline/<kind>/<slug>.json) — caller-visible record, NEVER read
 *      back (the probe always re-runs), never inside the tree.
 *   4. PREP MODE (bindings.mode === 'prep', UC §1 row 3): STOP here — the
 *      unit returns the probe/worktree evidence with no fixer, no gates, no
 *      commit, no push, no marker. Prep's product is the baseline evidence.
 *   5. the fixer — one Driver run in the worktree (the session workspace IS
 *      the tree, I6); a non-'complete' stop reason fails the unit.
 *   6. final probe — the AFTER FailureSet, same verdict guards.
 *   7. regressionGate — tolerate the baseline's failures, block novel ones
 *      (the crown jewel, R2 D5); a regression fails the unit uncommitted.
 *   8. STAGE the fix (`git add -A`, gitignore-respected), then the staged-
 *      path allowlist (BOTH sides of staged renames — jVgCj), then
 *      hackDetector over the STAGED diff — a plain working-tree diff misses
 *      NEW files (untracked until staged), and the scanner must see exactly
 *      the set the commit would publish. An out-of-scope path or a tamper
 *      finding leaves the fix staged but UNCOMMITTED.
 *   9. commit — skipped when nothing is staged (an idempotent re-run's
 *      no-op fixer); commits exactly the scanned set.
 *  10. push — with a push binding and a fresh commit, publish the unit's
 *      branch (`push -u origin <branch>` in the shipped binding); skipped
 *      when nothing was committed or no binding is present. On the
 *      no-commit leg, a branch carrying commits beyond the base is an
 *      earlier run's STRANDED fix — its push is RE-ATTEMPTED (idempotent),
 *      and an unreadable ahead-count fails the unit fail-closed.
 *  11. the committed marker (jTPa8) — written by a unit whose fix is ON
 *      THE REMOTE (pushed): `<runStateDir>/committed/<kind>/<slug>.json`: the
 *      record the assemble leg reads as its source of truth, so a no-change
 *      unit with nothing on the remote never assembles an empty-diff PR.
 *  Every `failed` error carries a stable `[CLASS]` prefix (PROBE, INFRA,
 *  REGRESSION, TAMPER, SCOPE — see sweepUnitFaultClass): the rescue lane's
 *  classification seam.
 *   5. final probe — the AFTER FailureSet, same verdict guards.
 *   6. regressionGate — tolerate the baseline's failures, block novel ones
 *      (the crown jewel, R2 D5); a regression fails the unit uncommitted.
 *   7. STAGE the fix (`git add -A`, gitignore-respected), then the staged-
 *      path allowlist (BOTH sides of staged renames — jVgCj), then
 *      hackDetector over the STAGED diff — a plain working-tree diff misses
 *      NEW files (untracked until staged), and the scanner must see exactly
 *      the set the commit would publish. An out-of-scope path or a tamper
 *      finding leaves the fix staged but UNCOMMITTED.
 *   8. commit — skipped when nothing is staged (an idempotent re-run's
 *      no-op fixer); commits exactly the scanned set.
 *   9. push — with a push binding and a fresh commit, publish the unit's
 *      branch (`push -u origin <branch>` in the shipped binding); skipped
 *      when nothing was committed or no binding is present. On the
 *      no-commit leg, a branch carrying commits beyond the base is an
 *      earlier run's STRANDED fix — its push is RE-ATTEMPTED (idempotent),
 *      and an unreadable ahead-count fails the unit fail-closed.
 *  10. the committed marker (jTPa8) — written by a unit whose fix is ON
 *      THE REMOTE (pushed): `<runStateDir>/committed/<kind>/<slug>.json`: the
 *      record the assemble leg reads as its source of truth, so a no-change
 *      unit with nothing on the remote never assembles an empty-diff PR.
 */
export function makeSweepUnitOp(bindings: SweepUnitBindings): Op<WorkUnit, SweepUnitReport> {
  const probe = makeBaselineProbe(bindings.runCheck);
  const worktreeFor = makeWorktreeFor(
    makeSubprocessWorktreeEffects(bindings.repoRoot, {
      timeoutMs: bindings.gitTimeoutMs ?? DEFAULT_UNIT_GIT_TIMEOUT_MS,
    }),
  );
  return async (unit) => {
    // The RESOLVED segments: the plan builder's collision disambiguation
    // ships kind/slug on the dispatch input (bindings.segments); a unit run
    // without them derives its own (the collision-free default).
    const segments = bindings.segments ?? sweepUnitSegments(bindings.runPrefix, unit);

    // 1–2. The tree, then the BEFORE probe (the tree carries no baseline
    // state — the snapshot lives in the run-state dir — so a reuse arrives
    // strictly clean, and the probe below is always a fresh re-probe, I7).
    const before = await probeLeg(probe, bindings, unit, worktreeFor, 'baseline');
    if (before.worktree === undefined || before.probe === undefined) {
      return { status: 'failed', error: before.fault ?? '(no detail)' };
    }
    const worktree = before.worktree;
    const baseline = before.probe;

    // 3. The baseline snapshot: run-state, outside the tree — written, never
    // read (the probe always re-runs).
    const cacheFault = await writeBaselineSnapshot(bindings, segments, baseline);
    if (cacheFault !== null) return { status: 'failed', error: tagged('infra', cacheFault) };

    // 4. PREP MODE (UC §1 row 3): probes only. The unit returns the
    // baseline/worktree evidence — no fixer, no gates, no commit, no push,
    // no marker. Prep's product IS the evidence.
    if (bindings.mode === 'prep') {
      const prepReport: SweepUnitReport = {
        package: unit.package,
        fixer: unit.fixer,
        mode: 'prep',
        worktree,
        baseline,
        prBranch: segments.branch,
      };
      return { status: 'ok', value: prepReport };
    }

    // 5. The fixer: one Driver run whose workspace IS the worktree (a fresh
    // session record in the caller's sessions dir; the record's messages
    // never touch the tree). The PRE-DRIVER HEAD is pinned first
    // (review-debt #174): a driver that self-commits moves HEAD before the
    // stage gates run, and the staged-diff scan can never see bytes that
    // are already in the tree.
    const preDriverHead = await bindings.git(['-C', worktree.path, 'rev-parse', 'HEAD']);
    if (preDriverHead.code !== 0) {
      return {
        status: 'failed',
        error: tagged(
          'infra',
          `sweep.unit ${unit.package}: git rev-parse HEAD failed — ${preDriverHead.stderr.trim()}`,
        ),
      };
    }
    let stopReason: string;
    let denial: string | undefined;
    try {
      const store = new SessionStore(bindings.sessionsDir);
      const record = await store.create(worktree.path);
      const worker = await bindings.driver.run({
        prompt: bindings.prompt(unit, worktree),
        modelSpec: bindings.modelSpec,
        toolPolicy: bindings.toolPolicy ?? { allow: ['edit'], mode: 'allowlist' },
        sandboxPolicy: bindings.sandboxPolicy ?? { level: 'none' },
        sessionRef: record.sessionId,
        budget: bindings.budget ?? {},
      });
      stopReason = worker.stopReason;
      const first = worker.denials[0];
      if (first !== undefined) denial = `${first.tool}: ${first.reason}`;
    } catch (err) {
      return {
        status: 'failed',
        error: tagged(
          'infra',
          `sweep.unit ${unit.package}: the fixer driver failed — ${messageOf(err)}`,
        ),
      };
    }
    if (stopReason !== 'complete') {
      return {
        status: 'failed',
        error: tagged(
          'infra',
          `sweep.unit ${unit.package}: the fixer worker stopped with reason '${stopReason}'` +
            (denial !== undefined ? ` — ${denial}` : ''),
        ),
      };
    }

    // 6. STAGE the fix, then gate the staged set BEFORE evidence collection:
    // scoped worker can never commit outside its scope), then the tamper
    // scan over the STAGED diff — a plain working-tree diff misses NEW files
    // (untracked until staged), and the scanner must see exactly the set the
    // commit would publish. Either refusal leaves the fix staged but
    // UNCOMMITTED.
    // HEAD must be exactly what the driver was handed (review-debt #174):
    // a driver that self-committed mid-run moved it, and the staged-diff
    // scan is blind to committed bytes — fail TAMPER before staging
    // anything (nothing recorded, nothing pushed; needs-human evidence).
    const preStageHead = await bindings.git(['-C', worktree.path, 'rev-parse', 'HEAD']);
    if (preStageHead.code !== 0) {
      return {
        status: 'failed',
        error: tagged(
          'infra',
          `sweep.unit ${unit.package}: git rev-parse HEAD failed — ${preStageHead.stderr.trim()}`,
        ),
      };
    }
    if (preStageHead.stdout.trim() !== preDriverHead.stdout.trim()) {
      return {
        status: 'failed',
        error: tagged(
          'tamper',
          `sweep.unit ${unit.package}: the worktree HEAD moved during the fixer run (${preDriverHead.stdout.trim()} -> ${preStageHead.stdout.trim()}) — a driver self-commit is not a supported mode and its bytes were never scanned; nothing staged or committed — needs-human evidence`,
        ),
      };
    }
    const staged = await stageUnitFiles(bindings, unit, worktree);
    if (staged !== null) return { status: 'failed', error: tagged('infra', staged) };
    const scope = await enforceStagePathAllowlist(bindings, unit, worktree);
    if (scope !== null) {
      if (scope.kind === 'protected' || scope.kind === 'propose-only') {
        return { status: 'needs-human', reason: scope.message };
      }
      if (scope.kind === 'scope') {
        return { status: 'failed', error: tagged('scope', scope.message) };
      }
      return {
        status: 'failed',
        error: tagged(
          'infra',
          scope.message ?? 'staged path gate returned an invalid clean result',
        ),
      };
    }
    const diff = await bindings.git([
      '-C',
      worktree.path,
      'diff',
      '--cached',
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
    ]);
    if (diff.code !== 0) {
      return {
        status: 'failed',
        error: tagged(
          'infra',
          `sweep.unit ${unit.package}: git diff --cached failed — ${diff.stderr.trim()}`,
        ),
      };
    }
    const hack = await hackDetector({ diff: diff.stdout });
    if (hack.status !== 'ok') {
      return {
        status: 'failed',
        error: tagged(
          'tamper',
          `sweep.unit ${unit.package}: the tamper scan returned ${hack.status} — ${resultDetail(hack)}`,
        ),
      };
    }
    if (hack.value.length > 0) {
      const named = hack.value
        .map((f) => `${f.kind} ${f.file}:${String(f.line ?? '?')} (${f.message})`)
        .join('; ');
      return {
        status: 'failed',
        error: tagged(
          'tamper',
          `sweep.unit ${unit.package}: tamper findings — the fix games the checks: ${named}`,
        ),
      };
    }

    // 7. The AFTER probe runs ONLY over the staged, path-gated tree in a
    // fresh detached checkout. The temporary commit is parented at the exact
    // base the fixer received and never updated by a ref; worktree add gives
    // the check runner a clean tree with only bytes that survived both gates.
    const finalProbe = await withBaseOwnedFinalTree(
      bindings,
      unit,
      worktree,
      preDriverHead.stdout.trim(),
      async (cleanWorktree) => probeLeg(probe, bindings, unit, worktreeFor, 'final', cleanWorktree),
    );
    if (finalProbe.fault !== null) {
      return { status: 'failed', error: finalProbe.fault };
    }
    if (finalProbe.probe === undefined) {
      return { status: 'failed', error: '(final probe returned no evidence)' };
    }
    const final = finalProbe.probe;
    const gated = await regressionGate({
      base: baseline.failureSet,
      final: final.failureSet,
    });
    if (gated.status !== 'ok') {
      return {
        status: 'failed',
        error: tagged(
          'regression',
          `sweep.unit ${unit.package}: the regression gate returned ${gated.status} — ${resultDetail(gated)}`,
        ),
      };
    }
    if (gated.value.verdict === 'regression') {
      const novel = gated.value.novelFailures
        .map((f) => `${f.file ?? '(no file)'}:${String(f.line ?? '?')} ${f.message}`)
        .join('; ');
      const totals = gated.value.totalsRegression;
      return {
        status: 'failed',
        error: tagged(
          'regression',
          `sweep.unit ${unit.package}: REGRESSION — ${totals ?? `the fix introduced ${String(gated.value.novelFailures.length)} novel failure(s): ${novel}`}`,
        ),
      };
    }

    // 8. Commit the scanned set — skipped when nothing is staged (the fixer
    // no-oped; an idempotent re-run). The commit's sha is RECORDED — in the
    // report and in the run-state `scanned/` record — so the strand-retry
    // (9b) can prove any ahead-of-base commit it pushes is THIS op's
    // scanned commit and not an unscanned driver-self-commit (review-debt
    // #174: `git add -A` stages nothing after driver self-commits, so the
    // stage/scan gates never saw those bytes; without the record, 9b would
    // push them as "verified").
    const commit = await commitStaged(bindings, unit, worktree, finalProbe.treeSha);
    if (commit.fault !== null) return { status: 'failed', error: tagged('infra', commit.fault) };
    let committedSha: string | undefined;
    if (commit.committed) {
      const head = await bindings.git(['-C', worktree.path, 'rev-parse', 'HEAD']);
      if (head.code !== 0) {
        return {
          status: 'failed',
          error: tagged(
            'infra',
            `sweep.unit ${unit.package}: git rev-parse HEAD failed — ${head.stderr.trim()}`,
          ),
        };
      }
      committedSha = head.stdout.trim();
      const recordFault = await recordScannedCommitSha(bindings, segments, committedSha);
      if (recordFault !== null) return { status: 'failed', error: tagged('infra', recordFault) };
    }

    // 9. Push the committed branch — only when something was committed and a
    // push binding is present. A push failure fails the unit: the commit
    // stays local and a PR for an unpushed branch would be fabricated.
    let pushed = false;
    if (commit.committed && bindings.pushBranch !== undefined) {
      // PUSH-TIME RE-VERIFICATION (review-debt #174 r1, HIGH 2): the checks
      // above ran earlier; between them and the execve a detached driver
      // process could still commit. Push ONLY the exact scanned commit:
      // tip === committedSha, its parent === the pre-driver HEAD (exactly
      // one commit on top of what the driver was handed), and the committed
      // diff re-scanned clean.
      const recheck = await verifyScannedTip(
        bindings,
        unit,
        worktree.path,
        committedSha as string,
        preDriverHead.stdout.trim(),
      );
      if (recheck !== null) {
        return typeof recheck === 'string'
          ? { status: 'failed', error: recheck }
          : { status: 'needs-human', reason: recheck.message };
      }
      try {
        await bindings.pushBranch(bindings.repoRoot, segments.branch);
        pushed = true;
      } catch (err) {
        return {
          status: 'failed',
          error: tagged(
            'infra',
            `sweep.unit ${unit.package}: git push of '${segments.branch}' failed — ${messageOf(err)} (the commit is local; the branch must exist on the remote before a PR is assembled)`,
          ),
        };
      }
    }

    // 9b. The STRANDED-COMMIT RETRY (resume completeness): on the
    // no-commit leg (this run's fixer no-oped on an already-fixed tree) with
    // a push binding, a branch carrying commits beyond the base is a
    // candidate EARLIER run's verified fix whose push failed — re-attempt
    // the push (idempotent: an up-to-date remote is a no-op). WITHOUT the
    // sha verification this would push ANY driver-self-committed bytes
    // unscanned (review-debt #174), so the retry pushes ONLY when the tip
    // IS the recorded scanned sha (the run-state `scanned/` record the
    // commit step wrote); any other ahead-of-base state — no record, or a
    // tip that diverges from the record — fails the unit TAMPER: needs-
    // human evidence, never a push.
    if (!commit.committed && bindings.pushBranch !== undefined) {
      const counted = await bindings.git([
        '-C',
        worktree.path,
        'rev-list',
        '--count',
        `${bindings.base}..HEAD`,
      ]);
      if (counted.code !== 0) {
        // Fail-closed: an unreadable ahead-count means we cannot know
        // whether a commit is stranded — never silently omit one.
        return {
          status: 'failed',
          error: tagged(
            'infra',
            `sweep.unit ${unit.package}: git rev-list --count failed — ${counted.stderr.trim()}`,
          ),
        };
      }
      const aheadCommits = Number.parseInt(counted.stdout.trim(), 10);
      if (Number.isFinite(aheadCommits) && aheadCommits > 0) {
        if (bindings.runStateDir === undefined) {
          // The derived run-state location sits inside the worktrees dir —
          // within an unsandboxed driver's write reach — so no record there
          // can be trustworthy (review-debt #174 r1, HIGH 1). Fail closed:
          // needs-human, the stranded commit is named evidence.
          return {
            status: 'failed',
            error: tagged(
              'tamper',
              `sweep.unit ${unit.package}: ${String(aheadCommits)} commit(s) ahead of '${bindings.base}' on '${segments.branch}' — stranded pushes require an explicit caller-supplied runStateDir (outside the driver's write reach) so the scanned-commit record can be trusted; this run derived it and cannot — needs-human evidence`,
            ),
          };
        }
        const head = await bindings.git(['-C', worktree.path, 'rev-parse', 'HEAD']);
        if (head.code !== 0) {
          return {
            status: 'failed',
            error: tagged(
              'infra',
              `sweep.unit ${unit.package}: git rev-parse HEAD failed — ${head.stderr.trim()}`,
            ),
          };
        }
        const recorded = await readScannedCommitSha(bindings, segments);
        if (recorded === null || head.stdout.trim() !== recorded) {
          const detail =
            recorded === null
              ? 'no scanned-commit record exists for this unit (an unscanned driver-self-commit, or a record from before this hardening)'
              : `the tip (${head.stdout.trim()}) diverges from the recorded scanned sha (${recorded})`;
          return {
            status: 'failed',
            error: tagged(
              'tamper',
              `sweep.unit ${unit.package}: ${String(aheadCommits)} commit(s) ahead of '${bindings.base}' on '${segments.branch}' are NOT the verified scanned commit — ${detail}; an unscanned commit must not be pushed — needs-human evidence`,
            ),
          };
        }
        // PUSH-TIME RE-VERIFICATION on the retry leg too: the recorded sha
        // must still be the tip (the divergence check above), sit directly
        // on the base, and re-scan clean — the scanned-commit record is the
        // ONLY thing this push is allowed to publish (review-debt #174).
        const retryRecheck = await verifyScannedTip(
          bindings,
          unit,
          worktree.path,
          head.stdout.trim(),
          null,
        );
        if (retryRecheck !== null) {
          return typeof retryRecheck === 'string'
            ? { status: 'failed', error: retryRecheck }
            : { status: 'needs-human', reason: retryRecheck.message };
        }
        try {
          await bindings.pushBranch(bindings.repoRoot, segments.branch);
          pushed = true;
          // The audited fact of WHICH sha was published (r1 review, low 5).
          committedSha = recorded as string;
        } catch (err) {
          return {
            status: 'failed',
            error: tagged(
              'infra',
              `sweep.unit ${unit.package}: git push of stranded commit(s) on '${segments.branch}' failed — ${messageOf(err)}`,
            ),
          };
        }
      }
    }

    // 10. The committed marker (jTPa8) — written by a unit whose fix is ON
    // THE REMOTE (pushed): a fresh commit+push this run, or the stranded-
    // commit retry above. The assemble leg reads these as its source of
    // truth (a no-change unit with nothing on the remote never assembles an
    // empty-diff PR).
    if (pushed) {
      const markerFault = await writeCommittedMarker(bindings, segments, unit);
      if (markerFault !== null) return { status: 'failed', error: tagged('infra', markerFault) };
    }

    const report: SweepUnitReport = {
      package: unit.package,
      fixer: unit.fixer,
      mode: 'fix',
      worktree,
      baseline,
      final,
      regression: gated.value,
      tamperFindings: hack.value,
      committed: commit.committed,
      ...(committedSha !== undefined ? { committedSha } : {}),
      pushed,
      prBranch: segments.branch,
    };
    return { status: 'ok', value: report };
  };
}

/**
 * Materialize the staged index as an unreferenced commit over the pre-driver
 * base and probe it in a fresh detached worktree. The original worker tree is
 * never used as evidence, so ignored files, gitattributes, hooks, and config
 * discovered from that mutable checkout cannot shape the final verdict.
 */
async function withBaseOwnedFinalTree(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
  baseHead: string,
  run: (
    clean: SweepWorkspace,
  ) => Promise<{ worktree?: SweepWorkspace; probe?: UnitProbe; fault?: string }>,
): Promise<{ probe?: UnitProbe; fault: string | null; treeSha?: string }> {
  const tree = await bindings.git(['-C', worktree.path, 'write-tree']);
  if (tree.code !== 0) {
    return {
      fault: tagged(
        'infra',
        `sweep.unit ${unit.package}: git write-tree failed — ${tree.stderr.trim()}`,
      ),
    };
  }
  const commit = await bindings.git([
    '-C',
    worktree.path,
    '-c',
    'user.name=CQ sweep probe',
    '-c',
    'user.email=cq-sweep-probe@invalid',
    'commit-tree',
    tree.stdout.trim(),
    '-p',
    baseHead,
    '-m',
    `sweep.unit ${unit.package}: base-owned final probe`,
  ]);
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit.stdout.trim())) {
    return {
      fault: tagged(
        'infra',
        `sweep.unit ${unit.package}: git commit-tree for the final probe failed — ${commit.stderr.trim() || commit.stdout.trim()}`,
      ),
    };
  }
  const worktreesRoot = resolve(bindings.repoRoot, bindings.worktreesDir);
  await mkdir(worktreesRoot, { recursive: true });
  const tempDir = await mkdtemp(join(worktreesRoot, '.cq-sweep-final-'));
  const cleanPath = join(tempDir, 'checkout');
  try {
    const added = await bindings.git([
      '-C',
      worktree.path,
      'worktree',
      'add',
      '--detach',
      cleanPath,
      commit.stdout.trim(),
    ]);
    if (added.code !== 0) {
      return {
        fault: tagged(
          'infra',
          `sweep.unit ${unit.package}: detached final-probe worktree add failed — ${added.stderr.trim()}`,
        ),
      };
    }
    const result = await run({ ...worktree, path: cleanPath });
    if ('fault' in result && result.fault !== undefined) {
      return { fault: result.fault, treeSha: tree.stdout.trim() };
    }
    return {
      ...(result.probe !== undefined ? { probe: result.probe } : {}),
      fault: null,
      treeSha: tree.stdout.trim(),
    };
  } catch (err) {
    return {
      fault: tagged('infra', `sweep.unit ${unit.package}: final probe crashed — ${messageOf(err)}`),
      treeSha: tree.stdout.trim(),
    };
  } finally {
    await bindings.git(['-C', worktree.path, 'worktree', 'remove', '--force', cleanPath]);
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** One probe leg, creating the worktree on the baseline leg when not in hand yet. */
async function probeLeg(
  probe: ReturnType<typeof makeBaselineProbe>,
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktreeFor: Op<WorktreeForInput, SweepWorkspace>,
  leg: 'baseline' | 'final',
  existing?: SweepWorkspace,
): Promise<{ worktree?: SweepWorkspace; probe?: UnitProbe; fault?: string }> {
  let worktree: SweepWorkspace;
  if (existing !== undefined) {
    worktree = existing;
  } else {
    const result = await callTotal(`sweep.unit ${unit.package}: worktreeFor`, () =>
      worktreeFor(worktreeInputOf(bindings, unit)),
    );
    if (result.status !== 'ok') {
      return {
        fault: tagged('infra', `sweep.unit ${unit.package}: worktreeFor — ${resultDetail(result)}`),
      };
    }
    worktree = result.value;
  }
  const input: BaselineProbeInput = {
    adapter: bindings.adapter,
    command: bindings.checkCommand(unit, worktree.path),
  };
  const probed = await callTotal(`sweep.unit ${unit.package}: the ${leg} probe`, () =>
    probe(input),
  );
  if (probed.status !== 'ok') {
    return {
      worktree,
      fault: tagged(
        'probe',
        `sweep.unit ${unit.package}: the ${leg} probe returned ${probed.status} — ${resultDetail(probed)}`,
      ),
    };
  }
  if (probed.value.verdict === 'bail') {
    return {
      worktree,
      fault: tagged(
        'probe',
        `sweep.unit ${unit.package}: the ${leg} probe BAILED after ${String(probed.value.attempts)} attempt(s) — the check never completed, so there is no trustworthy state to gate on`,
      ),
    };
  }
  if (probed.value.failureSet === undefined) {
    return {
      worktree,
      fault: tagged(
        'probe',
        `sweep.unit ${unit.package}: the ${leg} probe reported ${probed.value.verdict} with no failure set — ungateable evidence`,
      ),
    };
  }
  // NARROWED past the guards: clean/failing with a FailureSet present.
  const narrowed: UnitProbe = {
    verdict: probed.value.verdict,
    attempts: probed.value.attempts,
    failureSet: probed.value.failureSet,
  };
  return { worktree, probe: narrowed };
}

/** The unit's worktreeFor input — the bindings' naming config over the RESOLVED segments. */
function worktreeInputOf(bindings: SweepUnitBindings, unit: WorkUnit): WorktreeForInput {
  const segments = bindings.segments ?? sweepUnitSegments(bindings.runPrefix, unit);
  return {
    repoRoot: bindings.repoRoot,
    worktreesDir: bindings.worktreesDir,
    runPrefix: bindings.runPrefix,
    kind: segments.kind,
    slug: segments.slug,
    base: bindings.base,
    ...(bindings.mutex !== undefined ? { mutex: bindings.mutex } : {}),
  };
}

/**
 * Await an op that must not throw across the seam; a rejection (an effect
 * adapter contract violation) becomes a `failed` result naming the stage —
 * never an escaping rejected promise, never a fabricated ok.
 */
async function callTotal<R>(stage: string, run: () => Promise<OpResult<R>>): Promise<OpResult<R>> {
  try {
    return await run();
  } catch (err) {
    return { status: 'failed', error: `${stage} threw — ${messageOf(err)}` };
  }
}

/**
 * Stage everything the fixer left in the worktree (`git add -A` —
 * gitignore-respected, so tool state is never staged): the scope check, the
 * tamper scan, and the commit must all see the SAME set, and a NEW file the
 * fixer created is untracked until staged. A fault names the stage.
 */
async function stageUnitFiles(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
): Promise<string | null> {
  const added = await bindings.git(['-C', worktree.path, 'add', '-A']);
  if (added.code !== 0) {
    return `sweep.unit ${unit.package}: git add failed — ${added.stderr.trim()}`;
  }
  return null;
}

/**
 * Compile the staged-path allowlist pattern SOURCES (jSKJY) CASE-SENSITIVELY
 * (review-debt #175 item 3): the patterns are built from manifest paths and
 * declared files, which carry the checkout's exact case. The old `i` flag let
 * a case-differing sibling package (`packages/Alpha/x` matching
 * `^packages/alpha/`) stage outside its scope on a case-sensitive checkout.
 * Exported as the case-sensitivity seam; a non-compiling source throws and
 * the caller folds it into a `failed` result.
 */
export function compileStagePathPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => new RegExp(source));
}

/** Typed result of the staged-path policy, never inferred from message text. */
export type StagePathGateResult =
  | { kind: 'clean'; paths: []; message: null }
  | { kind: 'protected'; paths: string[]; message: string }
  | { kind: 'propose-only'; paths: string[]; message: string }
  | { kind: 'scope'; paths: string[]; message: string }
  | { kind: 'infra'; paths: []; message: string };

/**
 * Apply the production staged-path policy to already-enumerated paths. The
 * unit op and tamper corpus call this same decision function.
 */
export function classifyStagePaths(
  staged: readonly string[],
  allowlist?: { patterns: string[] },
  proposeOnly = false,
): StagePathGateResult {
  const protectedPaths = staged.filter(isProtectedStagePath);
  if (protectedPaths.length > 0) {
    return {
      kind: 'protected',
      paths: protectedPaths,
      message: `sweep.unit: protected path(s) changed by a worker — ${protectedPaths.join(', ')} — tests, setup, runner/measurement config, lockfiles, automation, snapshots, and repository policy require needs-human review`,
    };
  }
  if (proposeOnly && staged.length > 0) {
    return {
      kind: 'propose-only',
      paths: [...staged],
      message: `sweep.unit: propose-only worker produced ${String(staged.length)} staged path(s) — ${staged.join(', ')}; nothing will be probed, committed, or pushed without human review`,
    };
  }
  if (allowlist === undefined) return { kind: 'clean', paths: [], message: null };
  let compiled: RegExp[];
  try {
    compiled = compileStagePathPatterns(allowlist.patterns);
  } catch (err) {
    return {
      kind: 'infra',
      paths: [],
      message: `invalid stage-path allowlist pattern — ${messageOf(err)}`,
    };
  }
  const offenders = staged.filter((path) => !compiled.some((regex) => regex.test(path)));
  return offenders.length > 0
    ? {
        kind: 'scope',
        paths: offenders,
        message:
          `staged path(s) outside the allowlist [${allowlist.patterns.join(', ')}] — ` +
          `the worker cannot commit outside its scope: ${offenders.join(', ')}`,
      }
    : { kind: 'clean', paths: [], message: null };
}

/**
 * Enumerate the complete staged set and apply {@link classifyStagePaths}.
 * Both paths of every rename/copy and every deletion are included.
 */
async function enforceStagePathAllowlist(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
): Promise<StagePathGateResult | null> {
  const listed = await bindings.git([
    '-C',
    worktree.path,
    'diff',
    '--cached',
    '--text',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--name-status',
    '-z',
  ]);
  if (listed.code !== 0) {
    return {
      kind: 'infra',
      paths: [],
      message: `sweep.unit ${unit.package}: git diff --cached --name-status failed — ${listed.stderr.trim()}`,
    };
  }
  const verdict = classifyStagePaths(
    stagedPathsOf(listed.stdout),
    bindings.stagePathAllowlist,
    bindings.proposeOnly === true,
  );
  if (verdict.kind === 'clean') return null;
  return {
    ...verdict,
    message: `sweep.unit ${unit.package}: ${verdict.message ?? 'staged path rejected'}`,
  };
}

/**
 * The staged paths of one `diff --cached --name-status -z` capture: records
 * are `<status> NUL <path> [NUL <path2>]` — an R/C (rename/copy) status
 * carries the OLD then the NEW path, and BOTH are scope-checked (the source
 * is the production code a rename deletes); every other status carries one.
 */
function stagedPathsOf(capture: string): string[] {
  const tokens = capture.split('\0').filter((token) => token !== '');
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index] as string;
    index += 1;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < pathCount; n += 1) {
      const path = tokens[index];
      if (path !== undefined) paths.push(path);
      index += 1;
    }
  }
  return paths;
}

/**
 * Commit the ALREADY-STAGED set; skipped honestly when nothing is staged
 * (the fixer no-oped — an idempotent re-run).
 */
async function commitStaged(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
  expectedTreeSha?: string,
): Promise<{ committed: boolean; fault: string | null }> {
  if (expectedTreeSha === undefined) {
    return { committed: false, fault: 'sweep.unit: final probe did not return a tree sha' };
  }
  const empty = await bindings.git([
    '-C',
    worktree.path,
    'diff',
    '--cached',
    '--text',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--quiet',
  ]);
  if (empty.code !== 0 && empty.code !== 1) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: git diff --cached --quiet failed — ${empty.stderr.trim()}`,
    };
  }
  if (empty.code === 0) {
    return { committed: false, fault: null }; // nothing staged — nothing to commit
  }
  const committed = await bindings.git([
    '-C',
    worktree.path,
    'commit',
    '--no-verify',
    '-m',
    `fix(${unit.package}): apply ${unit.fixer} sweep fix`,
  ]);
  if (committed.code !== 0) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: git commit failed — ${committed.stderr.trim()}`,
    };
  }
  const tree = await bindings.git(['-C', worktree.path, 'rev-parse', 'HEAD^{tree}']);
  if (tree.code !== 0 || tree.stdout.trim() !== expectedTreeSha) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: committed tree differs from the probed tree — expected ${expectedTreeSha}, got ${tree.stdout.trim() || tree.stderr.trim()}`,
    };
  }
  return { committed: true, fault: null };
}

/**
 * Write the baseline snapshot to the RUN-STATE dir —
 * `<runStateDir>/baseline/<kind>/<slug>.json`, never inside the worktree (a
 * tree carrying untracked baseline state would never be strictly clean:
 * reuse would break and salvage would preserve completed units). Written,
 * never read back (the probe always re-runs, I7). A fault names the stage.
 */
async function writeBaselineSnapshot(
  bindings: SweepUnitBindings,
  segments: SweepUnitSegments,
  baseline: UnitProbe,
): Promise<string | null> {
  const runStateDir =
    bindings.runStateDir ??
    sweepRunStateDir(bindings.repoRoot, bindings.worktreesDir, bindings.runPrefix);
  const baselineDir = join(runStateDir, SWEEP_RUN_STATE_BASELINE_DIR, segments.kind);
  try {
    await mkdir(baselineDir, { recursive: true });
    await writeFile(
      join(baselineDir, `${segments.slug}.json`),
      `${JSON.stringify(baseline.failureSet ?? null)}\n`,
      'utf8',
    );
    return null;
  } catch (err) {
    return `sweep.unit: could not write the baseline snapshot under '${baselineDir}' — ${messageOf(err)}`;
  }
}

/** Status error/reason/detail of a non-ok OpResult, for `failed` messages. */
function resultDetail(result: {
  status: string;
  error?: string;
  reason?: string;
  detail?: string;
}): string {
  return result.error ?? result.reason ?? result.detail ?? '(no detail)';
}

/** Error message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The registry (dispatch) binding surface — JSON in, real effects out
// ---------------------------------------------------------------------------

/** The shipped default fixer prompt (placeholder-substituted per unit). */
export const DEFAULT_UNIT_PROMPT_TEMPLATE =
  'You are the {fixer} fixer for package "{package}". ' +
  'Work in the checkout at {worktree}: fix the failing checks for that package with the ' +
  "smallest possible edits to the package's own files, then report exactly what changed. " +
  'Never touch anything outside the checkout.';

/** The JSON-serializable Driver binding of a dispatch input (jSKJF). */
export interface SweepUnitDriverConfig {
  /**
   * The agent CLI: a bare command/path or a full leading-argv template
   * (e.g. `['node', '/path/to/agent.mjs']`).
   */
  binary: string | readonly string[];
  /** The routing-table endpoint handle (the frozen ModelSpec.provider). */
  provider: string;
  /** The model id (allowlist-verified against the endpoint at dispatch). */
  model: string;
  /** Sessions dir for the fixer workers' records; default the driver's own tmp default. */
  sessionsDir?: string;
  /**
   * The routing table (PLAIN DATA — JSON-serializable); default
   * defaultRoutingTable(). Endpoint auth VALUES are never carried here:
   * the driver reads each endpoint's key from its env var at dispatch.
   */
  routingTable?: RoutingTable;
  /** Tool policy; default an 'edit'-only allowlist. */
  toolPolicy?: ToolPolicy;
  /** Budget caps; default uncapped. */
  budget?: Budget;
}

/** The JSON-serializable probe binding of a dispatch input. */
export interface SweepUnitCheckConfig {
  /** The probe's wire-format adapter. */
  adapter: AdapterName;
  /** The check command (executed with cwd = the unit's worktree). */
  command: string;
  /** Argv; `{package}` is replaced with the unit's package per dispatch. */
  args: string[];
  /** Wall-clock cap; default the checkRunner registry default via the op. */
  timeoutMs?: number;
}

/**
 * The JSON-serializable dispatch input of the registered 'sweep.unit' op —
 * the plan job's input: the unit (package/fixer/files) plus the run context
 * (repoRoot/worktreesDir/runPrefix/base) plus the binding knobs that
 * JSON-serialize. `driver` and `check` are OPTIONAL at the schema (a plan
 * can be authored before its fixer/probe wiring is chosen) and REQUIRED at
 * binding time — bindingsFromDispatch refuses without them, and the honest
 * `failed` names the field.
 */
export interface SweepUnitDispatchInput {
  repoRoot: string;
  worktreesDir: string;
  runPrefix: string;
  base: string;
  package: string;
  fixer: string;
  files: string[];
  /**
   * RESOLVED branch segments (jTPa1): shipped by the plan builder when slug
   * normalization collided (e.g. `@a/b` vs `a.b` → `a-b` vs `a-b-2`) so the
   * op's branch, worktree derivation, and committed marker agree with the
   * assembler. Absent: derived via sweepUnitSegments.
   */
  kind?: string;
  slug?: string;
  /** Propose-only mode: every non-empty staged set routes to needs-human. */
  proposeOnly?: boolean;
  /** The pipeline mode (UC §1 row 3); default 'fix' — see SweepUnitBindings.mode. */
  mode?: 'fix' | 'prep';
  /**
   * The git-mutex binding (jVgCc) for the unit's worktree mutations —
   * sibling units at the caller's concurrency serialize their prune/add/ref
   * sections on ONE lockfile. DEFAULT (when absent): a repo-level lock on
  /**
   * EXPLICIT caller-supplied run-state dir (review-debt #174). When set, the
   * caller VOUCHES the location is outside the fixer driver's write reach —
   * it is where the scanned-commit-sha record (the strand-retry's push
   * authorization) lives, and only a caller-controlled location can make
   * that record trustworthy. The op CANNOT verify "outside the driver's
   * reach" (the sandbox level is caller-chosen and may be 'none'), so the
   * vouch is a CALLER CONTRACT, not an enforced property (r2 info). When
   * ABSENT the derived `sweepRunStateDir(...)` location (inside the
   * worktrees dir, within the driver's reach) is used for baseline snapshots
   * and committed markers, but the STRAND-RETRY refuses to push (no
   * trustworthy record can exist there — fail closed, needs-human).
   */
  runStateDir?: string;
  /** The run-state dir's git-mutex lockfile (`<runStateDir>/git-mutex.lock`,
   * family timings); the push shares the same lockfile. */
  mutex?: WorktreeMutexConfig;
  /** Sandbox preference; default `{level: 'none'}` (production callers set it). */
  sandboxPolicy?: SandboxPolicy;
  /** Wall-clock cap for one git subprocess; default the family's 600s. */
  gitTimeoutMs?: number;
  /**
   * Push the unit's branch after a commit (`push -u origin <branch>` inside
   * the git mutex). DEFAULT TRUE — a fleet's branches must exist on the
   * remote before pr.assemblePrs; set false ONLY for local-only sweeps.
   */
  push?: boolean;
  /** The staged-path allowlist (see SweepUnitBindings.stagePathAllowlist). */
  stagePathAllowlist?: { patterns: string[] };
  /** The fixer binding — required at dispatch (see the interface doc). */
  driver?: SweepUnitDriverConfig;
  /** The probe binding — required at dispatch (see the interface doc). */
  check?: SweepUnitCheckConfig;
  /** The fixer prompt template; default DEFAULT_UNIT_PROMPT_TEMPLATE. */
  promptTemplate?: string;
}

/**
 * Auto-maintenance suppression via env config (the worktreeFor family's
 * gc.auto=0 / maintenance.auto=false, transported differently): makeGhRunner
 * spawns a bare argv with no `-c` prefix slot, so the same two keys ride
 * GIT_CONFIG_* env — a commit's detached background `gc --auto` inheriting
 * the pipes would otherwise hang the call past git's own exit.
 */
const GIT_NO_AUTO_MAINTENANCE_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
} as const;

/**
 * The shipped push leg: `git push -u origin <branch>` run in `repoRoot` with
 * an execFile ARGS ARRAY (never a shell string), bounded by the worktreeFor
 * family's default wall clock, and serialized through a git mutex on
 * `lockPath` (default `<runStateDir>/git-mutex.lock` — the SAME lockfile the
 * worktree mutations serialize on). Resolves void; REJECTS with the captured
 * stderr on a non-zero exit (the op folds the rejection into a `failed`
 * result naming the branch).
 */
export function makePushBranch(opts?: {
  timeoutMs?: number;
  lockPath?: string;
  /** Mutex timings — preserved from the caller's mutex config (jeDcl): a push misclassifying a held lock on a different stale window would race a sibling's worktree mutations. */
  staleMs?: number;
  retries?: number;
  retryBaseMs?: number;
}): (repoRoot: string, branch: string) => Promise<void> {
  const git = makeGhRunner({
    bin: 'git',
    timeoutMs: opts?.timeoutMs ?? DEFAULT_UNIT_GIT_TIMEOUT_MS,
    env: { ...GIT_NO_AUTO_MAINTENANCE_ENV },
  });
  const mutex: GitMutex | undefined =
    opts?.lockPath === undefined
      ? undefined
      : makeGitMutex({
          lockPath: opts.lockPath,
          ...(opts.staleMs !== undefined ? { staleMs: opts.staleMs } : {}),
          ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
          ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
        });
  return async (repoRoot: string, branch: string): Promise<void> => {
    const run = async (): Promise<void> => {
      const pushed = await git(['-C', repoRoot, 'push', '-u', 'origin', branch]);
      if (pushed.code !== 0) {
        throw new Error(pushed.stderr.trim() || `git push -u origin ${branch} failed`);
      }
    };
    if (mutex === undefined) {
      await run();
      return;
    }
    await mutex.withLock(run);
  };
}

/**
 * The push-lock options for one dispatch (jeDcl): the caller's FULL mutex
 * config — timings PRESERVED, `lockPath` swapped to the push lockfile — so
 * the push's stale window matches the worktree mutex's exactly (a push
 * holding a lock under a shorter stale window than the worktree mutex's
 * could be misclassified stale by a waiting sibling and steal it mid-push).
 */
export function pushLockOptions(
  mutex: WorktreeMutexConfig,
  gitTimeoutMs?: number,
): {
  timeoutMs?: number;
  lockPath: string;
  staleMs?: number;
  retries?: number;
  retryBaseMs?: number;
} {
  return {
    ...(gitTimeoutMs !== undefined ? { timeoutMs: gitTimeoutMs } : {}),
    lockPath: mutex.lockPath,
    ...(mutex.staleMs !== undefined ? { staleMs: mutex.staleMs } : {}),
    ...(mutex.retries !== undefined ? { retries: mutex.retries } : {}),
    ...(mutex.retryBaseMs !== undefined ? { retryBaseMs: mutex.retryBaseMs } : {}),
  };
}

/**
 * The registry binding (jSKJF): SweepUnitDispatchInput → SweepUnitBindings
 * over the REAL effects, input-driven exactly like the worktreeFor entry.
 * THROWS (honestly, naming the field) when `driver` or `check` is absent —
 * the registry schema admits them as optional so a plan can be authored
 * before its wiring is chosen, but a DISPATCH without them is a
 * misconfiguration, never a silent no-op.
 */
export function bindingsFromDispatch(input: SweepUnitDispatchInput): SweepUnitBindings {
  if (input.driver === undefined) {
    throw new Error(
      'sweep.unit: the dispatch input carries no driver config — the shipped dispatch requires a fixer (driver: {binary, provider, model})',
    );
  }
  if (input.check === undefined) {
    throw new Error(
      'sweep.unit: the dispatch input carries no check config — the shipped dispatch requires a probe (check: {adapter, command, args})',
    );
  }
  const runStateDir = sweepRunStateDir(input.repoRoot, input.worktreesDir, input.runPrefix);
  // jVgCc: the dispatch mutex DEFAULTS to a repo-level lock on the run-state
  // dir (family timings), so sibling units dispatched concurrently serialize
  // their worktree mutations AND their pushes on ONE lockfile; the input's
  // mutex block overrides (the builder/overlay seam).
  const mutex: WorktreeMutexConfig = input.mutex ?? {
    lockPath: join(runStateDir, 'git-mutex.lock'),
  };
  // jTPa1: the plan builder's resolved segments win (collision-safe); a bare
  // dispatch derives its own.
  const derived = sweepUnitSegments(input.runPrefix, {
    package: input.package,
    fixer: input.fixer,
  });
  const segments: SweepUnitSegments =
    input.kind !== undefined && input.slug !== undefined
      ? {
          kind: input.kind,
          slug: input.slug,
          branch: `${input.runPrefix}/${input.kind}/${input.slug}`,
        }
      : derived;
  const driver = withServedModelAssertion(
    new SubprocessDriver({
      binary:
        typeof input.driver.binary === 'string' ? [input.driver.binary] : [...input.driver.binary],
      routingTable: input.driver.routingTable ?? defaultRoutingTable(),
      ...(input.driver.sessionsDir !== undefined ? { sessionsDir: input.driver.sessionsDir } : {}),
    }),
    'default',
  );
  return {
    repoRoot: input.repoRoot,
    worktreesDir: input.worktreesDir,
    runPrefix: input.runPrefix,
    base: input.base,
    segments,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.proposeOnly === true ? { proposeOnly: true } : {}),
    // The caller's explicit vouch (review-debt #174): an absent runStateDir
    // keeps the derived (driver-reachable) location for baseline/markers,
    // and the strand-retry refuses to push — the record it would trust
    // cannot be trustworthy there.
    ...(input.runStateDir !== undefined ? { runStateDir: input.runStateDir } : {}),
    mutex,
    adapter: input.check.adapter,
    // The REAL probe runner (the checkRunner lane's shipped subprocess seam).
    runCheck: subprocessRunCheck,
    checkCommand: (unit, worktreePath) => ({
      command: input.check?.command ?? '',
      // A FUNCTION replacer, never a replacement string (review-debt #175
      // item 7): `$&`, `` $` `` and `$'` in a package name would otherwise be
      // reinterpreted as replacement tokens.
      args: (input.check?.args ?? []).map((arg) => arg.replaceAll('{package}', () => unit.package)),
      cwd: worktreePath,
      ...(input.check?.timeoutMs !== undefined ? { timeoutMs: input.check.timeoutMs } : {}),
    }),
    driver,
    modelSpec: { model: input.driver.model, provider: input.driver.provider },
    sessionsDir: input.driver.sessionsDir ?? defaultSessionsDir(),
    ...(input.driver.toolPolicy !== undefined ? { toolPolicy: input.driver.toolPolicy } : {}),
    ...(input.sandboxPolicy !== undefined ? { sandboxPolicy: input.sandboxPolicy } : {}),
    ...(input.gitTimeoutMs !== undefined ? { gitTimeoutMs: input.gitTimeoutMs } : {}),
    ...(input.driver.budget !== undefined ? { budget: input.driver.budget } : {}),
    prompt: (unit, worktree) =>
      (input.promptTemplate ?? DEFAULT_UNIT_PROMPT_TEMPLATE)
        // FUNCTION replacers (review-debt #175 item 7): a worktree path or
        // package/fixer name containing `$&`, `` $` `` or `$'` must land
        // literally, not as a replacement-pattern token.
        .replaceAll('{package}', () => unit.package)
        .replaceAll('{fixer}', () => unit.fixer)
        .replaceAll('{worktree}', () => worktree.path),
    git: makeGhRunner({
      bin: 'git',
      timeoutMs: input.gitTimeoutMs ?? DEFAULT_UNIT_GIT_TIMEOUT_MS,
      env: { ...GIT_NO_AUTO_MAINTENANCE_ENV },
    }),
    // DEFAULT TRUE: a fleet's branches must reach the remote before
    // assemblePrs; an explicit push:false opts into a local-only run. The
    // push shares the dispatch mutex's lockfile AND its timings (jeDcl — a
    // push under a shorter stale window could be misclassified stale by a
    // waiting sibling and stolen mid-push) so it cannot race a sibling's
    // worktree add/prune.
    ...(input.push === false
      ? {}
      : {
          pushBranch: makePushBranch(pushLockOptions(mutex, input.gitTimeoutMs)),
        }),
    ...(input.stagePathAllowlist !== undefined
      ? { stagePathAllowlist: input.stagePathAllowlist }
      : {}),
  };
}

/** The subprocess driver's own default sessions dir (kept in sync, never imported: driver-internal). */
function defaultSessionsDir(): string {
  return join(tmpdir(), 'cq-harness', 'sessions');
}

// ---------------------------------------------------------------------------
// The committed markers (jTPa8) — the assemble leg's source of truth
// ---------------------------------------------------------------------------

/**
 * Write a unit's committed marker —
 * `<runStateDir>/committed/<kind>/<slug>.json` — after it committed AND
 * pushed. The assemble leg enumerates these ({@link readCommittedMarkers})
 * and assembles ONLY the units that produced one: a no-change (uncommitted)
 * unit must never assemble an empty-diff PR. A fault names the stage.
 */
async function writeCommittedMarker(
  bindings: SweepUnitBindings,
  segments: SweepUnitSegments,
  unit: WorkUnit,
): Promise<string | null> {
  const runStateDir =
    bindings.runStateDir ??
    sweepRunStateDir(bindings.repoRoot, bindings.worktreesDir, bindings.runPrefix);
  const markerDir = join(runStateDir, SWEEP_RUN_STATE_COMMITTED_DIR, segments.kind);
  try {
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${segments.slug}.json`),
      `${JSON.stringify({ package: unit.package, fixer: unit.fixer, branch: segments.branch })}\n`,
      'utf8',
    );
    return null;
  } catch (err) {
    return `sweep.unit: could not write the committed marker under '${markerDir}' — ${messageOf(err)}`;
  }
}

/**
 * PUSH-TIME re-verification of the scanned commit (review-debt #174 r1,
 * HIGH 2): the stage/scan/commit checks ran earlier — between them and the
 * execve a detached driver process could still have committed. The tip must
 * be EXACTLY `expectedSha`; when `expectedParent` is non-null the tip must
 * sit directly on it (exactly one commit on top of the pre-driver HEAD);
 * and the committed diff (`HEAD^..HEAD`) must re-scan clean through the
 * same tamper gate. Any mismatch is a [TAMPER] failure naming the
 * divergence — the push never happens. `expectedParent === null` (the
 * strand-retry leg) checks the parent against the BASE tip instead: a
 * recorded stranded commit sits one commit on top of the base by
 * construction.
 */
async function verifyScannedTip(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktreePath: string,
  expectedSha: string,
  expectedParent: string | null,
): Promise<string | Extract<StagePathGateResult, { kind: 'protected' }> | null> {
  const head = await bindings.git(['-C', worktreePath, 'rev-parse', 'HEAD']);
  if (head.code !== 0) {
    return tagged(
      'infra',
      `sweep.unit ${unit.package}: git rev-parse HEAD failed — ${head.stderr.trim()}`,
    );
  }
  const tip = head.stdout.trim();
  if (tip !== expectedSha) {
    return tagged(
      'tamper',
      `sweep.unit ${unit.package}: the worktree tip (${tip}) is not the scanned commit (${expectedSha}) at push time — the tree moved after verification; nothing pushed — needs-human evidence`,
    );
  }
  let parentRef = 'HEAD^';
  if (expectedParent === null) {
    const baseTip = await bindings.git(['-C', worktreePath, 'rev-parse', `${bindings.base}`]);
    if (baseTip.code !== 0) {
      return tagged(
        'infra',
        `sweep.unit ${unit.package}: git rev-parse ${bindings.base} failed — ${baseTip.stderr.trim()}`,
      );
    }
    parentRef = `${bindings.base}`;
    const parent = await bindings.git(['-C', worktreePath, 'rev-parse', 'HEAD^']);
    if (parent.code !== 0 || parent.stdout.trim() !== baseTip.stdout.trim()) {
      return tagged(
        'tamper',
        `sweep.unit ${unit.package}: the stranded commit's parent is not the base tip — the branch does not carry exactly the recorded scanned commit; nothing pushed — needs-human evidence`,
      );
    }
  } else {
    const parent = await bindings.git(['-C', worktreePath, 'rev-parse', 'HEAD^']);
    if (parent.code !== 0) {
      return tagged(
        'infra',
        `sweep.unit ${unit.package}: git rev-parse HEAD^ failed — ${parent.stderr.trim()}`,
      );
    }
    if (parent.stdout.trim() !== expectedParent) {
      return tagged(
        'tamper',
        `sweep.unit ${unit.package}: the pushed commit's parent (${parent.stdout.trim()}) is not the pre-driver HEAD (${expectedParent}) — more than the scanned commit moved; nothing pushed — needs-human evidence`,
      );
    }
  }
  void parentRef;
  const committedPaths = await bindings.git([
    '-C',
    worktreePath,
    'diff',
    'HEAD^',
    'HEAD',
    '--text',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--name-status',
    '-z',
  ]);
  if (committedPaths.code !== 0) {
    return tagged(
      'infra',
      `sweep.unit ${unit.package}: git diff HEAD^..HEAD name-status failed — ${committedPaths.stderr.trim()}`,
    );
  }
  const protectedPaths = stagedPathsOf(committedPaths.stdout).filter(isProtectedStagePath);
  if (protectedPaths.length > 0) {
    return {
      kind: 'protected',
      paths: protectedPaths,
      message: `sweep.unit ${unit.package}: protected path(s) appeared in the committed diff — ${protectedPaths.join(', ')} — nothing pushed — needs-human evidence`,
    };
  }
  const committedDiff = await bindings.git([
    '-C',
    worktreePath,
    'diff',
    'HEAD^',
    'HEAD',
    '--text',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--',
  ]);
  if (committedDiff.code !== 0) {
    return tagged(
      'infra',
      `sweep.unit ${unit.package}: git diff HEAD^..HEAD failed — ${committedDiff.stderr.trim()}`,
    );
  }
  const hack = await hackDetector({ diff: committedDiff.stdout });
  if (hack.status !== 'ok' || hack.value.length > 0) {
    const named =
      hack.status !== 'ok'
        ? `the tamper scan returned ${hack.status} — ${resultDetail(hack)}`
        : `tamper findings in the committed diff: ${hack.value
            .map((f) => `${f.kind} ${f.file}:${String(f.line ?? '?')} (${f.message})`)
            .join('; ')}`;
    return tagged(
      'tamper',
      `sweep.unit ${unit.package}: the committed diff FAILED the push-time tamper re-scan — ${named}; nothing pushed — needs-human evidence`,
    );
  }
  return null;
}

/**
 * Record the SCANNED commit's sha in the run-state —
 * `<runStateDir>/scanned/<kind>/<slug>.json` (review-debt #174): the
 * strand-retry's proof that an ahead-of-base tip is THIS op's scanned
 * commit. Written at the commit step, read back on the no-commit leg.
 */
async function recordScannedCommitSha(
  bindings: SweepUnitBindings,
  segments: SweepUnitSegments,
  sha: string,
): Promise<string | null> {
  const runStateDir =
    bindings.runStateDir ??
    sweepRunStateDir(bindings.repoRoot, bindings.worktreesDir, bindings.runPrefix);
  const scannedDir = join(runStateDir, SWEEP_RUN_STATE_SCANNED_DIR, segments.kind);
  try {
    await mkdir(scannedDir, { recursive: true });
    await writeFile(
      join(scannedDir, `${segments.slug}.json`),
      `${JSON.stringify({ sha: sha })}\n`,
      'utf8',
    );
    return null;
  } catch (err) {
    return `sweep.unit: could not write the scanned-commit record under '${scannedDir}' — the commit IS scanned but will be STRAND-LOCKED (the strand-retry refuses to push without the record); recovery: push '${segments.branch}' manually or re-run — ${messageOf(err)}`;
  }
}

/**
 * Read back the recorded scanned-commit sha (review-debt #174), or null
 * when no record exists (a divergent history is the caller's fail-closed
 * case, not a fault here).
 */
async function readScannedCommitSha(
  bindings: SweepUnitBindings,
  segments: SweepUnitSegments,
): Promise<string | null> {
  const runStateDir =
    bindings.runStateDir ??
    sweepRunStateDir(bindings.repoRoot, bindings.worktreesDir, bindings.runPrefix);
  try {
    const text = await readFile(
      join(runStateDir, SWEEP_RUN_STATE_SCANNED_DIR, segments.kind, `${segments.slug}.json`),
      'utf8',
    );
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sha?: unknown }).sha === 'string'
    ) {
      return (parsed as { sha: string }).sha;
    }
    return null;
  } catch {
    return null;
  }
}

/** One enumerated committed marker (plain JSON). */
export interface CommittedMarker {
  package: string;
  fixer: string;
  branch: string;
}

/**
 * Enumerate the run's committed markers (jTPa8): every
 * `<runStateDir>/committed/<kind>/<slug>.json` the fleet's units wrote.
 * Markers from other run prefixes are not visible here (the run-state dir is
 * namespaced per run); markers from an EARLIER invocation of the SAME run
 * prefix are — the reference driver intersects them with the current run's
 * units before composing the assemble input. A malformed marker is skipped,
 * never trusted.
 */
export async function readCommittedMarkers(
  repoRoot: string,
  worktreesDir: string,
  runPrefix: string,
  /** The EXPLICIT caller-supplied run-state dir (review-debt #174) — when
   * the writer (the unit op) used one, the reader must read the SAME dir. */
  runStateDir?: string,
): Promise<CommittedMarker[]> {
  const committedDir = join(
    runStateDir ?? sweepRunStateDir(repoRoot, worktreesDir, runPrefix),
    SWEEP_RUN_STATE_COMMITTED_DIR,
  );
  let kindDirs: string[];
  try {
    kindDirs = await readdir(committedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw err;
  }
  const markers: CommittedMarker[] = [];
  for (const kind of kindDirs.sort()) {
    let files: string[];
    try {
      files = await readdir(join(committedDir, kind));
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(committedDir, kind, file), 'utf8'));
        const record = parsed as Partial<CommittedMarker> | null;
        if (
          typeof record === 'object' &&
          record !== null &&
          typeof record.package === 'string' &&
          record.package !== '' &&
          typeof record.fixer === 'string' &&
          record.fixer !== '' &&
          typeof record.branch === 'string' &&
          record.branch !== ''
        ) {
          markers.push({ package: record.package, fixer: record.fixer, branch: record.branch });
        }
      } catch {
        // A malformed marker is skipped, never trusted (I9: the assemble leg
        // composes from VERIFIED records only).
      }
    }
  }
  return markers;
}
