/** Project existing terminal ledger truth for FIXED repair jobs; never creates a disposition.
 * Port of repair_tick.canonical_fixed_events. All reads are injected.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';

export interface CanonicalFixedEventsEffects {
  readJob(id: string): Promise<JsonObject>;
  triageExists(canonicalId: string): Promise<boolean>;
  currentFixedEvent(job: JsonObject, merge: string | undefined): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}
export interface CanonicalFixedEventsInput {
  /** Job ids whose recorded verdict is FIXED, in record order. */
  readonly fixedJobs: readonly string[];
  /** Every job id the repair record owns. */
  readonly recordJobs: readonly string[];
  readonly publishedHead: string | undefined;
  readonly fixPrNumber: JsonValue;
  readonly pr: JsonObject;
}
export interface CanonicalFixedEventsProjection {
  readonly publishedHead: string;
  readonly actualHead: string;
  readonly events: ReadonlyMap<string, string>;
}

/** Returns null when canonical terminal truth is not (yet) available for every FIXED job;
 * throws when the bound job identity or PR lineage is stale. */
export async function canonicalFixedEvents(
  input: CanonicalFixedEventsInput,
  effects: CanonicalFixedEventsEffects,
): Promise<CanonicalFixedEventsProjection | null> {
  if (!input.fixedJobs.length) return null;
  const jobs: JsonObject[] = [];
  for (const id of input.fixedJobs) jobs.push(await effects.readJob(id));
  for (const job of jobs) {
    const fid = job.get('canonical_finding_id');
    if (
      typeof fid !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fid) ||
      !(await effects.triageExists(fid))
    )
      return null;
  }
  const mergeObject = input.pr.get('mergeCommit');
  const merge =
    mergeObject instanceof JsonObject && typeof mergeObject.get('oid') === 'string'
      ? (mergeObject.get('oid') as string)
      : undefined;
  const events = new Map<string, string>();
  for (const [index, id] of input.fixedJobs.entries()) {
    const job = jobs[index]!;
    if (job.get('job') !== id || !input.recordJobs.includes(id))
      throw new Error('canonical fixed repair job identity mismatch');
    const event = await effects.currentFixedEvent(job, merge);
    if (!event) return null;
    events.set(id, event);
  }
  const actual = input.pr.get('headRefOid');
  if (
    !ledgerValueEqual(input.pr.get('number') ?? null, input.fixPrNumber) ||
    !input.publishedHead ||
    typeof actual !== 'string' ||
    !actual ||
    !(await effects.isAncestor(input.publishedHead, actual))
  )
    throw new Error('canonical fixed repair PR lineage mismatch');
  return { publishedHead: input.publishedHead, actualHead: actual, events };
}
