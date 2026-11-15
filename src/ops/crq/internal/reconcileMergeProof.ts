/** Merge proof selection and revalidation recheck for a merged fix PR
 * (`proveMerge` and `recheckRevalidation` of `ReconcileFixRunEffects`).
 *
 * Port of the proof selection in `repair_tick.reconcile_fix_prs`: canonical terminal
 * ledger truth first, then a saved journal revalidation, then merge-head evidence.
 * It reuses `canonicalFixedEvents`, `validateFixedPublicationEvidence` and
 * `mergeHeadEvidence`; every read is injected. Not wired into a tick.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { sourcePath } from '../../../policy/crq/repairBinding.js';
import { fromPlainJson, pyTruthy, pythonValueEqual } from '../../../policy/crq/queueDoc.js';
import type { RunGit } from '../../../adapters/crq/ledgerGit.js';
import { canonicalFixedEvents, type CanonicalFixedEventsEffects } from './canonicalFixedEvents.js';
import {
  validateFixedPublicationEvidence,
  type FixedEvidenceEffects,
} from './fixedPublicationEvidence.js';
import { mergeHeadEvidence } from './mergeHeadEvidence.js';
import type { MergeProof } from './reconcileFixRun.js';

export interface MergeProofContext {
  readonly itemId: string;
  readonly run: string;
}
export interface MergeProofEffects {
  readonly canonical: CanonicalFixedEventsEffects;
  readonly evidence: FixedEvidenceEffects;
  readonly git: RunGit;
  /** `STATE/repair/<first job>/publication.json`; null when the file is absent. */
  readSavedJournal(firstJob: string): Promise<JsonObject | null>;
  /** Fresh budgeted `gh pr view`. */
  prInfo(number: JsonValue): Promise<JsonObject>;
}

const object = (value: JsonValue | undefined): JsonObject =>
  value instanceof JsonObject ? value : new JsonObject([]);
const strings = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : '')) : [];

function fixedJobs(record: JsonObject): string[] {
  const verdicts = record.get('verdicts');
  const jobs: string[] = [];
  for (const v of Array.isArray(verdicts) ? verdicts : [])
    if (v instanceof JsonObject && v.get('verdict') === 'FIXED' && typeof v.get('job') === 'string')
      jobs.push(v.get('job') as string);
  return jobs;
}
function firstJob(record: JsonObject): string {
  const jobs = record.get('jobs');
  const first = Array.isArray(jobs) ? jobs[0] : undefined;
  if (typeof first !== 'string') throw new Error('repair record has no jobs');
  return first;
}

/** `repair_tick.publication_journal`: identity of the saved journal against the record. */
function checkJournal(record: JsonObject, saved: JsonObject): void {
  const publication = object(record.get('publication'));
  for (const key of ['head', 'commits', 'target', 'branch', 'open_pr'])
    if (!pythonValueEqual(saved.get(key) ?? null, publication.get(key) ?? null))
      throw new Error('publication journal identity mismatch');
  if (
    (publication.get('fixed_revalidation') ?? null) !== null &&
    !pyTruthy(saved.get('fixed_revalidation'))
  )
    throw new Error('publication revalidation missing from journal');
  const have = saved.get('source_resolutions');
  const want = publication.get('source_resolutions');
  for (const id of Array.isArray(want) ? want : [])
    if (!(Array.isArray(have) ? have : []).some((v) => pythonValueEqual(v, id)))
      throw new Error('publication resolutions contradict journal');
}
export async function savedJournal(
  record: JsonObject,
  effects: MergeProofEffects,
): Promise<JsonObject> {
  const saved = await effects.readSavedJournal(firstJob(record));
  if (saved === null) throw new Error('publication journal missing');
  checkJournal(record, saved);
  return saved;
}

