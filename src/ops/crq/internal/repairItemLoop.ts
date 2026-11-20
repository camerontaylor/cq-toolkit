/**
 * The serial per-item loop of the repair service (Python `crq_repair.process_item`
 * and `finding_order`, lines 780-786 and 1357-1393).
 *
 * One drain worker owns one item. Its jobs (findings) run strictly one after
 * another, each in its own worktree, and a FIXED job's last commit becomes the
 * base the next job of the same run starts from. Everything the loop touches is
 * injected (the admission marker, the GLM blackout, the provider pause, the
 * canonical triage row, the pending test, the worktree and the job runner), so
 * the module forks nothing, reads no file and calls no provider. It is an inert
 * port: `RepairDrainEffects.processItem` is not bound to it here.
 *
 * Per job, in Python's order (each refusal ends the loop at that point and the
 * next job is never started; the in-flight job is never interrupted):
 *
 * 1. runner-disabled marker -> narrate, publish a refusal, outcome `runner-disabled`;
 * 2. GLM blackout (or a dispatch that would reach it) -> stop quietly, no outcome;
 * 3. provider pause -> outcome `rate-limit`;
 * 4. canonical delivery (`bounded.require_canonical_delivery`) -> a `ValueError`
 *    skips only this job, narrated `repair <job>: skipped: <reason>`;
 * 5. base chaining: `bases[run]` (the tip of the run's successful chain) replaces
 *    the job's `repair_base`;
 * 6. a worktree is added only for a still-pending job whose path is absent;
 * 7. the job runs. A pause that appeared meanwhile ends the pass with `rate-limit`
 *    even when the job deferred; otherwise a result carrying a truthy `retry_after`
 *    stops the item without an outcome, and `FIXED` records the chain tip.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { checkCanonicalFindingId, pythonTruthy } from '../../../policy/crq/repairBinding.js';
import { canonicalDeliveryRefusal } from '../../../policy/crq/repairGates.js';
import { CANONICAL_REASON } from '../../../policy/crq/repairSelection.js';
import { admit, RUNNER_DISABLED_OUTCOME, type PassGateEffects } from './repairPassGates.js';

/** What `process_item` needs from `RepairDrainEffects.processItem`'s second argument. */
export interface RepairItemContext {
  /** Python `publish_refusal()`: a no-op outside a worker. */
  publishRefusal(): void;
}

export interface RepairItemEffects extends PassGateEffects {
  /** `blocked(config['repair'])`: the GLM peak blackout, or a dispatch that would reach it. */
  blocked(): boolean;
  /** `dispatch_paused(config)`: the pause text while a provider pause is live. */
  dispatchPaused(): Promise<string | null>;
  /**
   * Text of `state/backfill/findings/triage/<id>.json`, or `undefined` when it
   * cannot be read. Only ever called with an id that matches the canonical grammar.
   */
  readTriageRow(findingId: string): Promise<string | undefined>;
  /** `pending`: true unless the job has a terminal, non-deferred result. */
  pending(jobId: string): Promise<boolean>;
  /** `Path(config['worktree_root']) / name`. */
  worktreePath(name: string): string;
  /** `wt.exists()`. */
  worktreeExists(path: string): Promise<boolean>;
  /** `git worktree add --detach <path> <base>` in the clone; the exit status. */
  addWorktree(path: string, base: string): Promise<number>;
  /** `process(config, job, wt)`: one job's result dict. */
  process(job: JsonObject, worktree: string): Promise<JsonObject>;
}

/** A Python `KeyError`/`TypeError`/`IndexError` escaping `process_item`; the drain narrates it. */
export class RepairItemShapeError extends Error {
  override readonly name = 'RepairItemShapeError';
}

function shape(message: string): RepairItemShapeError {
  return new RepairItemShapeError(message);
}

function requireKey(object: JsonObject, key: string): JsonValue {
  const value = object.get(key);
  if (value === undefined) throw shape(`KeyError: '${key}'`);
  return value;
}

function requireString(object: JsonObject, key: string): string {
  const value = requireKey(object, key);
  if (typeof value !== 'string') throw shape(`${key} is not a string`);
  return value;
}

/** Sort key of `finding_order`: `(severity == 'minor', run, finding number)`. */
interface FindingKey {
  readonly minor: boolean;
  readonly run: JsonValue;
  readonly number: bigint;
}

/**
 * `finding_order`. Review jobs end in `-F<n>`; backfill jobs
 * (`crq-backfill-<key>`) carry none and sort as 0. `suffix.isdigit()` is ASCII
 * here because the drain only hands over ids `repair.JOB_ID` already accepted.
 */
function findingKey(job: JsonObject): FindingKey {
  const jobId = requireString(job, 'job');
  const split = jobId.lastIndexOf('-F');
  const suffix = split >= 0 ? jobId.slice(split + 2) : undefined;
  const number = suffix !== undefined && /^[0-9]+$/.test(suffix) ? BigInt(suffix) : 0n;
  // `job.get('finding', {}).get('severity')`: a present non-object finding has no `.get`.
  const finding = job.has('finding') ? (job.get('finding') as JsonValue) : new JsonObject([]);
  if (!(finding instanceof JsonObject)) throw shape('finding has no attribute get');
  const run = requireKey(job, 'run');
  return { minor: finding.get('severity') === 'minor', run, number };
}

