/** Revalidate merged-current repair evidence against the current target tip. */
import { JsonObject, parseJsonValue, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { receiptJsonDigest, sha256Hex } from '../../../policy/crq/pythonJson.js';
import {
  pyTruthy,
  pythonValueEqual,
  withObjectKeys,
  withoutObjectKey,
} from '../../../policy/crq/queueDoc.js';
import { remediationFixed } from '../../../policy/crq/queueReceipt.js';
import { RefreshExhausted } from '../../../policy/crq/forgeBudget.js';

export interface CurrentRepairEffects {
  readReceipt(id: string): Promise<Uint8Array | null>;
  prInfo(number: JsonValue): Promise<JsonObject>;
  targetRef(selector: string): string;
  resolveRef(ref: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface CurrentRepairResult {
  readonly item: JsonObject;
  readonly starved: number;
  readonly deferred: number;
  readonly errors: readonly string[];
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sortedDigests(values: readonly JsonValue[]): string[] {
  return values.map((value) => receiptJsonDigest(value)).sort();
}

/**
 * Python's reconcile_current_fix. The caller must install the returned item in
 * its tick-owned queue before persisting it. No prior remediation is trusted:
 * every pass rechecks ancestry against the observed target tip.
 */
export async function reconcileCurrentRepair(
  original: JsonObject,
  effects: CurrentRepairEffects,
): Promise<CurrentRepairResult> {
  let item = withoutObjectKey(original, 'remediation');
  if (item.get('remediation_state') === 'fixed') {
    item = withObjectKeys(item, [['remediation_state', 'pending-merged-evidence']]);
  }
  let starved = 0;
  let deferred = 0;
  const errors: string[] = [];
  const result = (): CurrentRepairResult => ({ item, starved, deferred, errors });
  const id = text(item.get('receipt_id'));
  const runs = item.get('repair_runs');
  if (!id || !(runs instanceof JsonObject)) return result();
  const eligible = runs.entries.filter(
    ([, value]) =>
      value instanceof JsonObject &&
      value.get('receipt_id') === id &&
      value.get('state') === 'published' &&
      !pyTruthy(value.get('not_fixed')),
  );
  if (eligible.length === 0) return result();
  let doc: JsonValue;
  try {
    const bytes = await effects.readReceipt(id);
    if (bytes === null || sha256Hex(bytes) !== id) return result();
    doc = parseJsonValue(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return result();
  }
  if (!(doc instanceof JsonObject)) return result();
  const findings = doc.get('findings');
  const capture = doc.get('capture');
  if (!Array.isArray(findings) || !(capture instanceof JsonObject)) return result();
  const subject = item.get('subject');
  if (!(subject instanceof JsonObject)) return result();
  const selector = text(subject.get('target_selector'));
  if (selector === undefined) return result();
  const receiptFindings = sortedDigests(findings);
  for (const [run, value] of eligible) {
    if (!(value instanceof JsonObject)) continue;
    let record = value;
    const pr = record.get('fix_pr');
    const publication = record.get('publication');
    const verdicts = record.get('verdicts');
    const jobs = record.get('jobs');
    if (
      !(pr instanceof JsonObject) ||
      !(publication instanceof JsonObject) ||
      !Array.isArray(verdicts) ||
      verdicts.length === 0 ||
      !Array.isArray(jobs) ||
      jobs.some((job) => typeof job !== 'string') ||
      verdicts.some((v) => !(v instanceof JsonObject) || v.get('verdict') !== 'FIXED') ||
      verdicts.some((v) => typeof (v as JsonObject).get('job') !== 'string') ||
      !pythonValueEqual(
        verdicts.map((v) => (v as JsonObject).get('job')).sort(),
        [...jobs].sort(),
      ) ||
      !pythonValueEqual(
        sortedDigests(verdicts.map((v) => (v as JsonObject).get('finding') ?? null)),
        record.get('repair_findings'),
      ) ||
      verdicts.length !== findings.length ||
      !pythonValueEqual(receiptFindings, record.get('receipt_findings'))
    )
      continue;
    const number = pr.get('number');
    if (number === undefined || number === null) continue;
    let info = record.get('merged_fix');
    if (!(info instanceof JsonObject)) {
      try {
        info = await effects.prInfo(number);
      } catch (error) {
        if (error instanceof RefreshExhausted) starved += 1;
        else deferred += 1;
        if (errors.length < 2)
          errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        continue;
      }
    }
    const state = info.get('state');
    const head = text(info.get('headRefOid'));
    const published = text(publication.get('head'));
    const rejected = state === 'CLOSED' || (state === 'MERGED' && head !== published);
    if (rejected) {
      record = withObjectKeys(record, [
        [
          'not_fixed',
          new JsonObject([
            ['pr', number],
            ['state', state ?? null],
            ['head', info.get('headRefOid') ?? null],
            ['reason', 'closed-or-head-mismatch'],
          ]),
        ],
      ]);
    } else if (state === 'MERGED' && pythonValueEqual(info.get('number'), number)) {
      record = withObjectKeys(record, [['merged_fix', info]]);
    }
    item = withObjectKeys(item, [
      ['repair_runs', withObjectKeys(item.get('repair_runs') as JsonObject, [[run, record]])],
    ]);
    if (rejected) continue;
    let ref: string;
    let target: string;
    try {
      ref = effects.targetRef(selector);
      target = await effects.resolveRef(ref);
    } catch (error) {
      if (error instanceof RefreshExhausted) starved += 1;
      else {
        deferred += 1;
        item = withObjectKeys(item, [
          ['repair_error', (error instanceof Error ? error.message : String(error)).slice(0, 300)],
        ]);
      }
      if (errors.length < 2)
        errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return result();
    }
    const mergeValue = info.get('mergeCommit');
    const merge = mergeValue instanceof JsonObject ? text(mergeValue.get('oid')) : undefined;
    const captureTarget = text(capture.get('target'));
    const publicationTarget = text(publication.get('target'));
    if (
      state !== 'MERGED' ||
      !pythonValueEqual(info.get('number'), number) ||
      info.get('baseRefName') !== ref.replace(/^origin\//, '') ||
      head !== published ||
      !merge ||
      !captureTarget ||
      !publicationTarget
    )
      continue;
    let ancestry = false;
    try {
      if (merge && captureTarget && publicationTarget) {
        ancestry =
          (await effects.isAncestor(merge, target)) &&
          (await effects.isAncestor(captureTarget, publicationTarget));
      }
    } catch (error) {
      if (error instanceof RefreshExhausted) starved += 1;
      else deferred += 1;
      if (errors.length < 2)
        errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      continue;
    }
    if (!ancestry) continue;
    const evidence = new JsonObject([
      ['receipt_id', id],
      ['subject', subject],
      ['capture_digest', receiptJsonDigest(capture)],
      ['findings', receiptFindings],
      ['fix_pr', number],
      ['merge', merge],
      ['head', head ?? null],
      ['target', target],
    ]);
    const candidate = withObjectKeys(item, [['remediation', evidence]]);
    if (remediationFixed(candidate, doc, id)) {
      item = withObjectKeys(candidate, [['remediation_state', 'fixed']]);
      return result();
    }
  }
  return result();
}