/** `repair_tick.fixed_publication_evidence` for the merged PR `info`. */
export async function validateFixedEvidence(
  context: MergeProofContext,
  record: JsonObject,
  info: JsonObject,
  evidence: JsonValue,
  effects: MergeProofEffects,
): Promise<void> {
  const fixed = fixedJobs(record);
  if (
    fixed.length !== 1 ||
    record.get('state') !== 'published' ||
    pyTruthy(record.get('fix_merged'))
  )
    throw new Error('expected one unresolved published FIXED job');
  const jobId = fixed[0]!;
  const job = await effects.evidence.readJob(jobId);
  if (
    job.get('job') !== jobId ||
    job.get('item') !== context.itemId ||
    job.get('run') !== context.run ||
    !strings(record.get('jobs')).includes(jobId)
  )
    throw new Error('legacy repair job identity mismatch');
  const publication = object(record.get('publication'));
  const merge = object(info.get('mergeCommit')).get('oid');
  const published = publication.get('head');
  const actual = info.get('headRefOid');
  await validateFixedPublicationEvidence(
    {
      jobId,
      itemId: context.itemId,
      run: context.run,
      number: object(record.get('fix_pr')).get('number') ?? null,
      published: typeof published === 'string' ? published : '',
      actual: typeof actual === 'string' ? actual : '',
      merge: typeof merge === 'string' ? merge : '',
      commits: strings(publication.get('commits')),
      pr: info,
      evidence,
    },
    effects.evidence,
  );
}

export async function canonicalProof(
  record: JsonObject,
  info: JsonObject,
  effects: MergeProofEffects,
): Promise<JsonObject | null> {
  const published = object(record.get('publication')).get('head');
  const projection = await canonicalFixedEvents(
    {
      fixedJobs: fixedJobs(record),
      recordJobs: strings(record.get('jobs')),
      publishedHead: typeof published === 'string' && published ? published : undefined,
      fixPrNumber: object(record.get('fix_pr')).get('number') ?? null,
      pr: info,
    },
    effects.canonical,
  );
  if (projection === null) return null;
  return new JsonObject([
    ['published_head', projection.publishedHead],
    ['actual_head', projection.actualHead],
    [
      'canonical_fixed_events',
      new JsonObject([...projection.events.entries()].map(([k, v]) => [k, v])),
    ],
  ]);
}

/** The `try` block that selects the merge proof; throws when none is valid. */
export async function proveMerge(
  context: MergeProofContext,
  record: JsonObject,
  info: JsonObject,
  effects: MergeProofEffects,
): Promise<MergeProof> {
  const projected = await canonicalProof(record, info, effects);
  if (projected !== null) {
    const again = await canonicalProof(record, info, effects);
    if (again === null || !ledgerValueEqual(projected, again))
      throw new Error('canonical fixed finding changed before source feedback');
    return { proof: projected, projected: true };
  }
  const publication = record.get('publication');
  const saved = pyTruthy(publication) ? await effects.readSavedJournal(firstJob(record)) : null;
  const evidence = saved?.get('fixed_revalidation');
  if (evidence !== undefined && pyTruthy(evidence)) {
    await savedJournal(record, effects);
    await validateFixedEvidence(context, record, info, evidence, effects);
    return { proof: new JsonObject([['fixed_revalidation', evidence]]), projected: false };
  }
  const published = object(publication).get('head');
  const actual = info.get('headRefOid');
  const fixed = fixedJobs(record);
  const anchors: string[] = [];
  for (const id of fixed) {
    const path = sourcePath((await effects.evidence.readJob(id)).get('finding') ?? null);
    if (!path.ok) throw new Error('invalid repair source path');
    if (!anchors.includes(path.path)) anchors.push(path.path);
  }
  const proof = await mergeHeadEvidence(
    {
      published: typeof published === 'string' && published ? published : undefined,
      actual: typeof actual === 'string' ? actual : '',
      commits: strings(object(publication).get('commits')),
      anchors,
    },
    effects.git,
  );
  return {
    proof: proof === null ? null : (fromPlainJson(proof) as JsonObject),
    projected: false,
  };
}

/** The post-proof recheck: journal still holds this revalidation, and a freshly
 * read PR still satisfies it. */
export async function recheckRevalidation(
  context: MergeProofContext,
  record: JsonObject,
  evidence: JsonValue,
  effects: MergeProofEffects,
): Promise<void> {
  const latest = await savedJournal(record, effects);
  if (!ledgerValueEqual(latest.get('fixed_revalidation') ?? null, evidence))
    throw new Error('fixed revalidation changed');
  const fresh = await effects.prInfo(object(record.get('fix_pr')).get('number') ?? null);
  await validateFixedEvidence(context, record, fresh, evidence, effects);
}
