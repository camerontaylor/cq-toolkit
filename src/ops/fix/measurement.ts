import type {
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
  MetricRecord,
} from '../../kernel/types.js';
import type { FixTaskReport } from '../sweep/taskLoop.js';

const TODO_KEY = 'cq-todo';

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

/**
 * Exact verified-fix predicate over one task's raw evidence (ADR-0008):
 * outcome `fixed`, validation present with passing verdict, the SHA in that
 * task's commits, and a closure link to the task. A commit whose message is
 * unavailable yields no closure: its trailer status is unknown, never
 * guessed. `readCommitMessage` returns the full commit message or undefined.
 */
export function verifiedClosuresOf(
  tasks: readonly FixTaskReport[],
  readCommitMessage: (sha: string) => string | undefined,
): { closures: ClosureRecord[]; unknownTrailerShas: string[] } {
  const closures: ClosureRecord[] = [];
  const unknownTrailerShas: string[] = [];
  for (const task of tasks) {
    if (task.outcome !== 'fixed' || task.validation?.verdict !== 'pass') continue;
    for (const commitSha of task.commits) {
      // A validated fix must reference its task; the Cq-Task link is
      // verified against the task's own id, never trusted blind.
      if (!task.task.id) continue;
      if (commitSha === '') continue;
      const message = readCommitMessage(commitSha);
      if (message === undefined) {
        if (!unknownTrailerShas.includes(commitSha)) unknownTrailerShas.push(commitSha);
        continue;
      }
      closures.push({
        commitSha,
        taskIds: [task.task.id],
        findingFingerprints: [],
        verificationEvidence: [`validation:${task.validation.verdict}`],
        todo: isTodoCommitMessage(message),
      });
    }
  }
  return { closures, unknownTrailerShas };
}

/**
 * Denominator evidence for every planned unit (ADR-0008 baseline row): every
 * planned unit is represented. A completed probe reports its count; a bailed,
 * absent or probeless unit is unknown with a reason, never zero. `probeHead`
 * stays null: FixTaskReport carries no probe head, and the baseline probe
 * producer (ADR-0008 planner/T35 scope) is not wired in this slice.
 */
export function baselineFailuresOf(
  plannedUnits: readonly string[],
  probeCounts: ReadonlyMap<string, { completed: boolean; count: number | null }>,
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
    return { unitId, probeHead: null, completed: true, count: probe.count, unknownReason: null };
  });
}

/**
 * The run's metric record (ADR-0008 metric row), with the availability map
 * keyed by JSON Pointer per the T28 schema. A zero numerator is known zero
 * (state `known-zero`), never null; null means genuinely unknown (a
 * candidate closure whose trailer evidence is missing). Duplicate SHAs count
 * once; an unknown denominator is null, never zero.
 */
export function measureRun(
  tasks: readonly FixTaskReport[],
  plannedUnits: readonly string[],
  probeCounts: ReadonlyMap<string, { completed: boolean; count: number | null }>,
  readCommitMessage: (sha: string) => string | undefined,
): MetricRecord & { availability: Record<string, AvailabilityRecord> } {
  const { closures, unknownTrailerShas } = verifiedClosuresOf(tasks, readCommitMessage);
  const verified = closures.filter((closure) => !closure.todo);
  const distinctVerified = [...new Set(verified.map((closure) => closure.commitSha))];
  const baselineFailures = baselineFailuresOf(plannedUnits, probeCounts);
  const denominatorKnown = baselineFailures.every((row) => row.count !== null);
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
    '/metric/fixesPerRun/denominator': denominatorKnown
      ? { state: 'known', reason: 'summed from completed unit baseline probes', source: null }
      : {
          state: 'not-collected',
          reason: 'a planned unit has no completed baseline probe',
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
