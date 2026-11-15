/** Proof-gated source feedback. This executor is not wired into a tick or forge. */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { sourcePath } from '../../../policy/crq/repairBinding.js';
import {
  mergeHeadEvidence,
  type MergeHeadInput,
  type MergeHeadProof,
} from './mergeHeadEvidence.js';
import {
  validateFixedPublicationEvidence,
  type FixedEvidenceEffects,
} from './fixedPublicationEvidence.js';

export interface FeedbackJob {
  readonly id: string;
  readonly job: JsonObject;
  /** Source PR, absent for threadless findings. */
  readonly sourcePr?: number;
}
export interface FeedbackPublication {
  readonly identity: JsonObject;
  readonly sourceResolutions: readonly string[];
  readonly fixedRevalidation?: JsonValue;
}
export interface RepairSourceFeedbackEffects extends FixedEvidenceEffects {
  currentFixedEvent(job: JsonObject, merge: string): Promise<string | null>;
  readPr(): Promise<JsonObject>;
  readJournal(): Promise<FeedbackPublication>;
  /** Append a merged outcome using the existing idempotent finding executor. */
  markFixed(job: JsonObject, merge: string, revalidation: JsonValue | undefined): Promise<void>;
  /** Existing journal, atomically replace only after all preceding effects succeed. */
  writeJournal(value: FeedbackPublication): Promise<void>;
  hasSourceComment(pr: number, marker: string): Promise<boolean>;
  postSourceComment(pr: number, marker: string, merge: string): Promise<void>;
  /** Lookup returns 'pending' when REST sees a thread that GraphQL has not yet exposed. */
  sourceThread(
    job: JsonObject,
  ): Promise<{ kind: 'found'; id: string } | { kind: 'pending' } | { kind: 'none' }>;
  resolveSourceThread(id: string): Promise<boolean>;
}
export interface RepairSourceFeedbackInput {
  readonly jobs: readonly FeedbackJob[];
  readonly itemId: string;
  readonly state: string;
  readonly fixMerged: boolean;
  readonly run: string;
  readonly merge: string;
  readonly target: string;
  readonly prNumber: JsonValue;
  readonly pr: JsonObject;
  readonly publication: FeedbackPublication;
  readonly mergeHead: MergeHeadInput;
}
export type RepairSourceFeedbackResult =
  | { readonly kind: 'pending'; readonly publication: FeedbackPublication }
  | {
      readonly kind: 'complete';
      readonly publication: FeedbackPublication;
      readonly proof: MergeHeadProof | JsonValue;
    };

function same(left: JsonValue, right: JsonValue): boolean {
  return ledgerValueEqual(left, right);
}
function checkJournal(expected: FeedbackPublication, actual: FeedbackPublication): void {
  if (
    !same(expected.identity, actual.identity) ||
    expected.sourceResolutions.some((id) => !actual.sourceResolutions.includes(id))
  )
    throw new Error('publication journal identity mismatch');
  if (
    expected.fixedRevalidation !== undefined &&
    (actual.fixedRevalidation === undefined ||
      !same(expected.fixedRevalidation, actual.fixedRevalidation))
  )
    throw new Error('publication revalidation missing or changed in journal');
}

/** Verify proof before any feedback; retries use the existing source-resolution journal.
 * The caller owns the existing tick lock across this operation.
 */
