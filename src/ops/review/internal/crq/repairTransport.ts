/**
 * The repair transport behind injected seams.
 *
 * Ports `finding_delivery.repair_transport` and
 * `finding_delivery.configured_repair_transport`
 * (`finding_delivery.py:447-524`) plus the round counter they share.
 * Offline only: the repair inbox, the queue, the secret scans and the
 * projection runtime are injected. Nothing here is routed or deployed.
 *
 * The queue is an immutable cell. Python mutates the queue dict in place, so a
 * failure part-way through the supersede loop leaves the earlier mutations in
 * the dict; the port commits each mutation to the cell as it happens.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerLoads,
  ledgerPythonTypeName,
  ledgerSubscript,
  ledgerValueEqual,
} from '../../../../policy/crq/ledger.js';
import {
  FindingDeliveryAttributeError,
  pythonGet,
  pythonIterable,
} from '../../../../policy/crq/findingDelivery.js';
import { pythonStrip, pythonTruthy } from '../../../../policy/crq/repairBinding.js';
import { pythonSplitlines } from '../../../../policy/crq/repairGates.js';
import {
  PythonValueError,
  concatText,
  pythonAtLeast,
  pythonFirst,
  pythonLen,
  pythonValues,
  prependText,
  withKeys,
} from './pythonValues.js';

/** The repair inbox files the transport and `deliver` share. */
export interface RepairInboxFiles {
  /** `inbox/<job>.json` bytes, or null when absent. */
  readRepairInbox(job: string): Promise<Uint8Array | null>;
  /** Atomically write `inbox/<job>.json`. */
  writeRepairInbox(job: string, bytes: Uint8Array): Promise<void>;
}

/** The queue document the transport mutates; replaced, never edited. */
export interface QueueCell {
  queue: JsonValue;
}

/** Python `RepairRoundCeiling`: the current source pin has used its rounds. */
export class RepairRoundCeilingError extends LedgerIntegrityError {
  override readonly name = 'RepairRoundCeilingError';
  override readonly pythonError: string = 'RepairRoundCeiling';
}

const EMPTY = new JsonObject([]);
const STALE_ELIGIBLE = new Set(['queued', 'ready', 'publish_failed']);

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

function getOr(value: JsonValue, key: string, fallback: JsonValue): JsonValue {
  const found = pythonGet(value, key);
  return found === undefined ? fallback : found;
}

function replaceKey(object: JsonObject, key: string, value: JsonValue): JsonObject {
  return withKeys(object, [[key, value]]);
}

/** Replace `index` of the queue's `items` list through the cell. */
function commitItem(cell: QueueCell, index: number, item: JsonValue): void {
  const queue = cell.queue as JsonObject;
  const items = [...(ledgerSubscript(queue, 'items') as JsonValue[])];
  items[index] = item;
  cell.queue = replaceKey(queue, 'items', items);
}

/**
 * `canonical_rounds`: how many repair generations of `canonicalId` the queue
 * already holds for source pin `pin`, ignoring `excludeJob`.
 */
export async function canonicalRounds(
  files: Pick<RepairInboxFiles, 'readRepairInbox'>,
  queue: JsonValue,
  canonicalId: JsonValue,
  pin: JsonValue,
  excludeJob: JsonValue = null,
): Promise<number> {
  let rounds = 0;
  for (const item of pythonIterable(ledgerSubscript(queue, 'items'))) {
    for (const record of pythonValues(getOr(item, 'repair_runs', EMPTY))) {
      if (!ledgerValueEqual(pythonGet(record, 'pin') ?? null, pin)) continue;
      let canonical: JsonValue = pythonGet(record, 'canonical_finding_id') ?? null;
      for (const oldId of pythonIterable(getOr(record, 'jobs', []))) {
        if (ledgerValueEqual(oldId, excludeJob)) continue;
        concatText(oldId, '.json');
        const bytes = await files.readRepairInbox(oldId as string);
        if (bytes !== null) {
          const loaded = pythonGet(ledgerLoads(bytes), 'canonical_finding_id') ?? null;
          if (pythonTruthy(loaded)) canonical = loaded;
        } else if (canonical === null) {
          const itemId = getOr(item, 'id', '');
          if (typeof itemId !== 'string') {
            throw new FindingDeliveryAttributeError(
              `'${ledgerPythonTypeName(itemId)}' object has no attribute 'startswith'`,
            );
          }
          if (itemId.startsWith('backfill-finding-')) {
            throw integrity('repair history lacks canonical binding');
          }
        }
        if (ledgerValueEqual(canonical, canonicalId)) {
          rounds += 1;
          break;
        }
      }
    }
  }
  return rounds;
}

