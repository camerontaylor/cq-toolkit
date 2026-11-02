import type {
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
  MetricRecord,
} from '../../kernel/types.js';
import type { FixTaskReport } from '../sweep/taskLoop.js';

const TODO_TRAILER = /^cq-todo$/i;
const TODO_TRUE = /^true$/i;

/**
 * True when the commit message carries a `Cq-Todo: true` trailer (ADR-0008
 * non-todo rule): key and value are trimmed and compared case-insensitively.
 * This is the only intent signal; TODOs are never guessed from source text,
 * skip markers or the commit subject.
 */
export function isTodoCommitMessage(message: string): boolean {
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (TODO_TRAILER.test(key) && TODO_TRUE.test(value)) return true;
  }
  return false;
}

/**
 * Exact verified-fix predicate over one task's raw evidence (ADR-0008):
 * outcome `fixed`, validation present with passing verdict, the SHA appears
 * in that task's commits, and a closure link to the task exists. A commit
 * whose message is unavailable (lookup returned undefined) is a closure with
 * unknown trailer status: it is never counted toward the numerator.
 */
export function verifiedClosuresOf(
  tasks: readonly FixTaskReport[],
  readCommitMessage: (sha: string) => string | undefined,
): ClosureRecord[] {
  const closures: ClosureRecord[] = [];
  for (const task of tasks) {
    if (task.outcome !== 'fixed' || task.validation?.verdict !== 'pass') continue;
    for (const commitSha of task.commits) {
      if (commitSha === '') continue;
      const message = readCommitMessage(commitSha);
      if (message === undefined) continue;
      closures.push({
        commitSha,
        taskIds: [task.task.id],
        findingFingerprints: [],
        verificationEvidence: [task.task.id],
        todo: isTodoCommitMessage(message),
      });
    }
  }
  return closures;
}

/**
 * Denominator evidence for every planned unit (ADR-0008 baseline row): every
 * planned unit is represented. A completed probe reports its count; a bailed,
 * absent or probeless unit is unknown with a reason, never zero.
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

const notCollected = (reason: string): AvailabilityRecord => ({
  state: 'not-collected',
  reason,
  source: null,
});

/**
 * The run's metric record (ADR-0008 metric row). Only distinct verified
 * non-todo commits count toward the numerator; duplicate SHAs across tasks
 * count once. An unknown denominator is null, never zero, so no success
 * ratio is printed without a denominator. `readCommitMessage` supplies each
 * commit's full message; returning undefined leaves that commit unverified.
 */
export function measureRun(
  tasks: readonly FixTaskReport[],
  plannedUnits: readonly string[],
  probeCounts: ReadonlyMap<string, { completed: boolean; count: number | null }>,
  readCommitMessage: (sha: string) => string | undefined,
): MetricRecord & { availability: Record<string, AvailabilityRecord> } {
  const closures = verifiedClosuresOf(tasks, readCommitMessage);
  const verified = closures.filter((closure) => !closure.todo);
  const distinctVerified = [...new Set(verified.map((closure) => closure.commitSha))];
  const baselineFailures = baselineFailuresOf(plannedUnits, probeCounts);
  const denominatorKnown = baselineFailures.every((row) => row.count !== null);
  const availability: Record<string, AvailabilityRecord> = {
    'metric.fixesPerRun.numerator': notCollected(
      'closure trailer evidence is in-memory; journal producer pending (ADR-0008 T13)',
    ),
    'metric.fixesPerRun.denominator': denominatorKnown
      ? notCollected(
          'denominator counts derive from in-memory probes; journal producer pending (ADR-0008 T13)',
        )
      : notCollected('at least one planned unit has no completed baseline probe'),
    'metric.verifiedCommits': notCollected(
      'commit trailer evidence is in-memory; journal producer pending (ADR-0008 T13)',
    ),
  };
  return {
    fixesPerRun: {
      numerator: distinctVerified.length === 0 ? null : distinctVerified.length,
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
