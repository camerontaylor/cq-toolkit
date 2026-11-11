/**
 * Pure read-gate policy for C1 repair preparation.
 *
 * This module mirrors the remaining read-only half of the Python oracle:
 * exact scan-patch construction, canonical/PR-pin round derivation,
 * canonical handoff and delivery preconditions, and the exact queue mutation
 * as data. It performs no I/O, no clock, no environment read and no spawn.
 * Callers supply every external fact, including the lazy inbox reader.
 *
 * Refusal strings are internal TypeScript literals. They are never persisted
 * and never matched as prose; no JSON schema, state enum, status or action is
 * changed here.
 */
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import { ledgerLoads } from './ledger.js';
import {
  checkCanonicalFindingId,
  pythonTruthy,
  type RepairRefusal,
  type RepairRoundCount,
} from './repairBinding.js';

const INSTRUCTIONS_PATCH_PATH = 'crq-fix-instructions.txt';

/** Python `str.splitlines()` separators, CRLF included. */
function isLineBreak(code: number): boolean {
  return (
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x85 ||
    (code >= 0x1c && code <= 0x1e) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * Python `str.splitlines()`: split on every Unicode line boundary, treat CRLF
 * as one break, and never append an empty trailing line. An empty string has
 * zero lines.
 */
export function pythonSplitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isLineBreak(code)) continue;
    lines.push(text.slice(start, index));
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Python `len(text.splitlines())`. */
export function sourceLineCount(text: string): number {
  return pythonSplitlines(text).length;
}

/** `prepare_current_job`'s full-pinned-source patch, exact bytes. */
export function fullSourceScanPatch(path: string, sourceText: string): string {
  const lines = pythonSplitlines(sourceText);
  return (
    'diff --git a/' +
    path +
    ' b/' +
    path +
    '\n--- /dev/null\n+++ b/' +
    path +
    '\n@@ -0,0 +1,' +
    String(lines.length) +
    ' @@\n' +
    lines.map((line) => `+${line}`).join('\n') +
    '\n'
  );
}

/** `scan_fix_instructions`' patch, exact bytes (`split('\n')`, trailing empty kept). */
export function fixInstructionsScanPatch(instructions: string): string {
  const lines = instructions.split('\n');
  return (
    'diff --git a/' +
    INSTRUCTIONS_PATCH_PATH +
    ' b/' +
    INSTRUCTIONS_PATCH_PATH +
    '\n--- /dev/null\n+++ b/' +
    INSTRUCTIONS_PATCH_PATH +
    '\n@@ -0,0 +1,' +
    String(lines.length) +
    ' @@\n' +
    lines.map((line) => `+${line}`).join('\n') +
    '\n'
  );
}

/**
 * Python's stale-marking predicate and exact error text, or undefined.
 * `preparedJobId` is used only for the error suffix.
 */
export function staleMarkingFor(input: {
  readonly oldJob: JsonObject;
  readonly oldRecord: JsonObject;
  readonly oldJobId: string;
  readonly oldRun: string;
  readonly preparedJobId: string;
  readonly preserveWorktree: boolean;
}): { readonly run: string; readonly state: 'stale'; readonly error: string } | undefined {
  const canonical = input.oldJob.has('canonical_finding_id');
  const jobs = input.oldRecord.get('jobs');
  const singleJob = Array.isArray(jobs) && jobs.length === 1 && jobs[0] === input.oldJobId;
  const state = input.oldRecord.get('state');
  const stateEligible = state === 'queued' || state === 'ready' || state === 'publish_failed';
  if (
    (canonical || input.preserveWorktree) &&
    singleJob &&
    stateEligible &&
    !pythonTruthy(input.oldRecord.get('fix_pr'))
  ) {
    return {
      run: input.oldRun,
      state: 'stale',
      error: `superseded by prepared retry ${input.preparedJobId}`,
    };
  }
  return undefined;
}

export type RoundCountResult =
  | { readonly ok: true; readonly value: RepairRoundCount }
  | { readonly ok: false; readonly refusal: RepairRefusal };

function refusal(value: RepairRefusal): { readonly ok: false; readonly refusal: RepairRefusal } {
  return { ok: false, refusal: value };
}

function objectItems(queue: JsonObject): JsonObject[] | undefined {
  const items = queue.get('items');
  if (!Array.isArray(items)) return undefined;
  const result: JsonObject[] = [];
  for (const item of items) {
    if (!(item instanceof JsonObject)) return undefined;
    result.push(item);
  }
  return result;
}

function repairRuns(item: JsonObject): JsonObject[] | undefined {
  const runs = item.get('repair_runs');
  if (runs === undefined) return [];
  if (!(runs instanceof JsonObject)) return undefined;
  const result: JsonObject[] = [];
  for (const [, record] of runs.entries) {
    if (!(record instanceof JsonObject)) return undefined;
    result.push(record);
  }
  return result;
}

function parseInboxJob(text: string): JsonObject | undefined {
  try {
    const value = ledgerLoads(text);
    return value instanceof JsonObject ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Python scalar equality for the queue fields the round count compares. */
function pythonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined && right === null) return true;
  if (right === undefined && left === null) return true;
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'boolean' && right instanceof JsonNumber) {
    return right.kind === 'int'
      ? right.integer === (left ? 1n : 0n)
      : right.float === (left ? 1 : 0);
  }
  if (typeof right === 'boolean' && left instanceof JsonNumber) {
    return left.kind === 'int'
      ? left.integer === (right ? 1n : 0n)
      : left.float === (right ? 1 : 0);
  }
  if (left instanceof JsonNumber && right instanceof JsonNumber) {
    if (left.kind === 'int' && right.kind === 'int') return left.integer === right.integer;
    if (left.kind === 'float' && right.kind === 'float') return left.float === right.float;
    if (left.kind === 'int') return intEqualsFloat(left.integer, right.float);
    return intEqualsFloat(right.integer, left.float);
  }
  return false;
}