/** Scan seams, each truthy on a clean scan. */
export interface RepairTransportScans {
  scan(target: JsonValue, name: JsonValue): Promise<JsonValue>;
  scanInstructions?(text: JsonValue, target: JsonValue): Promise<JsonValue>;
  scanFinding?(text: JsonValue, target: JsonValue, path: JsonValue): Promise<JsonValue>;
}

export interface RepairTransportOptions extends RepairTransportScans {
  readonly files: RepairInboxFiles;
  readonly cell: QueueCell;
  readonly saveQueue: (queue: JsonValue) => Promise<void>;
  readonly maxRoundsPerPin: JsonValue;
}

/** `repair_transport`: the stub queue accepts the request as a durable repair task. */
export function makeRepairTransport(
  options: RepairTransportOptions,
): (key: JsonValue, request: JsonValue) => Promise<JsonValue> {
  const { files, cell, saveQueue, maxRoundsPerPin } = options;
  return async (key, request) => {
    const jobId = prependText('crq-backfill-', key);
    const itemId = prependText('backfill-finding-', key);
    const run = prependText('backfill-', key);
    const existingBytes = await files.readRepairInbox(jobId);
    const existing = existingBytes === null ? null : ledgerLoads(existingBytes);
    const canonicalId = ledgerSubscript(request, 'canonical_id');
    const target = ledgerSubscript(request, 'target');
    const rounds = await canonicalRounds(files, cell.queue, canonicalId, target, jobId);
    if (existing === null && pythonAtLeast(rounds, maxRoundsPerPin)) {
      throw new RepairRoundCeilingError('repair round ceiling reached for current source pin');
    }
    const severity = ledgerSubscript(ledgerSubscript(request, 'finding'), 'severity');
    const path = ledgerSubscript(request, 'path');
    const line = pythonFirst(pythonFirst(ledgerSubscript(request, 'intervals')));
    const titled = concatText(ledgerSubscript(ledgerSubscript(request, 'finding'), 'title'), '\n');
    const body = prependText(titled, ledgerSubscript(ledgerSubscript(request, 'finding'), 'body'));
    const finding = new JsonObject([
      ['severity', severity],
      ['path', path],
      ['line', line],
      ['body', body],
    ]);
    if (!pythonTruthy(await options.scan(target, path))) {
      throw integrity('repair source secret scan rejected');
    }
    if (
      options.scanFinding === undefined ||
      !pythonTruthy(await options.scanFinding(body, target, path))
    ) {
      throw integrity('repair finding secret scan rejected');
    }
    const instructions = pythonGet(request, 'retry_instructions') ?? null;
    if (
      instructions !== null &&
      (options.scanInstructions === undefined ||
        !pythonTruthy(await options.scanInstructions(instructions, target)))
    ) {
      throw integrity('fix instructions secret scan failed');
    }
    let job = new JsonObject([
      ['job', jobId],
      ['item', itemId],
      ['kind', 'merged'],
      ['pr', JsonNumber.int(0)],
      ['run', run],
      ['cycle', null],
      ['repair_base', target],
      ['branch', null],
      ['finding', finding],
      ['repair_round', JsonNumber.int(rounds + 1)],
      ['prior', null],
      ['recurrence', false],
      ['review_diff', ''],
      ['review_id', ledgerSubscript(request, 'review_id')],
      ['canonical_finding_id', canonicalId],
    ]);
    if (instructions !== null) {
      job = withKeys(job, [
        ['fix_instructions', instructions],
        ['prior_repair_task', ledgerSubscript(request, 'prior_repair_task')],
      ]);
    }
    if (existing !== null) {
      job = withKeys(job, [['repair_round', pythonGet(existing, 'repair_round') ?? null]]);
      if (!ledgerValueEqual(existing, job)) throw integrity('repair inbox idempotency conflict');
    } else {
      await files.writeRepairInbox(jobId, ledgerCanonicalBytes(job));
    }
    enqueue(cell, itemId, jobId, run, target, job, canonicalId);
    await supersede(files, cell, jobId, canonicalId);
    await saveQueue(cell.queue);
    return new JsonObject([
      ['acknowledgement', ledgerDigestOf(job)],
      ['repair_task', jobId],
    ]);
  };
}

