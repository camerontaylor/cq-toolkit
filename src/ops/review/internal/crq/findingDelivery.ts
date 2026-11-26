/**
 * `Inbox.deliver` behind injected seams.
 *
 * Ports `finding_delivery.Inbox.deliver` (`finding_delivery.py:291-380`).
 * Offline only: the triage row, the request and receipt files, the repair
 * inbox, the retained-diff snapshots, the publication and the transport are
 * all injected, so no root, lock file, git process or queue is bound here.
 *
 * The port keeps Python's evaluation order, because a malformed row or
 * snapshot refuses at a different point in each order and the effects before
 * it (the request file, the receipt file) are durable. A Python exception
 * that escapes uncaught is ported as a typed error carrying `pythonError`.
 */
import { JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerLoads,
  ledgerSubscript,
  ledgerValueEqual,
} from '../../../../policy/crq/ledger.js';
import { pythonGet } from '../../../../policy/crq/findingDelivery.js';
import { pythonJsonText, sha256Hex } from '../../../../policy/crq/pythonJson.js';
import { pythonTruthy } from '../../../../policy/crq/repairBinding.js';
import { pythonSplitlines } from '../../../../policy/crq/repairGates.js';
import { FindingRowMissingError } from './findingDisposition.js';
import { FindingInbox, type FindingInboxFiles, type FindingPublication } from './findingInbox.js';
import type { RepairInboxFiles } from './repairTransport.js';
import {
  codePointPrefix,
  concatText,
  hashKey,
  pythonLen,
  pythonStr,
  withKeys,
} from './pythonValues.js';

/** One `retained-*` directory holding a manifest and three patch files. */
export interface RetainedSnapshot {
  /** Path components below the job directory; the last is `retained-<token>`. */
  readonly directory: readonly string[];
  /** `manifest.json` bytes. */
  readManifest(): Promise<Uint8Array>;
  /** `(directory / name).stat().st_size`; throws when the patch file is absent. */
  patchSize(name: string): Promise<number>;
  /** `(directory / name).read_bytes()`; throws when the patch file is absent. */
  readPatch(name: string): Promise<Uint8Array>;
}

/** Everything `deliver` reads or writes besides the triage row and the outbox. */
export interface FindingDeliveryFiles
  extends FindingInboxFiles, Pick<RepairInboxFiles, 'readRepairInbox'> {
  /** `delivery/<key>.json` bytes, or null when absent. */
  readRequest(key: string): Promise<Uint8Array | null>;
  /** Atomically write `delivery/<key>.json`. */
  writeRequest(key: string, bytes: Uint8Array): Promise<void>;
  /** `receipts/<key>.json` bytes, or null when absent. */
  readReceipt(key: string): Promise<Uint8Array | null>;
  /** Atomically write `receipts/<key>.json`. */
  writeReceipt(key: string, bytes: Uint8Array): Promise<void>;
  /** `glob("**\/retained-*\/manifest.json")` under `state/repair/<job>`, in any order. */
  listRetained(job: string): Promise<readonly RetainedSnapshot[]>;
}

/** The repair transport: a stable idempotency key and the request, one receipt back. */
export type DeliveryTransport = (key: string, request: JsonObject) => Promise<JsonValue>;

const PREVIOUS_TASK = /^crq-[A-Za-z0-9._-]+$/;
const PATCH_NAMES = ['committed.patch', 'staged.patch', 'unstaged.patch'] as const;
const EMPTY = new JsonObject([]);
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const ENCODER = new TextEncoder();

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

/** Python `dict.get(key, default)` where the receiver may not be a dict. */
function getOr(value: JsonValue, key: string, fallback: JsonValue): JsonValue {
  const found = pythonGet(value, key);
  return found === undefined ? fallback : found;
}

/** Python `sorted(paths)`: component-wise, each compared by code point. */
function compareParts(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = Array.from(left[index] as string);
    const b = Array.from(right[index] as string);
    const shared = Math.min(a.length, b.length);
    for (let at = 0; at < shared; at += 1) {
      const delta = (a[at] as string).codePointAt(0)! - (b[at] as string).codePointAt(0)!;
      if (delta !== 0) return delta;
    }
    if (a.length !== b.length) return a.length - b.length;
  }
  return left.length - right.length;
}

export class FindingDelivery {
  private readonly inbox: FindingInbox;

  constructor(
    private readonly files: FindingDeliveryFiles,
    private readonly publication: FindingPublication,
  ) {
    this.inbox = new FindingInbox(files);
  }

