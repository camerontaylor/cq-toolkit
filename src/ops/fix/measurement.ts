import type {
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
  MetricRecord,
} from '../../kernel/types.js';
import type { AddressFix } from '../review/addressWorker.js';
import type { Finding } from '../review/findings.js';
import type { FixTaskReport } from '../sweep/taskLoop.js';
import type { ValidationVerdict } from './validate.js';

const TODO_KEY = 'cq-todo';
const TASK_KEY = 'cq-task';

/** The commit trailer block's `Cq-Task` value, or null when absent. */
function readLinkedTaskId(message: string): string | null {
  const trailerBlock =
    message
      .trimEnd()
      .split(/\r?\n\r?\n/)
      .pop() ?? '';
  for (const line of trailerBlock.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== TASK_KEY) continue;
    return line.slice(separator + 1).trim();
  }
  return null;
}

/**
 * True when the commit's trailer block carries a `Cq-Todo: true` trailer
 * (ADR-0008 non-todo rule): the key and value are trimmed and compared
 * case-insensitively. Only the last paragraph — the git trailer block — is
 * scanned; the subject and prose are never treated as intent signals.
 */
export function isTodoCommitMessage(message: string): boolean {
  const trailerBlock =
    message
      .trimEnd()
      .split(/\r?\n\r?\n/)
      .pop() ?? '';
  for (const line of trailerBlock.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== TODO_KEY) continue;
    if (
      line
        .slice(separator + 1)
        .trim()
        .toLowerCase() === 'true'
    )
      return true;
  }
  return false;
}

/** Pre-v2 rule: distinct commit SHAs on `fixed` rows; types-only, so cycle-free. */
export function distinctFixedCommitCount(
  tasks: readonly { outcome: string; commits: readonly string[] }[],
): number {
  return new Set(tasks.filter((task) => task.outcome === 'fixed').flatMap((task) => task.commits))
    .size;
}

/**
 * One unit's producer evidence, reduced to the single verified-fix predicate
 * below. A fix run supplies a FixTaskReport and a review run an AddressFix;
 * both normalize to this shape so the ADR's exact closure rule is implemented
 * once. The predicate therefore cannot fork on outcome spelling or on
 * single-verdict versus per-check validation arrays.
 */
export interface ClosureCandidate {
  /** Task or finding identity the commit's Cq-Task trailer must name. */
  linkId: string | null;
  /** Producer-reported terminal fixed disposition. */
  fixed: boolean;
  /** Commits attributed to the unit. */
  commits: readonly string[];
  /** Normalized gate verdict; undefined means no validation was recorded. */
  validation: ValidationVerdict | undefined;
}

function fixCandidateOf(task: FixTaskReport): ClosureCandidate {
  return {
    linkId: task.task.id || null,
    fixed: task.outcome === 'fixed',
    commits: task.commits,
    validation: task.validation,
  };
}

/**
 * Review projection of the worker's validation. `AddressFix.validation` holds
 * one verdict PER check adapter, while the shared predicate needs the unit's
 * single verdict. An empty array is "no validation recorded" (undefined),
 * never a synthesized pass. Merged gate records retain every check's evidence,
 * and a regression flag is preserved. The predicate consumes one bit — every
 * per-check row passed — so no worst-verdict precedence is applied: any
 * non-pass row refuses the closure under its own verdict.
 */
function reviewValidationOf(rows: readonly ValidationVerdict[]): ValidationVerdict | undefined {
  if (rows.length === 0) return undefined;
  const firstRefusal = rows.find((row) => row.verdict !== 'pass');
  return {
    verdict: firstRefusal?.verdict ?? 'pass',
    gates: rows.flatMap((row) => row.gates),
    ...(rows.some((row) => row.regression === true) ? { regression: true as const } : {}),
  };
}

/**
 * The finding id as the review commit writer actually emits it: embedded
 * newlines collapse to a single space before the shared trailer writer, and
 * the trailer reader trims the value. Comparing the raw caller-supplied id
 * would let a newline or edge whitespace make a commit fail to link to the
 * finding it itself names.
 */
function reviewLinkIdOf(findingId: string): string | null {
  return findingId.replace(/[\r\n]+/g, ' ').trim() || null;
}

function reviewCandidateOf(fix: AddressFix): ClosureCandidate {
  return {
    linkId: reviewLinkIdOf(fix.finding.id),
    fixed: fix.finding.status === 'fixed',
    // Only a disposition that produced a commit names one; absence stays
    // absent rather than becoming an empty-string commit placeholder.
    commits: fix.commit === undefined ? [] : [fix.commit],
    validation: reviewValidationOf(fix.validation),
  };
}