export async function publishRepairSourceFeedback(
  input: RepairSourceFeedbackInput,
  effects: RepairSourceFeedbackEffects,
): Promise<RepairSourceFeedbackResult> {
  if (
    !input.jobs.length ||
    input.state !== 'published' ||
    input.fixMerged ||
    !/^[0-9a-f]{40}$/.test(input.merge) ||
    !/^[0-9a-f]{40}$/.test(input.target) ||
    !/^[0-9a-f]{40}$/.test(input.mergeHead.actual) ||
    !/^[0-9a-f]{40}$/.test(input.mergeHead.published ?? '')
  )
    throw new Error('invalid merged repair');
  if (
    input.publication.identity.get('head') !== input.mergeHead.published ||
    !same(input.publication.identity.get('commits') ?? null, input.mergeHead.commits as JsonValue[])
  )
    throw new Error('publication proof identity mismatch');
  const info = input.pr;
  const merge = info.get('mergeCommit');
  if (
    info.get('state') !== 'MERGED' ||
    !same(info.get('number') ?? null, input.prNumber) ||
    !(merge instanceof JsonObject) ||
    merge.get('oid') !== input.merge ||
    info.get('headRefOid') !== input.mergeHead.actual
  )
    throw new Error('merged repair PR identity mismatch');
  for (const entry of input.jobs) {
    const fresh = await effects.readJob(entry.id);
    const finding = fresh.get('finding');
    const path = sourcePath(finding ?? null);
    if (
      !same(fresh, entry.job) ||
      fresh.get('item') !== input.itemId ||
      fresh.get('run') !== input.run ||
      !path.ok ||
      !input.mergeHead.anchors.includes(path.path)
    )
      throw new Error('repair job or source binding changed');
  }
  const targetLineage = await effects.git([
    'merge-base',
    '--is-ancestor',
    input.merge,
    input.target,
  ]);
  if (targetLineage.code !== 0) throw new Error('merged repair not in target');
  const canonical = async (): Promise<JsonObject | null> => {
    const entries: [string, JsonValue][] = [];
    for (const entry of input.jobs) {
      const job = await effects.readJob(entry.id);
      const pr = job.get('pr');
      if (
        !/^crq-[A-Za-z0-9._-]+$/.test(entry.id) ||
        job.get('job') !== entry.id ||
        !same(job, entry.job) ||
        (entry.sourcePr === undefined
          ? pr !== undefined && pr !== null
          : !(pr instanceof JsonNumber) ||
            !Number.isSafeInteger(entry.sourcePr) ||
            entry.sourcePr <= 0 ||
            pr.integer !== BigInt(entry.sourcePr))
      )
        throw new Error('canonical fixed repair job identity mismatch');
      const id = await effects.currentFixedEvent(job, input.merge);
      if (!id) return null;
      entries.push([entry.id, id]);
    }
    return new JsonObject(entries);
  };
  const validateRevalidation = async (evidence: JsonValue, pr: JsonObject): Promise<void> => {
    if (input.jobs.length !== 1 || !input.mergeHead.published)
      throw new Error('expected one unresolved published FIXED job');
    await validateFixedPublicationEvidence(
      {
        jobId: input.jobs[0]!.id,
        itemId: input.itemId,
        run: input.run,
        number: input.prNumber,
        published: input.mergeHead.published,
        actual: input.mergeHead.actual,
        merge: input.merge,
        commits: input.mergeHead.commits,
        pr,
        evidence,
      },
      effects,
    );
  };
  const initial = await canonical();
  let proof: MergeHeadProof | JsonValue;
  let publication = await effects.readJournal();
  checkJournal(input.publication, publication);
  if (initial !== null) {
    // Canonical terminal truth is not a disposition request; never append an outcome.
    if (
      !/^[0-9a-f]{40}$/.test(input.mergeHead.published ?? '') ||
      !/^[0-9a-f]{40}$/.test(input.mergeHead.actual)
    )
      throw new Error('canonical fixed repair PR lineage mismatch');
    const lineage = await effects.git([
      'merge-base',
      '--is-ancestor',
      input.mergeHead.published ?? '',
      input.mergeHead.actual,
    ]);
    if (!input.mergeHead.published || lineage.code !== 0)
      throw new Error('canonical fixed repair PR lineage mismatch');
    proof = new JsonObject([
      ['canonical_fixed_events', initial],
      ['published_head', input.mergeHead.published],
      ['actual_head', input.mergeHead.actual],
    ]);
  } else {
    const journal = publication;
    if (journal.fixedRevalidation !== undefined) {
      await validateRevalidation(journal.fixedRevalidation, info);
      proof = new JsonObject([['fixed_revalidation', journal.fixedRevalidation]]);
    } else {
      const contained = await mergeHeadEvidence(input.mergeHead, effects.git);
      if (contained === null) throw new Error('merge proof unavailable');
      proof = contained;
    }
  }
  if (initial === null) {
    if (publication.fixedRevalidation !== undefined) {
      const latest = await effects.readJournal();
      checkJournal(publication, latest);
      const fresh = await effects.readPr();
      if (!same(info, fresh)) throw new Error('repair PR changed during revalidation');
      await validateRevalidation(latest.fixedRevalidation!, fresh);
      publication = latest;
    }
    for (const entry of input.jobs)
      await effects.markFixed(entry.job, input.merge, publication.fixedRevalidation);
  } else {
    const current = await canonical();
    if (current === null || !same(initial, current))
      throw new Error('canonical fixed finding changed before source feedback');
  }
  if (initial === null && publication.fixedRevalidation !== undefined) {
    const latest = await effects.readJournal();
    checkJournal(publication, latest);
    const fresh = await effects.readPr();
    if (!same(info, fresh)) throw new Error('repair PR changed during revalidation');
    // The outcome may already have advanced the canonical row to fixed.
    const terminal = await canonical();
    if (terminal === null) await validateRevalidation(latest.fixedRevalidation!, fresh);
    publication = latest;
  }
  const completed = [...publication.sourceResolutions];
  let pending = false;
  for (const entry of input.jobs) {
    if (completed.includes(entry.id) || entry.sourcePr === undefined) continue;
    const marker = `<!-- crq-repair-source:${entry.id} -->`;
    if (!(await effects.hasSourceComment(entry.sourcePr, marker)))
      await effects.postSourceComment(entry.sourcePr, marker, input.merge);
    const thread = await effects.sourceThread(entry.job);
    if (thread.kind === 'pending') {
      // Python (publish_source_resolution) keeps going: later jobs still resolve while this one retries.
      pending = true;
      continue;
    }
    if (thread.kind === 'found' && !(await effects.resolveSourceThread(thread.id)))
      throw new Error('source thread resolution unconfirmed');
    completed.push(entry.id);
    publication = { ...publication, sourceResolutions: [...completed] };
    await effects.writeJournal(publication);
  }
  return pending ? { kind: 'pending', publication } : { kind: 'complete', publication, proof };
}

