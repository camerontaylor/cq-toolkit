/** Finding outcome marking and source publication for a merged fix PR
 * (`markFixedOutcome` and `publishSource` of `ReconcileFixRunEffects`).
 *
 * Port of `repair_tick.mark_finding_outcome` (the merged FIXED branch) and
 * `repair_tick.publish_source_resolution`, plus the terminal-truth re-verification that
 * `reconcile_fix_prs` runs between them. Every read and write is injected. Not wired
 * into a tick.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerCanonicalBytes, ledgerLoads } from '../../../policy/crq/ledger.js';
import { planRepairHarvest } from '../../../policy/crq/repairHarvest.js';
import { pyTruthy, pythonValueEqual, withObjectKeys } from '../../../policy/crq/queueDoc.js';
import {
  FindingInbox,
  type FindingInboxFiles,
  type FindingPublication,
} from '../../review/internal/crq/findingInbox.js';
import {
  canonicalProof,
  savedJournal,
  validateFixedEvidence,
  type MergeProofContext,
  type MergeProofEffects,
} from './reconcileMergeProof.js';
import { SourcePublicationFailed, type MergeProof } from './reconcileFixRun.js';

export interface FixedOutcomeEffects {
  readonly files: FindingInboxFiles;
  readonly publication: FindingPublication;
  /** `STATE/repair/inbox/<job>.json`. */
  readJob(jobId: string): Promise<JsonObject>;
  /** `CONFIG['repair'].get('max_finding_retries', 2)`. */
  maxFindingRetries(): number;
  now(): string;
}

/** `mark_finding_outcome(c, job, result, merge, pr.get('url'))` for one FIXED verdict.
 * A job without a canonical finding id writes nothing (threadless truth is elsewhere). */
export async function markFixedOutcome(
  record: JsonObject,
  jobId: string,
  merge: string,
  prUrl: JsonValue,
  proof: JsonObject | null,
  effects: FixedOutcomeEffects,
): Promise<void> {
  const job = await effects.readJob(jobId);
  const findingId = job.get('canonical_finding_id');
  if (!pyTruthy(findingId)) return;
  if (typeof findingId !== 'string') throw new Error('canonical_finding_id must be a string');
  const verdicts = record.get('verdicts');
  const result = (Array.isArray(verdicts) ? verdicts : []).find(
    (v) => v instanceof JsonObject && v.get('job') === jobId,
  );
  if (!(result instanceof JsonObject)) throw new Error('no verdict for FIXED job');
  let reason: JsonValue = result.get('reason') ?? null;
  const revalidation = proof?.get('fixed_revalidation');
  if (revalidation !== undefined) {
    // `{**result, 'reason': proof['fixed_revalidation']['reason']}` raises on a bad shape.
    if (!(revalidation instanceof JsonObject) || !revalidation.has('reason'))
      throw new Error('fixed revalidation has no reason');
    reason = revalidation.get('reason') ?? null;
  }
  const text = pyTruthy(reason) ? reason : 'FIXED';
  if (typeof text !== 'string') throw new Error('outcome reason must be a string');
  const base = job.get('repair_base');
  const url = typeof prUrl === 'string' ? prUrl : prUrl === null ? null : undefined;
  if (url === undefined) throw new Error('fix PR url must be a string');

  const inbox = new FindingInbox(effects.files);
  await inbox.recover(await effects.publication.retained());
  let failure: string | undefined;
  await effects.files.withLock(async () => {
    const retained = await effects.publication.retained();
    const bytes = await effects.files.readTriage(findingId);
    if (bytes === null) {
      failure = 'finding row missing';
      return;
    }
    const row = ledgerLoads(bytes);
    if (!(row instanceof JsonObject)) {
      failure = 'finding row unreadable';
      return;
    }
    const plan = planRepairHarvest({
      row,
      findingId,
      job: jobId,
      verdict: { verdict: 'fixed', commits: [] },
      reason: text,
      at: effects.now(),
      maxFindingRetries: effects.maxFindingRetries(),
      retained,
      ...(typeof base === 'string' && base ? { repairBase: base } : {}),
      fixPr: url,
      mergedCommit: merge,
    });
    if (plan.kind === 'refused') {
      failure = plan.refusal;
      return;
    }
    if (plan.kind !== 'write') return;
    await effects.publication.spool(plan.event);
    await effects.files.writeTriage(findingId, ledgerCanonicalBytes(plan.row));
  });
  if (failure !== undefined) throw new Error(failure);
}