  /** `Inbox.deliver`: the transport accepts a stable key and returns the same receipt. */
  async deliver(findingId: string, transport: DeliveryTransport, at: string): Promise<JsonValue> {
    await this.inbox.recover(await this.publication.retained());
    return this.files.withLock(async () => {
      const bytes = await this.files.readTriage(findingId);
      if (bytes === null) throw new FindingRowMissingError(findingId);
      const loaded = ledgerLoads(bytes);
      const status = ledgerSubscript(loaded, 'status');
      if (status === 'delivered') return ledgerSubscript(loaded, 'receipt');
      if (status !== 'confirmed') {
        throw integrity('only confirmed current findings enter repair inbox');
      }
      const row = loaded as JsonObject;
      let request = new JsonObject([
        ['canonical_id', ledgerSubscript(row, 'canonical_id')],
        ['finding_id', findingId],
        ['review_id', ledgerSubscript(row, 'review_id')],
        ['target', ledgerSubscript(row, 'target_current')],
        ['path', ledgerSubscript(row, 'mapped_path')],
        ['intervals', ledgerSubscript(row, 'mapped_intervals')],
        ['finding', ledgerSubscript(row, 'finding')],
      ]);
      const previousJob = pythonGet(getOr(row, 'receipt', EMPTY), 'repair_task') ?? null;
      if (pythonTruthy(previousJob)) {
        if (typeof previousJob !== 'string' || !PREVIOUS_TASK.test(previousJob)) {
          throw integrity('invalid previous repair task');
        }
        request = await this.withRetryGuidance(row, request, previousJob);
      }
      let deliveryKey: JsonValue = ledgerSubscript(row, 'canonical_id');
      if (pythonTruthy(pythonGet(row, 'receipt'))) {
        deliveryKey = ledgerDigestOf(
          new JsonObject([
            ['canonical', deliveryKey],
            ['confirmation', ledgerSubscript(row, 'previous_event_id')],
          ]),
        );
      }
      let key = textKey(deliveryKey);
      const saved = await this.files.readRequest(key);
      if (saved !== null) {
        if (!ledgerValueEqual(ledgerLoads(saved), request)) {
          // A prior transport may have accepted a task before its receipt was
          // saved. Preserve that request; re-confirmation gets a new task.
          key = ledgerDigestOf(
            new JsonObject([
              ['canonical', ledgerSubscript(row, 'canonical_id')],
              ['confirmation', ledgerSubscript(row, 'previous_event_id')],
            ]),
          );
          const other = await this.files.readRequest(key);
          if (other !== null && !ledgerValueEqual(ledgerLoads(other), request)) {
            throw integrity('repair generation request changed; reconcile');
          }
          await this.files.writeRequest(key, ledgerCanonicalBytes(request));
        }
      } else {
        await this.files.writeRequest(key, ledgerCanonicalBytes(request));
      }
      const receiptBytes = await this.files.readReceipt(key);
      const receipt =
        receiptBytes !== null ? ledgerLoads(receiptBytes) : await transport(key, request);
      if (
        !pythonTruthy(pythonGet(receipt, 'acknowledgement')) ||
        !pythonTruthy(pythonGet(receipt, 'repair_task'))
      ) {
        throw integrity('repair transport did not acknowledge durable task');
      }
      await this.files.writeReceipt(key, ledgerCanonicalBytes(receipt));
      const value = ledgerEvent(
        'finding-event',
        `delivery:${findingId}:${key}`,
        at,
        new JsonObject([
          ['finding_id', findingId],
          ['review_id', ledgerSubscript(row, 'review_id')],
          ['previous_event_id', ledgerSubscript(row, 'previous_event_id')],
          ['action', 'delivered'],
          ['evidence', receipt],
          ['actor', 'crq-repair-adapter'],
        ]),
      );
      await this.publication.spool(value);
      const next = withKeys(row, [
        ['status', 'delivered'],
        ['previous_event_id', ledgerSubscript(value, 'id')],
        ['receipt', receipt],
      ]);
      await this.files.writeTriage(findingId, ledgerCanonicalBytes(next));
      return receipt;
    });
  }

