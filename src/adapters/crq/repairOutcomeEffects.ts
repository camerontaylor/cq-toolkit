/**
 * File-backed `markFindingOutcome` and `recordUnpublishedFixedSibling` for the
 * repair harvest (`repair_tick.mark_finding_outcome`, repair_tick.py:287, and the
 * `needs-human` write of `record_unpublished_siblings`, repair_tick.py:339-421).
 * Inactive: nothing imports this outside tests.
 *
 * Both are thin: they pick the disposition exactly as Python does, then hand
 * the write to {@link FindingDispositions.repairOutcome} (pinned against Python in
 * the findingDisposition vectors) over the file-backed inbox and publication of
 * {@link fileRepairHarvestEffects}. `markFindingOutcome` is called by the harvest
 * without `merge`/`fix_pr`, so a FIXED verdict maps to no action and is a no-op
 * here; the merge path (repair_tick.py:1715) is not part of this effect.
 *
 * Deviations: the job id must be a string and `max_finding_retries` a number.
 * Plain JSON from `readJob`/`readResult` cannot tell `1` from `1.0`, so a float
 * `reason` or `repair_base` that is integral is written as an integer.
 */
import { FindingInbox } from '../../ops/review/internal/crq/findingInbox.js';
import {
  FindingDispositions,
  type FindingArtifactReader,
} from '../../ops/review/internal/crq/findingDisposition.js';
import type { JsonValue } from '../../policy/crq/jsonValue.js';
import { fromPlainJson, pyTruthy } from '../../policy/crq/queueDoc.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import { pyTypeName } from '../../queue-runner/repairProgressSelection.js';
import { fileRepairHarvestEffects } from './repairHarvestSource.js';

type Rec = Record<string, unknown>;

export type FileRepairOutcomeEffects = Pick<
  RepairHarvestEffects,
  'markFindingOutcome' | 'recordUnpublishedFixedSibling'
>;

export interface FileRepairOutcomeInput {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.iso()`, read once per outcome write. */
  readonly iso: () => string;
  /** `c.CONFIG['repair'].get('max_finding_retries', 2)`. */
  readonly maxFindingRetries: number;
}

const FAILURE_CLASSES = ['transient', 'exhausted', 'evidence', 'protected-path', 'owner-decision'];
/** `repair_outcome`'s default `max_finding_retries`, which `record_unpublished_siblings` keeps. */
const DEFAULT_MAX_FINDING_RETRIES = 2;

/** `repair_outcome` never reads an artifact, so any read is a defect. */
const NO_ARTIFACTS: FindingArtifactReader = {
  verify: () => Promise.reject(new Error('repair outcome reads no artifact')),
  read: () => Promise.reject(new Error('repair outcome reads no artifact')),
};

const isDict = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `fid + '.json'`: the first use of a non-string finding id after `Inbox.recover`. */
function concatError(value: unknown): PyError {
  const name = pyTypeName(value);
  return new PyError(
    'TypeError',
    name === 'list'
      ? 'can only concatenate list (not "str") to list'
      : `unsupported operand type(s) for +: '${name}' and 'str'`,
  );
}

function jobIdOf(job: Rec): string {
  if (!Object.hasOwn(job, 'job')) throw new PyError('KeyError', "'job'");
  const id = job['job'];
  if (typeof id !== 'string') {
    throw new PyError('TypeError', `repair job id must be a string, not '${pyTypeName(id)}'`);
  }
  return id;
}

export function fileRepairOutcomeEffects(input: FileRepairOutcomeInput): FileRepairOutcomeEffects {
  const harvest = fileRepairHarvestEffects(input.stateRoot);
  const dispositions = new FindingDispositions(harvest.files, NO_ARTIFACTS);

  /** `inbox.repair_outcome(...)`: `finding_inbox(c)` first, then a non-string id after `recover`. */
  async function write(
    findingId: unknown,
    job: string,
    action: string,
    reason: JsonValue,
    options: {
      sourceEvidence?: JsonValue;
      failureClass: string;
      repairBase: unknown;
      maxFindingRetries: number;
    },
  ): Promise<void> {
    if (typeof findingId !== 'string') {
      await new FindingInbox(harvest.files).recover(await harvest.publication.retained());
      throw concatError(findingId);
    }
    await dispositions.repairOutcome(
      harvest.publication,
      findingId,
      job,
      action,
      reason,
      input.iso(),
      {
        failureClass: options.failureClass,
        repairBase: fromPlainJson(options.repairBase ?? null),
        maxFindingRetries: options.maxFindingRetries,
        ...(options.sourceEvidence === undefined ? {} : { sourceEvidence: options.sourceEvidence }),
      },
    );
  }

  return {
    async markFindingOutcome(job, result) {
      const findingId = job['canonical_finding_id'];
      if (!pyTruthy(findingId)) return;
      if (!Object.hasOwn(result, 'verdict')) throw new PyError('KeyError', "'verdict'");
      const verdict = result['verdict'];
      const rawClass = Object.hasOwn(result, 'failure_class')
        ? result['failure_class']
        : 'exhausted';
      const failureClass =
        typeof rawClass === 'string' && FAILURE_CLASSES.includes(rawClass) ? rawClass : 'exhausted';
      // The dict lookup hashes the verdict before the NOT-FIXED branch reads it.
      if (Array.isArray(verdict) || isDict(verdict)) {
        throw new PyError('TypeError', `unhashable type: '${pyTypeName(verdict)}'`);
      }
      const evidence = result['unchanged_evidence'];
      let action: string | undefined;
      if (verdict === 'STALE') action = 'needs-retriage';
      else if (verdict === 'FAILED')
        action = failureClass === 'owner-decision' ? 'needs-human' : 'needs-retriage';
      else if (verdict === 'NOT-FIXED') {
        action = pyTruthy(evidence)
          ? 'dismissed'
          : failureClass === 'owner-decision'
            ? 'needs-human'
            : 'needs-retriage';
      }
      if (action === undefined) return;
      const reason = pyTruthy(result['reason']) ? result['reason'] : verdict;
      await write(findingId, jobIdOf(job), action, fromPlainJson(reason), {
        failureClass,
        repairBase: job['repair_base'],
        maxFindingRetries: input.maxFindingRetries,
        ...(pyTruthy(evidence) ? { sourceEvidence: fromPlainJson(evidence) } : {}),
      });
    },

    async recordUnpublishedFixedSibling(findingId, jobId, reason, repairBase) {
      await write(findingId, jobId, 'needs-human', reason, {
        failureClass: 'exhausted',
        repairBase,
        maxFindingRetries: DEFAULT_MAX_FINDING_RETRIES,
      });
    },
  };
}
