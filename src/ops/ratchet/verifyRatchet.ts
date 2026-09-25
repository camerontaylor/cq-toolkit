// verifyRatchet — the trusted ratchet verifier (W1.7, ADR-0004 D-B/D-C).
//
// This op is what `cq-verify.yml` runs from the DEFAULT BRANCH. It judges a
// subject commit (a PR head, or the merge-queue tip) without trusting
// anything the subject controls:
//   - DEFINITIONS come from the trust ref: `baselines/ratchets.json` (the
//     ratchet list and the definition set) and every baseline value are read
//     with `git cat-file` AT `trustRef`, never from a working tree the head
//     could have written (A5: a renamed target and a looser baseline in the
//     head change nothing here — the trust ref's list is what is enumerated).
//   - DEFINITION CHECK (D-C.3): the subject's changed paths, diffed against
//     `merge-base(subject, base)` (a PR: its base branch, so already-queued
//     siblings are not flagged; a push subject: `main`), are matched against
//     the trust ref's definition set plus the trust ref's tsconfig
//     `extends`/`references` graph. Any hit is `needs-human` — the D11
//     record that could authorize it is dormant until the D-H.3 C3
//     attestation (D-G.4), so no record is honoured here.
//   - MONOTONIC GUARD over the same range's `baselines/` diff, with the
//     hardened argv (no external diff, no textconv, no renames), after the
//     one-decimal coverage re-basis.
//   - EVIDENCE is untrusted data: the head-produced measurement artifact is
//     lstat-checked, size-capped and strict-schema validated (numbers only);
//     typecheck-count comes from the trusted recompute
//     (`ratchet.recomputeTypecheck`), passed in as a number. Accepted residual
//     (ADR-0004 D-J): the measurement leg executes head code, so the head can
//     report any coverage value.
//
// Failure direction (I5): every absent, unreadable or malformed input is a
// failing verdict, never a pass. The verdict is op DATA (`status: 'ok'`);
// `failed` is reserved for the verifier being unable to judge at all (the
// trust ref's manifest unreadable, a git fault) — the workflow maps both to
// a failing check run.
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import {
  isDefinitionPath,
  loadTrustedManifest,
  tsconfigGraphPaths,
  type RatchetDefinition,
} from './internal/definitions.js';
import {
  baselineRelPath,
  loosens,
  normalizeBaselineDiffValues,
  parseBaseline,
  roundCoveragePct,
} from './format.js';
import { gitChangedPaths, gitDiffText, gitMergeBase, gitReadBlob, gitRevParse } from './git.js';
import { checkDiffMonotonicity, formatViolations } from './monotonicGuard.js';
import type { DiffVerdict } from './monotonicGuard.js';

/** Largest measurement artifact the verifier will read (it is a few dozen bytes). */
export const MEASUREMENT_MAX_BYTES = 64 * 1024;

/** The coverage metric id: its evidence and baselines compare at one decimal place. */
const COVERAGE_METRIC = 'coverage';

/** `baselines/<target>--coverage--<digest>.json` — the coverage re-basis selector. */
const COVERAGE_BASELINE_PATH = /^baselines\/[^/]*--coverage--[^/]*\.json$/;

/**
 * The measurement artifact: numbers keyed by metric id, nothing else. Strict
 * at every level, so a head cannot smuggle text, nested objects or extra
 * keys past the verifier.
 */
export const MeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    metrics: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), z.number().finite())
      .refine((m) => Object.keys(m).length <= 16, { message: 'too many metrics' }),
  })
  .strict();

export interface VerifyRatchetInput {
  /** The TRUSTED checkout (built from the trust ref); the subject is only its git objects. */
  repo: string;
  /** The trust ref (the default-branch SHA the verdict is bound to). */
  trustRef: string;
  /** The commit being judged. */
  subject: string;
  /** `pr`: a PR head judged against its base; `push`: the merge-queue tip judged against main. */
  subjectKind: 'pr' | 'push';
  /** The branch ref whose merge-base with the subject starts the judged range. */
  base: string;
  /** The measurement run's conclusion; anything but `success` voids its artifact. */
  measureConclusion: string;
  /** Path of the downloaded measurement artifact (untrusted). */
  measurementPath?: string;
  /** typecheck-count from the trusted recompute; absent when the recompute failed. */
  typecheckCount?: number;
}