/** Python `int == float`: exact, finite and integral only. */
function intEqualsFloat(integer: bigint | null, float: number | null): boolean {
  if (integer === null || float === null) return false;
  if (!Number.isFinite(float) || !Number.isInteger(float)) return false;
  return BigInt(float) === integer;
}

/**
 * `finding_delivery.canonical_rounds` (canonical branch) or the PR-pin
 * history count. Inbox reads happen lazily inside the loop, in Python's
 * order. Inbox text is parsed with `review_ledger.loads`; a parse or shape
 * failure is `round-history-unreadable`.
 */
export async function deriveRoundCount(input: {
  readonly queue: JsonObject;
  readonly canonicalFindingId?: string;
  readonly pin: string;
  readonly item: JsonObject;
  readonly readInboxJob: (jobId: string) => Promise<string | undefined>;
}): Promise<RoundCountResult> {
  const items = objectItems(input.queue);
  if (items === undefined) return refusal('round-history-unreadable');

  if (input.canonicalFindingId === undefined) {
    const itemPr = input.item.get('pr');
    let count = 0;
    for (const item of items) {
      if (!pythonEquals(item.get('pr'), itemPr)) continue;
      const records = repairRuns(item);
      if (records === undefined) return refusal('round-history-unreadable');
      for (const record of records) {
        if (record.get('pin') === input.pin) count += 1;
      }
    }
    return { ok: true, value: { basis: 'pr-pin', count } };
  }

  let rounds = 0;
  for (const item of items) {
    const records = repairRuns(item);
    if (records === undefined) return refusal('round-history-unreadable');
    const runs = item.get('repair_runs');
    if (!(runs instanceof JsonObject)) continue;
    for (const [, record] of runs.entries) {
      if (!(record instanceof JsonObject)) return refusal('round-history-unreadable');
      if (record.get('pin') !== input.pin) continue;
      let canonical = record.get('canonical_finding_id');
      const jobs = record.get('jobs');
      if (jobs !== undefined && !Array.isArray(jobs)) {
        return refusal('round-history-unreadable');
      }
      for (const oldId of jobs ?? []) {
        if (typeof oldId !== 'string') return refusal('round-history-unreadable');
        let text: string | undefined;
        try {
          text = await input.readInboxJob(oldId);
        } catch {
          return refusal('round-history-unreadable');
        }
        if (text !== undefined) {
          const parsed = parseInboxJob(text);
          if (parsed === undefined) return refusal('round-history-unreadable');
          const fromInbox = parsed.get('canonical_finding_id');
          if (pythonTruthy(fromInbox)) canonical = fromInbox;
        } else if (canonical === undefined || canonical === null) {
          const itemId = item.get('id');
          if (typeof itemId === 'string' && itemId.startsWith('backfill-finding-')) {
            return refusal('round-history-unreadable');
          }
        }
        if (canonical === input.canonicalFindingId) {
          rounds += 1;
          break;
        }
      }
    }
  }
  return { ok: true, value: { basis: 'canonical-finding', count: rounds } };
}

/**
 * `Inbox.handoff`'s precondition. The row is parsed with
 * `review_ledger.loads`. A missing or unreadable row is a typed refusal; a
 * row owned by neither the old task nor the prepared job is a mismatch.
 */
