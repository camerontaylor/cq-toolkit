/** Advance one fix PR that may have merged outside the runner
 * (the `fix_pr` branch of `repair_tick.reconcile_fix_prs`).
 *
 * Every read and write beyond the queue record is injected, so this module
 * imports nothing from the proof, publication or feedback executors. It
 * returns the updated item instead of mutating it; the caller persists it.
 * An `error` result carries the record state Python would have left in place
 * when the exception was swallowed, so the caller can persist it and then
 * count `error` with `recordSwallowed`.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { recordGet, withObjectKeys, withoutObjectKey } from '../../../policy/crq/queueDoc.js';

export interface MergeProof {
  /** Proof object; carries `fixed_revalidation` when legacy evidence bound it. */
  readonly proof: JsonObject | null;
  /** True when canonical terminal ledger truth projected it (no outcome is appended). */
  readonly projected: boolean;
}
export interface ReconcileFixRunEffects {
  prInfo(number: JsonValue): Promise<JsonObject>;
  /** `git rev-parse DEFAULT_REF`. */
  defaultTip(): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  now(): string;
  /** Select canonical, revalidated or merge-head proof; throws when none is valid. */
  proveMerge(record: JsonObject, info: JsonObject, merge: string): Promise<MergeProof>;
  /** Re-check the journalled revalidation against a freshly read PR. */
  recheckRevalidation(record: JsonObject, info: JsonObject, evidence: JsonValue): Promise<void>;
  /** `mark_finding_outcome` for one FIXED job; not called for a projected proof. */
  markFixedOutcome(
    job: string,
    merge: string,
    prUrl: JsonValue,
    proof: JsonObject | null,
  ): Promise<void>;
  /** Re-verify terminal truth, then post feedback; `pending` leaves the run for the next tick. */
  publishSource(
    record: JsonObject,
    info: JsonObject,
    proof: MergeProof,
    merge: string,
  ): Promise<{ readonly pending: boolean; readonly publication?: JsonValue }>;
}
export type ReconcileFixRunResult =
  | { readonly kind: 'projected' | 'pending' | 'skipped' | 'closed'; readonly item: JsonObject }
  | { readonly kind: 'error'; readonly item: JsonObject; readonly error: unknown };

const message = (error: unknown): string =>
  Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 300)
    .join('');

function put(item: JsonObject, run: string, record: JsonObject): JsonObject {
  const runs = item.get('repair_runs');
  return withObjectKeys(item, [
    [
      'repair_runs',
      withObjectKeys(runs instanceof JsonObject ? runs : new JsonObject([]), [[run, record]]),
    ],
  ]);
}

export async function reconcileFixRun(
  item: JsonObject,
  run: string,
  effects: ReconcileFixRunEffects,
): Promise<ReconcileFixRunResult> {
  const runs = item.get('repair_runs');
  const original = runs instanceof JsonObject ? runs.get(run) : undefined;
  if (!(original instanceof JsonObject)) throw new Error('repair run record missing');
  const fixPr = original.get('fix_pr');
  if (!(fixPr instanceof JsonObject)) throw new Error('repair run has no fix PR');
  const number = fixPr.get('number');
  if (number === undefined) throw new Error('repair run fix PR number missing');
  // A forge failure leaves the record untouched; the caller counts it.
  const info = await effects.prInfo(number);
  const state = info.get('state') ?? null;
  let record = withObjectKeys(original, [['fix_pr', withObjectKeys(fixPr, [['state', state]])]]);
  if (state === 'CLOSED') {
    // Terminal marker: an abandoned fix PR must not cost a forge call per tick.
    record = withObjectKeys(record, [['fix_closed', effects.now()]]);
    return { kind: 'closed', item: put(item, run, record) };
  }
  const mergeCommit = info.get('mergeCommit');
  const merge =
    state === 'MERGED' && mergeCommit instanceof JsonObject ? mergeCommit.get('oid') : undefined;
  if (state !== 'MERGED' || typeof merge !== 'string' || !merge)
    return { kind: 'skipped', item: put(item, run, record) };
  if (!(await effects.isAncestor(merge, await effects.defaultTip())))
    return { kind: 'skipped', item: put(item, run, record) };

  const failed = (
    error: unknown,
    record_: JsonObject,
    itemValue: JsonObject,
    publication: boolean,
  ): ReconcileFixRunResult => {
    const saved = publication
      ? withObjectKeys(record_, [['source_publication_error', message(error)]])
      : record_;
    return { kind: 'error', item: put(itemValue, run, saved), error };
  };
  let merged: MergeProof;
  try {
    merged = await effects.proveMerge(record, info, merge);
    if (merged.proof?.has('fixed_revalidation'))
      await effects.recheckRevalidation(
        record,
        info,
        merged.proof.get('fixed_revalidation') ?? null,
      );
  } catch (error) {
    return failed(error, record, item, true);
  }
  if (merged.proof !== null)
    record = withObjectKeys(record, [
      ['validated_merge_head', withObjectKeys(merged.proof, [['merge_commit', merge]])],
    ]);
  let current = item;
  try {
    const verdicts = recordGet(record, 'verdicts');
    const fixed = new Set<string>();
    for (const v of Array.isArray(verdicts) ? verdicts : [])
      if (
        v instanceof JsonObject &&
        v.get('verdict') === 'FIXED' &&
        typeof v.get('job') === 'string'
      )
        fixed.add(v.get('job') as string);
    const jobs = record.get('jobs');
    const resolved = new Set<string>();
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (typeof job !== 'string' || !fixed.has(job)) continue;
      if (!merged.projected)
        await effects.markFixedOutcome(job, merge, fixPr.get('url') ?? null, merged.proof);
      resolved.add(job);
    }
    const blocking = current.get('blocking');
    if (Array.isArray(blocking) && resolved.size)
      current = withObjectKeys(current, [
        [
          'blocking',
          blocking.map((b) =>
            b instanceof JsonObject &&
            typeof b.get('repair_job') === 'string' &&
            resolved.has(b.get('repair_job') as string)
              ? withObjectKeys(b, [
                  [
                    'resolution',
                    new JsonObject([
                      ['fix_pr', number],
                      ['merge', merge],
                      ['at', effects.now()],
                    ]),
                  ],
                ])
              : b,
          ),
        ],
      ]);
  } catch (error) {
    // Uncaught in Python: partial state stays, no source_publication_error.
    return failed(error, record, current, false);
  }
  let outcome: { readonly pending: boolean; readonly publication?: JsonValue };
  try {
    outcome = await effects.publishSource(record, info, merged, merge);
  } catch (error) {
    return failed(error, record, current, true);
  }
  record = withoutObjectKey(record, 'source_publication_error');
  if (outcome.publication !== undefined)
    record = withObjectKeys(record, [['publication', outcome.publication]]);
  // REST-visible source thread still lagging in GraphQL: retry next tick.
  if (outcome.pending) return { kind: 'pending', item: put(current, run, record) };
  record = withObjectKeys(record, [['fix_merged', effects.now()]]);
  return { kind: 'projected', item: put(current, run, record) };
}