export type SourceThread =
  | { readonly kind: 'found'; readonly id: string }
  /** REST shows a thread GraphQL `reviewThreads` does not yet expose. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'none' };

export interface SourcePublishEffects extends MergeProofEffects {
  readJob(jobId: string): Promise<JsonObject>;
  /** Atomic `STATE/repair/<first job>/publication.json`. */
  writeJournal(firstJob: string, publication: JsonObject): Promise<void>;
  /** Paginated issue comments of the source PR contain `marker`. */
  hasSourceComment(pr: JsonValue, marker: string): Promise<boolean>;
  /** Write `source-<job>.md` beside the journal and `gh pr comment` it. */
  postSourceComment(
    firstJob: string,
    jobId: string,
    pr: JsonValue,
    marker: string,
    merge: string,
  ): Promise<void>;
  /** `source_thread`, then `rest_source_thread` when none is found. */
  sourceThread(job: JsonObject): Promise<SourceThread>;
  /** Write `resolve-<job>.json`, run the GraphQL mutation; true only when confirmed resolved. */
  resolveSourceThread(firstJob: string, jobId: string, threadId: string): Promise<boolean>;
}

/** `publish_source_resolution`: resume source comments and thread resolutions from the
 * journal. Any failure carries the publication as mutated so far. */
async function publishResolutions(
  record: JsonObject,
  publication: JsonObject,
  merge: string,
  effects: SourcePublishEffects,
): Promise<{ pending: boolean; publication: JsonObject }> {
  const jobs = record.get('jobs');
  const first = Array.isArray(jobs) ? jobs[0] : undefined;
  if (typeof first !== 'string') throw new Error('repair record has no jobs');
  const existing = publication.get('source_resolutions');
  const completed: JsonValue[] = Array.isArray(existing) ? [...existing] : [];
  const current = (): JsonObject =>
    withObjectKeys(publication, [['source_resolutions', completed]]);
  let pending = false;
  try {
    const verdicts = record.get('verdicts');
    for (const result of Array.isArray(verdicts) ? verdicts : []) {
      if (!(result instanceof JsonObject) || result.get('verdict') !== 'FIXED') continue;
      const id = result.get('job') ?? null;
      if (completed.some((v) => pythonValueEqual(v, id))) continue;
      if (typeof id !== 'string') throw new Error('FIXED verdict has no job id');
      const job = await effects.readJob(id);
      const pr = job.get('pr') ?? null;
      if (!pyTruthy(pr)) continue; // Threadless source truth is the finding ledger.
      const marker = `<!-- crq-repair-source:${id} -->`;
      if (!(await effects.hasSourceComment(pr, marker)))
        await effects.postSourceComment(first, id, pr, marker, merge);
      const thread = await effects.sourceThread(job);
      if (thread.kind === 'found') {
        if (!(await effects.resolveSourceThread(first, id, thread.id)))
          throw new Error('source thread resolution unconfirmed');
      } else if (thread.kind === 'pending') {
        pending = true;
        continue; // Keep feedback pending for retry.
      }
      completed.push(id);
      await effects.writeJournal(first, current());
    }
  } catch (error) {
    throw new SourcePublicationFailed(
      error instanceof Error ? error.message : String(error),
      current(),
    );
  }
  return { pending, publication: current() };
}

/** The try block after the outcome marking in `reconcile_fix_prs`: re-verify terminal
 * truth, adopt the journalled publication, then publish. Plain errors leave the
 * record's publication untouched; a failure inside the resolutions is a
 * `SourcePublicationFailed` carrying the latched publication. */
export async function publishSource(
  context: MergeProofContext,
  record: JsonObject,
  info: JsonObject,
  merged: MergeProof,
  merge: string,
  effects: SourcePublishEffects,
): Promise<{ readonly pending: boolean; readonly publication?: JsonValue }> {
  const proof = merged.proof;
  if (merged.projected) {
    const again = await canonicalProof(record, info, effects);
    if (again === null || proof === null || !pythonValueEqual(again, proof))
      throw new Error('canonical fixed finding changed before source feedback');
  }
  let publication: JsonValue | undefined = record.get('publication');
  const evidence = proof?.get('fixed_revalidation');
  if (proof !== null && evidence !== undefined) {
    const latest = await savedJournal(record, effects);
    if (!pythonValueEqual(latest.get('fixed_revalidation') ?? null, evidence))
      throw new Error('fixed revalidation changed before source feedback');
    const number =
      (record.get('fix_pr') instanceof JsonObject
        ? (record.get('fix_pr') as JsonObject).get('number')
        : undefined) ?? null;
    const fresh = await effects.prInfo(number);
    const terminal = await canonicalProof(record, fresh, effects);
    if (terminal === null) await validateFixedEvidence(context, record, fresh, evidence, effects);
    else if (!pythonValueEqual(fresh, info))
      throw new Error('repair PR changed during revalidation');
    publication = latest;
  }
  if (!pyTruthy(publication)) return { pending: false };
  if (!(publication instanceof JsonObject)) throw new Error('publication must be an object');
  const done = await publishResolutions(record, publication, merge, effects);
  return { pending: done.pending, publication: done.publication };
}