/** Append the queued item for this generation unless the queue already has it. */
function enqueue(
  cell: QueueCell,
  itemId: string,
  jobId: string,
  run: string,
  target: JsonValue,
  job: JsonObject,
  canonicalId: JsonValue,
): void {
  const queue = cell.queue as JsonObject;
  const items = ledgerSubscript(queue, 'items');
  for (const item of pythonIterable(items)) {
    if (ledgerValueEqual(ledgerSubscript(item, 'id'), itemId)) return;
  }
  if (!Array.isArray(items)) {
    throw new FindingDeliveryAttributeError(
      `'${ledgerPythonTypeName(items)}' object has no attribute 'append'`,
    );
  }
  const record = new JsonObject([
    ['jobs', [jobId]],
    ['pin', target],
    ['base', target],
    ['branch', null],
    ['open_pr', false],
    ['round', ledgerSubscript(job, 'repair_round')],
    ['state', 'queued'],
    ['canonical_finding_id', canonicalId],
  ]);
  cell.queue = replaceKey(queue, 'items', [
    ...items,
    new JsonObject([
      ['id', itemId],
      ['kind', 'merged'],
      ['pr', JsonNumber.int(0)],
      ['state', 'repairing'],
      ['cycles', []],
      ['repair_runs', new JsonObject([[run, record]])],
    ]),
  ]);
}

/** Mark every other still-open generation of the same canonical finding stale. */
async function supersede(
  files: Pick<RepairInboxFiles, 'readRepairInbox'>,
  cell: QueueCell,
  jobId: string,
  canonicalId: JsonValue,
): Promise<void> {
  const count = (ledgerSubscript(cell.queue, 'items') as JsonValue[]).length;
  for (let index = 0; index < count; index += 1) {
    const oldItem = (ledgerSubscript(cell.queue, 'items') as JsonValue[])[index] as JsonValue;
    for (const [runKey, oldRun] of runEntries(getOr(oldItem, 'repair_runs', EMPTY))) {
      const state = pythonGet(oldRun, 'state') ?? null;
      if (typeof state !== 'string' || !STALE_ELIGIBLE.has(state)) continue;
      if (pythonTruthy(pythonGet(oldRun, 'fix_pr') ?? null)) continue;
      if (pythonTruthy(pythonGet(oldRun, 'fix_merged') ?? null)) continue;
      for (const oldId of pythonIterable(getOr(oldRun, 'jobs', []))) {
        if (ledgerValueEqual(oldId, jobId)) continue;
        concatText(oldId, '.json');
        const bytes = await files.readRepairInbox(oldId as string);
        if (bytes === null) continue;
        const bound = pythonGet(ledgerLoads(bytes), 'canonical_finding_id') ?? null;
        if (!ledgerValueEqual(bound, canonicalId)) continue;
        const latest = (ledgerSubscript(cell.queue, 'items') as JsonValue[])[index] as JsonObject;
        const staled = withKeys(oldRun as JsonObject, [
          ['state', 'stale'],
          ['error', `superseded by repair generation ${jobId}`],
        ]);
        const runs = withKeys(getOr(latest, 'repair_runs', EMPTY) as JsonObject, [
          [runKey, staled],
        ]);
        commitItem(
          cell,
          index,
          withKeys(latest, [
            ['repair_runs', runs],
            ['state', 'done'],
          ]),
        );
      }
    }
  }
}