function candidateOf(row: FixTaskReport | AddressFix): ClosureCandidate {
  return 'task' in row ? fixCandidateOf(row) : reviewCandidateOf(row);
}

/**
 * The exact verified-fix predicate shared by both producers (ADR-0008):
 * terminal `fixed`, validation present with passing verdict, the SHA in the
 * unit's commits, and a closure link to the task or finding. A commit whose
 * message is unavailable yields no closure: its trailer status is unknown,
 * never guessed. No subject, prose or skip marker is ever inspected.
 * `readCommitMessage` returns the full commit message or undefined.
 */
function closuresOf(
  candidates: readonly ClosureCandidate[],
  readCommitMessage: (sha: string) => string | undefined,
): { closures: ClosureRecord[]; unknownTrailerShas: string[] } {
  const closures: ClosureRecord[] = [];
  const unknownTrailerShas: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.fixed || candidate.validation?.verdict !== 'pass') continue;
    // A validated fix must reference its task or finding; the Cq-Task link is
    // verified against that own identity, never trusted blind.
    if (!candidate.linkId) continue;
    for (const commitSha of candidate.commits) {
      if (commitSha === '') continue;
      const message = readCommitMessage(commitSha);
      if (message === undefined) {
        if (!unknownTrailerShas.includes(commitSha)) unknownTrailerShas.push(commitSha);
        continue;
      }
      // The closure link is verified, not trusted: the commit's own Cq-Task
      // trailer must name this unit's identity (ADR-0007 identity, ADR-0008
      // closure). Review commits name the finding id in that same trailer.
      const linkedTaskId = readLinkedTaskId(message);
      if (linkedTaskId !== candidate.linkId) continue;
      closures.push({
        commitSha,
        taskIds: [candidate.linkId],
        findingFingerprints: [],
        verificationEvidence: [`validation:${candidate.validation.verdict}`],
        todo: isTodoCommitMessage(message),
      });
    }
  }
  return { closures, unknownTrailerShas };
}

/** Fix-run entry to the shared predicate (ADR-0008 T34). */
export function verifiedClosuresOf(
  tasks: readonly FixTaskReport[],
  readCommitMessage: (sha: string) => string | undefined,
): { closures: ClosureRecord[]; unknownTrailerShas: string[] } {
  return closuresOf(tasks.map(fixCandidateOf), readCommitMessage);
}

/**
 * Review-run entry to the same predicate (ADR-0008 T35). makeAddressWorker
 * records one AddressFix per dispatched finding and makeReviewAddress
 * aggregates them; this projection reads only that evidence. The closure link
 * is required: a commit whose subject names the finding but whose trailer
 * does not is not a closure.
 */
export function reviewClosuresOf(
  fixes: readonly AddressFix[],
  readCommitMessage: (sha: string) => string | undefined,
): { closures: ClosureRecord[]; unknownTrailerShas: string[] } {
  return closuresOf(fixes.map(reviewCandidateOf), readCommitMessage);
}

/**
 * Review-run baseline planned units (ADR-0008 T35): the initial open-blocker
 * population the report captured at first admission, before any fix. The
 * post-fix `openBlocking` recomputation is NOT a substitute — a fixed blocker
 * drops out of it, so substituting it would shrink the denominator and inflate
 * fixes-per-run. A report with no capture returns null (unknown), never an
 * inferred population.
 */
export function reviewPlannedUnitsOf(report: {
  initialOpenBlocking?: readonly string[];
  /**
   * Admitted only so a caller holding a ReviewAddressReport needs no cast; it
   * is never read. This is the whole point of the seam: the recomputed
   * post-fix population is not the baseline.
   */
  openBlocking?: readonly Finding[];
}): string[] | null {
  const initial = report.initialOpenBlocking;
  return initial === undefined ? null : [...initial];
}

/**
 * One planned unit's baseline-probe evidence (M2c): a completed probe names
 * its failure count and the worktree HEAD it ran at. `probeHead` is OPTIONAL
 * so a producer without a head — the review run's own completed/count-1 map
 * — needs no change; an absent head stays null on the emitted row.
 */
type BaselineProbe = { completed: boolean; count: number | null; probeHead?: string | null };

/**
 * Denominator evidence for every planned unit (ADR-0008 baseline row): every
 * planned unit is represented. A completed probe reports its count; a bailed,
 * absent or probeless unit is unknown with a reason, never zero. `probeHead`
 * carries the completed probe's own head when its producer knows it (M2c: the
 * fix run wires each unit's baseline probe at its worktree HEAD); a producer
 * without one leaves the row's head null.
 */