export interface RatchetResult {
  target: string;
  metric: string;
  evidence: RatchetDefinition['evidence'];
  baseline: number | null;
  value: number | null;
  verdict: 'pass' | 'fail';
  reason?: string;
}

export interface VerifyRatchetOutcome {
  verdict: 'pass' | 'fail' | 'needs-human';
  /** Resolved 40-hex SHAs the verdict is bound to. */
  trustRef: string;
  subject: string;
  /** Start of the judged range: merge-base(subject, base). */
  rangeBase: string;
  /** Definition-set paths the subject changed (non-empty → needs-human). */
  definitionChanges: string[];
  guard: DiffVerdict;
  results: RatchetResult[];
  /** One line per finding, for the check run's summary. */
  reasons: string[];
}

/** Error message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read and validate the measurement artifact. Returns the metrics map, or a
 * reason string — every fault is a reason, never a throw.
 */
async function readMeasurement(
  path: string | undefined,
): Promise<{ metrics: Record<string, number> } | { reason: string }> {
  if (path === undefined) return { reason: 'no measurement artifact' };
  let text: string;
  try {
    // lstat BEFORE read: a symlink (or any non-regular entry) planted in
    // the artifact is refused, never followed.
    const stat = await lstat(path);
    if (stat.isFile() === false) return { reason: 'measurement artifact is not a regular file' };
    if (stat.size > MEASUREMENT_MAX_BYTES) {
      return { reason: `measurement artifact exceeds ${MEASUREMENT_MAX_BYTES} bytes` };
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { reason: `measurement artifact unreadable — ${messageOf(err)}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { reason: 'measurement artifact is not valid JSON' };
  }
  const parsed = MeasurementSchema.safeParse(data);
  if (!parsed.success) {
    return {
      reason: `measurement artifact fails its schema — ${parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { metrics: parsed.data.metrics };
}

/** The value a definition's evidence supplies, or a reason it is unusable. */
function evidenceValue(
  def: RatchetDefinition,
  input: VerifyRatchetInput,
  measured: { metrics: Record<string, number> } | { reason: string },
): number | { reason: string } {
  if (def.evidence === 'recompute') {
    if (def.metric !== 'typecheck-count') {
      return { reason: `no trusted recompute exists for metric '${def.metric}'` };
    }
    const count = input.typecheckCount;
    if (count === undefined) return { reason: 'the trusted typecheck recompute produced no count' };
    if (!Number.isSafeInteger(count) || count < 0) {
      return { reason: `the typecheck recompute count ${count} is not a non-negative integer` };
    }
    return count;
  }
  if (input.measureConclusion !== 'success') {
    return { reason: `the measurement run concluded '${input.measureConclusion}'` };
  }
  if ('reason' in measured) return measured;
  const value = measured.metrics[def.metric];
  if (value === undefined) return { reason: `the measurement carries no '${def.metric}' value` };
  if (def.metric === COVERAGE_METRIC && (value < 0 || value > 100)) {
    return { reason: `coverage ${value} is outside [0, 100]` };
  }
  return value;
}

/** Judge one trust-ref ratchet definition against its trust-ref baseline. */
async function judgeRatchet(
  def: RatchetDefinition,
  input: VerifyRatchetInput,
  trust: string,
  measured: { metrics: Record<string, number> } | { reason: string },
): Promise<RatchetResult> {
  const base = {
    target: def.target,
    metric: def.metric,
    evidence: def.evidence,
  };
  const path = baselineRelPath(def.target, def.metric);
  let baselineValue: number;
  try {
    const text = await gitReadBlob(input.repo, trust, path);
    if (text === null) {
      return {
        ...base,
        baseline: null,
        value: null,
        verdict: 'fail',
        reason: `${path} is missing at the trust ref`,
      };
    }
    const baseline = parseBaseline(text);
    if (baseline.target !== def.target || baseline.metric !== def.metric) {
      return {
        ...base,
        baseline: null,
        value: null,
        verdict: 'fail',
        reason: `${path} names another ratchet`,
      };
    }
    if (baseline.direction !== def.direction) {
      return {
        ...base,
        baseline: baseline.value,
        value: null,
        verdict: 'fail',
        reason: `${path} direction ${baseline.direction} disagrees with the definition (${def.direction})`,
      };
    }
    if (baseline.unit !== def.unit) {
      return {
        ...base,
        baseline: baseline.value,
        value: null,
        verdict: 'fail',
        reason: `${path} unit ${baseline.unit ?? '(none)'} disagrees with the definition (${def.unit ?? '(none)'})`,
      };
    }
    baselineValue = baseline.value;
  } catch (err) {
    return {
      ...base,
      baseline: null,
      value: null,
      verdict: 'fail',
      reason: `${path}: ${messageOf(err)}`,
    };
  }
  const raw = evidenceValue(def, input, measured);
  if (typeof raw !== 'number') {
    return { ...base, baseline: baselineValue, value: null, verdict: 'fail', reason: raw.reason };
  }
  // One decimal place on BOTH sides for coverage (the shared granularity
  // law); every other metric compares at full precision.
  const coverage = def.metric === COVERAGE_METRIC;
  const baselineCmp = coverage ? roundCoveragePct(baselineValue) : baselineValue;
  const value = coverage ? roundCoveragePct(raw) : raw;
  if (loosens(baselineCmp, value, def.direction)) {
    return {
      ...base,
      baseline: baselineCmp,
      value,
      verdict: 'fail',
      reason: `${def.target}/${def.metric} regressed ${baselineCmp} → ${value} (${def.direction})`,
    };
  }
  return { ...base, baseline: baselineCmp, value, verdict: 'pass' };
}

/** The verifier op. See the module header for what is trusted and why. */
export const verifyRatchet: Op<VerifyRatchetInput, VerifyRatchetOutcome> = async (input) => {
  // The carrier resolves the PR base or merge-queue push before invoking this
  // op. Bind that classification to the branch whose merge-base starts the
  // judged range, so a mislabeled push cannot silently use the PR range.
  const baseBranch = /^(?:refs\/remotes\/origin\/)?(main|merge-queue)$/.exec(input.base)?.[1];
  if (baseBranch === undefined || (input.subjectKind === 'push' && baseBranch !== 'main')) {
    return {
      status: 'failed',
      error: `ratchet verify: ${input.subjectKind} subject has invalid base '${input.base}'`,
    };
  }
  let trust: string;
  let subject: string;
  let rangeBase: string;
  try {
    trust = await gitRevParse(input.repo, input.trustRef);
    subject = await gitRevParse(input.repo, input.subject);
    rangeBase = await gitMergeBase(input.repo, subject, input.base);
  } catch (err) {
    return { status: 'failed', error: `ratchet verify: ${messageOf(err)}` };
  }

  let manifest;
  let graph: string[];
  let changed: string[];
  let diff: string;
  try {
    manifest = await loadTrustedManifest(input.repo, trust);
    graph = await tsconfigGraphPaths(input.repo, trust);
    changed = await gitChangedPaths(input.repo, rangeBase, subject);
    diff = await gitDiffText(input.repo, rangeBase, subject, ['baselines/']);
  } catch (err) {
    return { status: 'failed', error: `ratchet verify: ${messageOf(err)}` };
  }

  const graphSet = new Set(graph);
  const definitionChanges = changed.filter(
    (path) => isDefinitionPath(manifest, path) || graphSet.has(path),
  );
  const guard = checkDiffMonotonicity(normalizeBaselineDiffValues(diff, COVERAGE_BASELINE_PATH));
  const measured = await readMeasurement(input.measurementPath);
  const results: RatchetResult[] = [];
  for (const def of manifest.ratchets) {
    results.push(await judgeRatchet(def, input, trust, measured));
  }

  const reasons: string[] = [];
  if (definitionChanges.length > 0) {
    reasons.push(
      `needs-human (D11): the subject changes ratchet definitions — ${definitionChanges.join(', ')}`,
    );
  }
  if (guard.ok === false) reasons.push(...formatViolations(guard.violations));
  for (const r of results) {
    if (r.verdict === 'fail') reasons.push(`${r.target}/${r.metric}: ${r.reason ?? 'failed'}`);
  }
  const failing = guard.ok === false || results.some((r) => r.verdict === 'fail');
  const verdict = definitionChanges.length > 0 ? 'needs-human' : failing ? 'fail' : 'pass';
  if (verdict === 'pass') {
    for (const r of results)
      reasons.push(`${r.target}/${r.metric}: ${r.value} vs baseline ${r.baseline}`);
  }
  return {
    status: 'ok',
    value: {
      verdict,
      trustRef: trust,
      subject,
      rangeBase,
      definitionChanges,
      guard,
      results,
      reasons,
    },
  };
};