function runEntries(runs: JsonValue): ReadonlyArray<readonly [string, JsonValue]> {
  pythonValues(runs);
  return (runs as JsonObject).entries;
}

/** What `configured_repair_transport` takes from the surrounding `Context`. */
export interface ConfiguredTransportContext {
  readonly config: JsonValue;
  readonly saveQueue: (queue: JsonValue) => Promise<void>;
  /** `secret_scan(base, head, relpath)`; the first tuple element is the verdict. */
  secretScan(base: JsonValue, head: JsonValue, relpath: string): Promise<JsonValue>;
  /** `secret_scan_diff(patch, base, head, relpath)`; truthy when clean. */
  secretScanDiff(
    patch: string,
    base: JsonValue,
    head: JsonValue,
    relpath: string,
  ): Promise<JsonValue>;
}

/** The runtime the configured transport asks for a projection of a scan file. */
export interface ConfiguredRuntime {
  projection(
    repo: JsonValue,
    target: JsonValue,
    names: readonly JsonValue[],
  ): Promise<readonly [JsonValue, JsonValue]>;
}

function additions(lines: readonly string[]): string {
  return lines.map((line) => `+${line}`).join('\n');
}

/** `configured_repair_transport`: the transport wired to the real scan seams. */
export function configuredRepairTransport(
  context: ConfiguredTransportContext,
  repo: JsonValue,
  files: RepairInboxFiles,
  cell: QueueCell,
  runtime: ConfiguredRuntime,
): (key: JsonValue, request: JsonValue) => Promise<JsonValue> {
  const repair = ledgerSubscript(context.config, 'repair');
  const maxRoundsPerPin = getOr(repair, 'max_rounds_per_pin', JsonNumber.int(2));
  return makeRepairTransport({
    files,
    cell,
    saveQueue: context.saveQueue,
    maxRoundsPerPin,
    async scan(target, name) {
      const [base, head] = await runtime.projection(repo, target, [name]);
      return context.secretScan(base, head, 'backfill/repair-scan.json');
    },
    async scanInstructions(text, target) {
      if (
        typeof text !== 'string' ||
        !pythonTruthy(pythonStrip(text)) ||
        pythonLen(text) > 2000 ||
        text.includes('\x00')
      ) {
        throw new PythonValueError('fix instructions must contain 1..2000 characters without NUL');
      }
      const lines = pythonSplitlines(text);
      const patch =
        'diff --git a/crq-fix-instructions.txt b/crq-fix-instructions.txt\n' +
        '--- /dev/null\n+++ b/crq-fix-instructions.txt\n' +
        `@@ -0,0 +1,${lines.length} @@\n${additions(lines)}\n`;
      const clean = await context.secretScanDiff(
        patch,
        null,
        target,
        'backfill/repair-instructions-scan.json',
      );
      if (!pythonTruthy(clean)) throw new PythonValueError('fix instructions secret scan failed');
      return true;
    },
    async scanFinding(text, target, path) {
      if (typeof path !== 'string' || path.includes('\n') || path.includes('\r')) return false;
      if (typeof text !== 'string') return false;
      const lines = text.split('\n');
      for (const name of ['crq-finding.txt', path]) {
        const patch =
          `diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n` +
          `@@ -0,0 +1,${lines.length} @@\n${additions(lines)}\n`;
        const clean = await context.secretScanDiff(
          patch,
          null,
          target,
          'backfill/repair-finding-scan.json',
        );
        if (!pythonTruthy(clean)) return false;
      }
      return true;
    },
  });
}