/** Persist an explicit revalidation only after two semantic observations of the same PR.
 * The caller owns the existing tick lock across this operation.
 */
export async function recordFixedRevalidation(
  input: RepairSourceFeedbackInput,
  evidence: JsonValue,
  effects: RepairSourceFeedbackEffects,
): Promise<FeedbackPublication> {
  if (
    input.state !== 'published' ||
    input.fixMerged ||
    input.jobs.length !== 1 ||
    !input.mergeHead.published
  )
    throw new Error('expected one unresolved published FIXED job');
  if (
    input.publication.identity.get('head') !== input.mergeHead.published ||
    !same(input.publication.identity.get('commits') ?? null, input.mergeHead.commits as JsonValue[])
  )
    throw new Error('publication proof identity mismatch');
  const entry = input.jobs[0]!;
  if (entry.job.get('job') !== entry.id) throw new Error('repair job identity mismatch');
  const journal = await effects.readJournal();
  checkJournal(input.publication, journal);
  const first = await effects.readPr();
  const validate = async (pr: JsonObject): Promise<void> =>
    validateFixedPublicationEvidence(
      {
        jobId: entry.id,
        itemId: input.itemId,
        run: input.run,
        number: input.prNumber,
        published: input.mergeHead.published!,
        actual: input.mergeHead.actual,
        merge: input.merge,
        commits: input.mergeHead.commits,
        pr,
        evidence,
      },
      effects,
    );
  await validate(first);
  const second = await effects.readPr();
  if (!same(first, second)) throw new Error('repair PR changed during revalidation');
  await validate(second);
  const latest = await effects.readJournal();
  checkJournal(journal, latest);
  if (
    latest.fixedRevalidation !== undefined &&
    (journal.fixedRevalidation === undefined ||
      !same(journal.fixedRevalidation, latest.fixedRevalidation))
  )
    throw new Error('publication revalidation changed during validation');
  const saved = { ...latest, fixedRevalidation: evidence };
  await effects.writeJournal(saved);
  return saved;
}