/** Python tuple ordering over the key; a run that is not a string cannot be ordered. */
function compareKeys(left: FindingKey, right: FindingKey): number {
  if (left.minor !== right.minor) return left.minor ? 1 : -1;
  if (left.run !== right.run) {
    if (typeof left.run !== 'string' || typeof right.run !== 'string') {
      throw shape("'<' not supported between non-string runs");
    }
    const order = compareCodePoints(left.run, right.run);
    if (order !== 0) return order;
  }
  return left.number < right.number ? -1 : left.number > right.number ? 1 : 0;
}

/**
 * `jobs.sort(key=finding_order)`: critical/major before minor, then by run, then
 * by finding number; stable, in place. Python computes every key before sorting,
 * so a malformed job raises even when it is alone.
 */
export function sortFindings(jobs: JsonObject[]): void {
  const keyed = jobs.map((job) => ({ job, key: findingKey(job) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  keyed.forEach((entry, index) => {
    jobs[index] = entry.job;
  });
}

/** `job['repair_base'] = base`: a copy with the key replaced in place (appended if absent). */
function withRepairBase(job: JsonObject, base: JsonValue): JsonObject {
  if (!job.has('repair_base')) return new JsonObject([...job.entries, ['repair_base', base]]);
  return new JsonObject(
    job.entries.map(([key, value]) => [key, key === 'repair_base' ? base : value]),
  );
}

/** `require_canonical_delivery`'s `ValueError` text, or `undefined` when the job may run. */
async function canonicalDeliveryReason(
  job: JsonObject,
  effects: RepairItemEffects,
): Promise<string | undefined> {
  const findingId = job.get('canonical_finding_id');
  // The policy refuses a malformed id before it looks at the row, so the row is
  // never read (and no path is built) from an id outside the grammar.
  const rowText = checkCanonicalFindingId(findingId)
    ? await effects.readTriageRow(findingId)
    : undefined;
  const refusal = canonicalDeliveryRefusal({ rowText, job });
  if (refusal === undefined) return undefined;
  if (refusal in CANONICAL_REASON)
    return CANONICAL_REASON[refusal as keyof typeof CANONICAL_REASON];
  throw shape(`unexpected canonical delivery refusal ${refusal}`);
}

/**
 * `process_item`: each finding has its own worktree; successful commits chain by
 * base. Resolves with Python's admission outcome: `runner-disabled`,
 * `rate-limit`, or `null` when the item ran out of jobs or stopped quietly
 * (blackout, deferred retry). `jobs` is sorted and rebased in place.
 */
export async function processRepairItem(
  jobs: JsonObject[],
  context: RepairItemContext,
  effects: RepairItemEffects,
): Promise<string | null> {
  const first = jobs[0];
  if (first === undefined) throw shape('IndexError: list index out of range');
  const item = requireString(first, 'item');
  sortFindings(jobs);
  const bases = new Map<string, JsonValue>(); // run -> tip of that run's successful chain
  for (let index = 0; index < jobs.length; index += 1) {
    let job = jobs[index] as JsonObject;
    const jobId = requireString(job, 'job');
    // Per-job admission: the in-flight job finishes and the next does not start,
    // so a marker seen between serial jobs of one item stops the rest of that item.
    if (!(await admit({ stage: 'before-job', job: jobId }, effects))) {
      context.publishRefusal();
      return RUNNER_DISABLED_OUTCOME;
    }
    if (effects.blocked()) break; // never start a new finding inside the GLM peak window
    if (await effects.dispatchPaused()) return 'rate-limit'; // no model call while the pause marker is live
    const unmet = await canonicalDeliveryReason(job, effects);
    if (unmet !== undefined) {
      effects.narrate(`repair ${jobId}: skipped: ${unmet}`);
      continue;
    }
    const run = requireString(job, 'run');
    // `bases.get(run, job['repair_base'])` evaluates the default eagerly.
    const own = requireKey(job, 'repair_base');
    const base = bases.has(run) ? (bases.get(run) as JsonValue) : own;
    job = withRepairBase(job, base);
    jobs[index] = job;
    const worktree = effects.worktreePath(`crq-repair-${item}-${jobId}`);
    if ((await effects.pending(jobId)) && !(await effects.worktreeExists(worktree))) {
      if (typeof base !== 'string') throw shape('repair base is not a string');
      if ((await effects.addWorktree(worktree, base)) !== 0) {
        throw new Error('repair worktree creation failed');
      }
    }
    const result = await effects.process(job, worktree);
    if (await effects.dispatchPaused()) return 'rate-limit';
    if (pythonTruthy(result.get('retry_after'))) break;
    if (requireKey(result, 'verdict') === 'FIXED') {
      const commits = requireKey(result, 'commits');
      if (!Array.isArray(commits) || commits.length === 0) {
        throw shape('IndexError: list index out of range');
      }
      bases.set(run, commits[commits.length - 1] as JsonValue);
    }
  }
  return null;
}