export function baselineFailuresOf(
  plannedUnits: readonly string[],
  probeCounts: ReadonlyMap<string, BaselineProbe>,
): BaselineFailureRecord[] {
  return plannedUnits.map((unitId) => {
    const probe = probeCounts.get(unitId);
    if (!probe || !probe.completed || probe.count === null)
      return {
        unitId,
        probeHead: null,
        completed: false,
        count: null,
        unknownReason: 'baseline probe did not complete for this unit',
      };
    return {
      unitId,
      probeHead: probe.probeHead ?? null,
      completed: true,
      count: probe.count,
      unknownReason: null,
    };
  });
}

/**
 * The run's metric record (ADR-0008 metric row), with the availability map
 * keyed by JSON Pointer per the T28 schema. A zero numerator is known zero
 * (state `known-zero`), never null; null means genuinely unknown (a
 * candidate closure whose trailer evidence is missing). Duplicate SHAs count
 * once; an unknown denominator is null, never zero.
 *
 * Evidence rows come from either producer: FixTaskReport for a fix run,
 * AddressFix for a review run. Both normalize through the same predicate
 * above. For a review run `plannedUnits` is the INITIAL open-blocker
 * population (each initial blocker is one observed baseline failure), passed
 * as `reviewPlannedUnitsOf(report)` with no `?? []`: null means the report
 * never captured a baseline (an unseeded run), and the denominator is then
 * UNAVAILABLE — never a known-zero read off an empty list. An explicitly
 * empty array is different: a captured, genuinely empty population is a
 * known zero. The post-fix `openBlocking` is never substituted, so the
 * baseline cannot shrink to whatever survived the run.
 */
export function measureRun(
  evidence: readonly (FixTaskReport | AddressFix)[],
  plannedUnits: readonly string[] | null,
  probeCounts: ReadonlyMap<string, BaselineProbe>,
  readCommitMessage: (sha: string) => string | undefined,
): MetricRecord & { availability: Record<string, AvailabilityRecord> } {
  const { closures, unknownTrailerShas } = closuresOf(evidence.map(candidateOf), readCommitMessage);
  const verified = closures.filter((closure) => !closure.todo);
  const distinctVerified = [...new Set(verified.map((closure) => closure.commitSha))];
  const baselineFailures =
    plannedUnits === null ? [] : baselineFailuresOf(plannedUnits, probeCounts);
  // null plannedUnits must not fall through `[].every` to a completed-zero
  // read: no capture is unknown, not known-zero.
  const denominatorKnown =
    plannedUnits !== null && baselineFailures.every((row) => row.count !== null);
  const numerator: number | null = unknownTrailerShas.length > 0 ? null : distinctVerified.length;
  const availability: Record<string, AvailabilityRecord> = {
    // A missing entry is only required for null values (T28 checkMetric);
    // known values still carry their state honestly.
    '/metric/fixesPerRun/numerator':
      numerator === null
        ? {
            state: 'unavailable',
            reason: 'candidate closure commit message unavailable',
            source: null,
          }
        : numerator === 0
          ? {
              state: 'known-zero',
              reason: 'no verified non-todo closure in this run',
              source: null,
            }
          : { state: 'known', reason: 'counted from run closure evidence', source: null },
    '/metric/fixesPerRun/denominator':
      plannedUnits === null
        ? {
            state: 'unavailable',
            reason: 'no initial open-blocker population captured for this run',
            source: null,
          }
        : !denominatorKnown
          ? {
              state: 'not-collected',
              reason: 'a planned unit has no completed baseline probe',
              source: null,
            }
          : baselineFailures.reduce((sum, row) => sum + (row.count ?? 0), 0) === 0
            ? {
                state: 'known-zero',
                reason: 'every completed probe reported zero failures',
                source: null,
              }
            : {
                state: 'known',
                reason: 'summed from completed unit baseline probes',
                source: null,
              },
  };
  baselineFailures.forEach((row, i) => {
    if (row.count === null)
      availability[`/metric/baselineFailures/${i}/count`] = {
        state: 'not-collected',
        reason: row.unknownReason ?? 'baseline count unknown',
        source: null,
      };
  });
  return {
    fixesPerRun: {
      numerator,
      denominator: denominatorKnown
        ? baselineFailures.reduce((sum, row) => sum + (row.count ?? 0), 0)
        : null,
    },
    verifiedCommits: distinctVerified,
    closures,
    baselineFailures,
    availability,
  };
}