  /**
   * The retry-guidance walk: follow `previous_event_id` back to the repair
   * event that produced `previousJob`, then summarise its retained diffs.
   */
  private async withRetryGuidance(
    row: JsonObject,
    request: JsonObject,
    previousJob: string,
  ): Promise<JsonObject> {
    const events = new Map<string, JsonValue>();
    for (const value of await this.publication.retained()) {
      if (pythonGet(value, 'event_type') === 'finding-event') {
        events.set(hashKey(ledgerSubscript(value, 'id')), value);
      }
    }
    let previous: JsonValue = pythonGet(row, 'previous_event_id') ?? null;
    const seen = new Set<string>();
    for (;;) {
      const token = hashKey(previous);
      if (!events.has(token) || seen.has(token)) return request;
      seen.add(token);
      const payload = ledgerSubscript(events.get(token) as JsonValue, 'payload');
      const evidence = getOr(payload, 'evidence', EMPTY);
      if (
        pythonGet(payload, 'actor') === 'crq-repair' &&
        ledgerValueEqual(pythonGet(evidence, 'repair_task') ?? null, previousJob)
      ) {
        const summary = await this.retainedSummary(row, evidence, previousJob);
        const reason = pythonGet(evidence, 'reason') ?? null;
        const reasonText = pythonTruthy(reason) ? pythonStr(reason) : 'unavailable';
        const text =
          'Prior attempt reason: ' +
          codePointPrefix(reasonText, 1200) +
          '\nRetained diff summary: ' +
          (summary.join('; ') || 'no retained snapshot found');
        return withKeys(request, [
          ['retry_instructions', codePointPrefix(text, 2000).replaceAll('\x00', '')],
          ['prior_repair_task', previousJob],
        ]);
      }
      previous = pythonGet(payload, 'previous_event_id') ?? null;
    }
  }

  /** One summary line per bounded, source-bound retained snapshot. */
  private async retainedSummary(
    row: JsonObject,
    evidence: JsonValue,
    previousJob: string,
  ): Promise<string[]> {
    let snapshots = [...(await this.files.listRetained(previousJob))].sort((a, b) =>
      compareParts([...a.directory, 'manifest.json'], [...b.directory, 'manifest.json']),
    );
    let repairBase: JsonValue = pythonGet(evidence, 'repair_base') ?? null;
    if (!pythonTruthy(repairBase) && snapshots.length > 0) {
      const legacy = await this.files.readRepairInbox(previousJob);
      if (legacy !== null) {
        const old = ledgerLoads(legacy);
        if (
          !ledgerValueEqual(pythonGet(old, 'job') ?? null, previousJob) ||
          !ledgerValueEqual(
            pythonGet(old, 'canonical_finding_id') ?? null,
            ledgerSubscript(row, 'canonical_id'),
          ) ||
          !ledgerValueEqual(
            ledgerDigestOf(old),
            pythonGet(ledgerSubscript(row, 'receipt'), 'acknowledgement') ?? null,
          )
        ) {
          throw integrity('prior repair job identity mismatch');
        }
        repairBase = pythonGet(old, 'repair_base') ?? null;
      }
      if (!pythonTruthy(repairBase)) snapshots = []; // Unbound legacy snapshots are never guidance.
    }
    const summary: string[] = [];
    for (const snapshot of snapshots.slice(0, 10)) {
      const manifest = ledgerLoads(await snapshot.readManifest());
      const token = sha256Hex(
        ENCODER.encode(
          pythonJsonText(manifest as never, {
            asciiOnly: true,
            sortKeys: true,
            spacedSeparators: false,
          }),
        ),
      );
      if (
        snapshot.directory[snapshot.directory.length - 1] !== `retained-${token}` ||
        !ledgerValueEqual(pythonGet(manifest, 'base') ?? null, repairBase)
      ) {
        throw integrity('retained manifest source binding mismatch');
      }
      const sizes: number[] = [];
      const paths: string[] = [];
      for (const name of PATCH_NAMES) {
        if ((await snapshot.patchSize(name)) > 2_000_000) {
          throw integrity('retained diff exceeds bounded context');
        }
        const data = await snapshot.readPatch(name);
        if (
          !ledgerValueEqual(
            sha256Hex(data),
            ledgerSubscript(ledgerSubscript(manifest, 'sha256'), name),
          )
        ) {
          throw integrity('retained diff digest mismatch');
        }
        sizes.push(data.length);
        for (const line of pythonSplitlines(DECODER.decode(data.subarray(0, 200000)))) {
          if (line.startsWith('diff --git ')) paths.push(line.slice(11));
        }
      }
      const untracked = pythonLen(getOr(manifest, 'untracked', []));
      summary.push(
        `retained diff bytes committed/staged/unstaged: ${sizes.join('/')}; ${untracked} untracked paths` +
          `; changed paths: ${paths.slice(0, 10).join(', ')}`,
      );
    }
    return summary;
  }
}

/** The file-name stem for a delivery key: Python's `key + ".json"` needs a str. */
function textKey(key: JsonValue): string {
  concatText(key, '.json');
  return key as string;
}