export function canonicalHandoffRefusal(input: {
  readonly rowText: string | undefined;
  readonly job: JsonObject;
  readonly findingId: string;
  readonly previousTask: string;
  readonly preparedJobId: string;
  readonly sourceSha?: string;
}):
  | { readonly ok: true; readonly alreadyHandedOff: boolean }
  | { readonly ok: false; readonly refusal: RepairRefusal } {
  if (
    input.job.get('job') !== input.preparedJobId ||
    input.job.get('canonical_finding_id') !== input.findingId ||
    input.job.get('origin_job') !== input.previousTask ||
    (input.sourceSha !== undefined &&
      (input.job.get('source_sha') !== input.sourceSha ||
        input.job.get('repair_base') !== input.sourceSha))
  ) {
    return refusal('canonical-handoff-mismatch');
  }
  if (input.rowText === undefined) return refusal('canonical-handoff-unavailable');
  const row = parseInboxJob(input.rowText);
  if (row === undefined) return refusal('canonical-handoff-unavailable');
  const receipt = row.get('receipt');
  if (receipt === undefined) return refusal('canonical-handoff-mismatch');
  if (!(receipt instanceof JsonObject)) return refusal('canonical-handoff-unavailable');
  const current = receipt.get('repair_task');
  if (current === input.preparedJobId) return { ok: true, alreadyHandedOff: true };
  if (current === input.previousTask) return { ok: true, alreadyHandedOff: false };
  return refusal('canonical-handoff-mismatch');
}

/**
 * `bounded.require_canonical_delivery` (post-handoff selection check). The
 * row is parsed with Python `json.loads` semantics (last duplicate wins,
 * floats allowed), not the strict ledger loader.
 */
export function canonicalDeliveryRefusal(input: {
  readonly rowText: string | undefined;
  readonly job: JsonObject;
}): RepairRefusal | undefined {
  if (!input.job.has('canonical_finding_id')) return undefined;
  const findingId = input.job.get('canonical_finding_id');
  if (!checkCanonicalFindingId(findingId)) return 'canonical-delivery-invalid';
  if (input.rowText === undefined) return 'canonical-delivery-unavailable';
  let row: JsonValue;
  try {
    row = parseJsonValue(input.rowText);
  } catch {
    return 'canonical-delivery-unavailable';
  }
  if (!(row instanceof JsonObject)) return 'canonical-delivery-mismatch';
  if (row.get('status') !== 'delivered') return 'canonical-delivery-mismatch';
  const receipt = row.get('receipt');
  if (!(receipt instanceof JsonObject)) return 'canonical-delivery-mismatch';
  if (receipt.get('repair_task') !== input.job.get('job')) {
    return 'canonical-delivery-mismatch';
  }
  return undefined;
}

/** Replace keys in place, appending a missing key in the supplied order. */
function setObjectKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/**
 * Apply Python's exact queue mutation to a copy: stale-mark the old record,
 * append the new run record, and preserve insertion order. No write.
 */
export function applyPreparedQueue(input: {
  readonly queue: JsonObject;
  readonly itemId: string;
  readonly oldRun: string;
  readonly run: string;
  readonly record: JsonObject;
  readonly stale: { readonly state: 'stale'; readonly error: string } | undefined;
}):
  | { readonly ok: true; readonly queue: JsonObject }
  | { readonly ok: false; readonly refusal: RepairRefusal } {
  const items = input.queue.get('items');
  if (!Array.isArray(items)) return refusal('queue-item-unreadable');
  const index = items.findIndex(
    (item) => item instanceof JsonObject && item.get('id') === input.itemId,
  );
  if (index < 0) return refusal('old-job-item-missing');
  const item = items[index];
  if (!(item instanceof JsonObject)) return refusal('queue-item-unreadable');

  const runsValue = item.get('repair_runs');
  if (runsValue !== undefined && !(runsValue instanceof JsonObject)) {
    return refusal('queue-item-unreadable');
  }
  const runs = runsValue instanceof JsonObject ? runsValue : new JsonObject([]);
  const oldRecord = runs.get(input.oldRun);
  if (!(oldRecord instanceof JsonObject)) return refusal('old-job-not-tick-owned');
  if (runs.has(input.run)) return refusal('queue-item-unreadable');

  const newRunsEntries: Array<readonly [string, JsonValue]> = runs.entries.map(([key, value]) => [
    key,
    key === input.oldRun && input.stale !== undefined
      ? setObjectKeys(oldRecord, [
          ['state', input.stale.state],
          ['error', input.stale.error],
        ])
      : value,
  ]);
  newRunsEntries.push([input.run, input.record]);
  const newRuns = new JsonObject(newRunsEntries);

  const newItemEntries: Array<readonly [string, JsonValue]> = [];
  let replaced = false;
  for (const [key, value] of item.entries) {
    if (key === 'repair_runs') {
      newItemEntries.push([key, newRuns]);
      replaced = true;
    } else {
      newItemEntries.push([key, value]);
    }
  }
  if (!replaced) newItemEntries.push(['repair_runs', newRuns]);
  const newItem = new JsonObject(newItemEntries);

  const newQueueEntries: Array<readonly [string, JsonValue]> = input.queue.entries.map(
    ([key, value]) => [
      key,
      key === 'items' ? items.map((entry, at) => (at === index ? newItem : entry)) : value,
    ],
  );
  return { ok: true, queue: new JsonObject(newQueueEntries) };
}
