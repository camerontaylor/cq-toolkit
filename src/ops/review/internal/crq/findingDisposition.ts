/**
 * Finding inbox dispositions behind injected seams.
 *
 * Ports `finding_delivery.Inbox.context_error`, `recovered_anchor`, `triage`
 * and `repair_outcome` (`finding_delivery.py:53-112`, `113-176`, `239-290`).
 * Offline only: the triage rows, the publication, the repository and the
 * artifact bytes are all injected, so no root, lock file, git process or
 * network is bound here.
 *
 * The port keeps Python's evaluation order, because a malformed row refuses
 * at a different point in each order and the effects before it are durable:
 * `triage` and `repair_outcome` spool the event before the row write, and
 * `triage` reads `row["canonical_id"]` only after the spool. Python's
 * `repo.resolve(promoted)` result is discarded and the raw argument flows on.
 *
 * A Python exception that escapes uncaught is ported as a typed error that
 * carries `pythonError`, which the oracle differential compares.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  LedgerTypeError,
  LedgerUnicodeDecodeError,
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerIntervals,
  ledgerLoads,
  ledgerSubscript,
  ledgerValidate,
  ledgerValueEqual,
} from '../../../../policy/crq/ledger.js';
import { pythonGet } from '../../../../policy/crq/findingDelivery.js';
import { pythonJsonText, sha256Hex } from '../../../../policy/crq/pythonJson.js';
import { pythonStrip, pythonTruthy } from '../../../../policy/crq/repairBinding.js';
import { pythonSplitlines } from '../../../../policy/crq/repairGates.js';
import { rangesOf } from '../../../../policy/crq/backfillInventory.js';
import { lineBytes } from '../../../../policy/crq/backfillAccounting.js';
import { findingIntervals, vendorEvents } from '../../../../policy/crq/backfillVendorOutput.js';
import type { ArtifactReference } from '../../../../adapters/crq/findingStore.js';
import { FindingInbox, type FindingInboxFiles, type FindingPublication } from './findingInbox.js';

/** Python `FileNotFoundError` from reading a `triage/<id>.json` that is absent. */
export class FindingRowMissingError extends Error {
  override readonly name = 'FindingRowMissingError';
  readonly pythonError = 'FileNotFoundError';

  constructor(findingId: string) {
    super(`triage row ${findingId} does not exist`);
  }
}

/**
 * Python `CalledProcessError` from a git read. `recovered_anchor` does not
 * catch it, so a repository failure always propagates.
 */
export class FindingRepoError extends Error {
  override readonly name = 'FindingRepoError';
  readonly pythonError = 'CalledProcessError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `OSError` from reading retained artifact bytes. */
export class FindingArtifactReadError extends Error {
  override readonly name = 'FindingArtifactReadError';
  readonly pythonError = 'OSError';

  constructor(message: string) {
    super(message);
  }
}

/** The repository reads the dispositions need. The real adapter is a later slice. */
export interface FindingRepo {
  /** `repo.resolve`: a commit-ish to a commit id. */
  resolve(value: string): Promise<string>;
  /** `repo.entries`: path to `{blob, ...}` for one commit. */
  entries(commit: string): Promise<JsonObject>;
  /** `repo.git("cat-file", "blob", blob)`. */
  catBlob(blob: string): Promise<Uint8Array>;
  /** `repo.carry`: where the old interval lines sit in the new commit. */
  carry(
    old: string,
    next: string,
    path: string,
    lines: ReadonlySet<number>,
  ): Promise<{ readonly name: string | null; readonly mapped: ReadonlySet<number> }>;
}

/** `publication.artifacts.verify` plus the read of the verified location. */
export interface FindingArtifactReader {
  verify(reference: ArtifactReference): Promise<void>;
  /** Bytes at `location`; throws {@link FindingArtifactReadError} when unreadable. */
  read(location: string): Promise<Uint8Array>;
}

export interface TriageOptions {
  readonly fixingCommit?: string | null;
  readonly canonicalId?: string | null;
  readonly reviews?: readonly JsonValue[];
  readonly currentPath?: string | null;
  readonly currentLines?: JsonValue;
  readonly quotedText?: JsonValue;
  readonly failureClass?: JsonValue;
  /** Absent means Python's `_UNSET`; `null` is a real snapshot value. */
  readonly expectedPreviousEventId?: JsonValue;
}

export interface RepairOutcomeOptions {
  readonly fixingCommit?: string | null;
  readonly fixPr?: JsonValue;
  readonly sourceEvidence?: JsonValue;
  readonly failureClass?: JsonValue;
  readonly maxFindingRetries?: number;
  readonly repairBase?: JsonValue;
}

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DEFAULT_ANCHOR_TITLE = 'Unverified vendor finding anchor';

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

/** The Python exceptions `recovered_anchor` swallows. Repository errors are not among them. */
function isRecoverableAnchorError(error: unknown): boolean {
  return (
    error instanceof LedgerIntegrityError ||
    error instanceof LedgerTimestampError ||
    error instanceof LedgerJsonDecodeError ||
    error instanceof LedgerUnicodeDecodeError ||
    error instanceof FindingArtifactReadError
  );
}

/** Python `bytes.decode()`: strict UTF-8 that keeps a leading BOM. */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    throw new LedgerUnicodeDecodeError('invalid utf-8 in repository blob');
  }
}

function asString(value: JsonValue, what: string): string {
  if (typeof value !== 'string') throw new LedgerTypeError(`${what} must be a string`);
  return value;
}

/** Python `dict.get(key, default)` where the receiver may not be a dict. */
function getOr(value: JsonValue, key: string, fallback: JsonValue): JsonValue {
  const found = pythonGet(value, key);
  return found === undefined ? fallback : found;
}

function withKeys(
  row: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = row.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) if (!row.has(key)) entries.push([key, value]);
  return new JsonObject(entries);
}

function withoutKey(row: JsonObject, key: string): JsonObject {
  return row.has(key) ? new JsonObject(row.entries.filter(([name]) => name !== key)) : row;
}

function rangesJson(lines: ReadonlySet<number>): JsonValue {
  return rangesOf(lines).map(
    (range) => range.map((line) => JsonNumber.int(Number(line))) as JsonValue,
  );
}

/** A Python `dict` membership test on an arbitrary JSON value. */
function assertHashable(value: JsonValue): void {
  if (Array.isArray(value) || value instanceof JsonObject) {
    throw new LedgerTypeError(`unhashable type: '${Array.isArray(value) ? 'list' : 'dict'}'`);
  }
}

export class FindingDispositions {
  private readonly inbox: FindingInbox;

  constructor(
    private readonly files: FindingInboxFiles,
    private readonly artifacts: FindingArtifactReader,
  ) {
    this.inbox = new FindingInbox(files);
  }

  /** `Inbox.context_error`: change a diagnostic only while the snapshot owns the row. */
  async contextError(
    findingId: string,
    expectedPreviousEventId: JsonValue,
    error: JsonValue,
  ): Promise<boolean> {
    return this.files.withLock(async () => {
      const row = await this.readRow(findingId);
      if (!ledgerValueEqual(ledgerSubscript(row, 'previous_event_id'), expectedPreviousEventId)) {
        return false;
      }
      let next = row as JsonObject;
      if (error === null) {
        if (!next.has('context_error')) return true;
        next = withoutKey(next, 'context_error');
      } else {
        next = withKeys(next, [['context_error', error]]);
      }
      await this.files.writeTriage(findingId, ledgerCanonicalBytes(next));
      return true;
    });
  }

  /**
   * `Inbox.recovered_anchor`: a unique exact occurrence in its verified
   * retained raw run. Writes nothing.
   */
  async recoveredAnchor(
    row: JsonValue,
    repo: FindingRepo,
    reviews: readonly JsonValue[],
  ): Promise<JsonValue> {
    const cached = pythonGet(row, 'recovered_anchor');
    if (cached !== undefined && pythonTruthy(cached)) return cached;
    const finding = ledgerSubscript(row, 'finding');
    let review: JsonValue | undefined;
    for (const candidate of reviews) {
      if (
        ledgerSubscript(candidate, 'event_type') === 'review' &&
        ledgerValueEqual(ledgerSubscript(candidate, 'id'), ledgerSubscript(row, 'review_id'))
      ) {
        review = candidate;
      }
    }
    if (review === undefined) return null;
    ledgerValidate(review);
    const payload = ledgerSubscript(review, 'payload');
    const findings = ledgerSubscript(payload, 'findings');
    const artifacts = pythonGet(payload, 'artifacts');
    if (
      !ledgerValueEqual(ledgerSubscript(payload, 'target'), ledgerSubscript(row, 'target')) ||
      !Array.isArray(findings) ||
      !findings.some((item) => ledgerValueEqual(item, finding)) ||
      ledgerSubscript(ledgerSubscript(payload, 'source'), 'producer') !== 'crq-runner-app' ||
      artifacts === undefined ||
      !pythonTruthy(artifacts)
    ) {
      return null;
    }
    // `payload["artifacts"][0]`: completion_event retains the raw terminal bytes first.
    const reference = Array.isArray(artifacts) ? artifacts[0] : undefined;
    if (reference === undefined) throw new LedgerTypeError('artifacts is not a non-empty list');
    return this.recoverFromRun(row, repo, finding, reference);
  }

  private async recoverFromRun(
    row: JsonValue,
    repo: FindingRepo,
    finding: JsonValue,
    reference: JsonValue,
  ): Promise<JsonValue> {
    try {
      const sha256 = asString(ledgerSubscript(reference, 'sha256'), 'sha256');
      const location = asString(ledgerSubscript(reference, 'location'), 'location');
      await this.artifacts.verify({ sha256, location });
      const raw = await this.artifacts.read(location);
      if (sha256Hex(raw) !== sha256) return null;
      const candidates = vendorEvents(raw).filter((event) => matchesFinding(event, finding));
      if (candidates.length !== 1) return null;
      const intervals = findingIntervals(candidates[0] as JsonObject);
      const target = asString(ledgerSubscript(row, 'target'), 'target');
      const entries = await repo.entries(target);
      const findingPath = ledgerSubscript(finding, 'path');
      const entry = typeof findingPath === 'string' ? entries.get(findingPath) : undefined;
      if (
        intervals.length === 0 ||
        entry === undefined ||
        !pythonTruthy(entry) ||
        !ledgerValueEqual(ledgerSubscript(entry, 'blob'), ledgerSubscript(finding, 'blob'))
      ) {
        return null;
      }
      const blob = ledgerSubscript(entry, 'blob');
      const maximum = lineBytes(await repo.catBlob(asString(blob, 'blob'))).length;
      if (intervals.some(([, end]) => end > maximum)) return null;
      return new JsonObject([
        ['path', findingPath],
        ['blob', blob],
        [
          'intervals',
          intervals.map(([start, end]) => [JsonNumber.int(start), JsonNumber.int(end)]),
        ],
        ['anchor_recovered_from', sha256],
      ]);
    } catch (error) {
      if (isRecoverableAnchorError(error)) return null;
      throw error;
    }
  }

  /**
   * `Inbox.triage`: recover, then under `findings.lock` build the evidence,
   * spool the event and only then write the row.
   */
  async triage(
    publication: FindingPublication,
    repo: FindingRepo,
    findingId: string,
    promoted: string,
    action: JsonValue,
    actor: JsonValue,
    reason: JsonValue,
    at: string,
    options: TriageOptions = {},
  ): Promise<JsonObject | null> {
    const retained = await publication.retained();
    await this.inbox.recover(retained);
    return this.files.withLock(async () => {
      const row = await this.readRow(findingId);
      const finding = ledgerSubscript(row, 'finding');
      if (
        options.expectedPreviousEventId !== undefined &&
        !ledgerValueEqual(
          ledgerSubscript(row, 'previous_event_id'),
          options.expectedPreviousEventId,
        )
      ) {
        return null;
      }
      await repo.resolve(promoted);
      const unverified = !ledgerValueEqual(ledgerSubscript(finding, 'anchor_status'), 'verified');
      const recoveredValue = unverified
        ? await this.recoveredAnchor(row, repo, [...retained, ...(options.reviews ?? [])])
        : null;
      const recovered =
        recoveredValue !== null && pythonTruthy(recoveredValue) ? recoveredValue : null;
      const anchor = recovered ?? finding;

      let name: string | null = null;
      let lines: ReadonlySet<number> = new Set();
      if (
        recovered !== null ||
        ledgerValueEqual(ledgerSubscript(finding, 'anchor_status'), 'verified')
      ) {
        const target = asString(ledgerSubscript(row, 'target'), 'target');
        const path = asString(ledgerSubscript(anchor, 'path'), 'path');
        const carried = await repo.carry(
          target,
          promoted,
          path,
          ledgerIntervals(ledgerSubscript(anchor, 'intervals')),
        );
        name = carried.name;
        lines = carried.mapped;
      }

      const currentPath = options.currentPath ?? null;
      if (action === 'confirmed' && currentPath !== null) {
        const entries = await repo.entries(promoted);
        const checked = await this.checkQuote(repo, entries, currentPath, options);
        name = checked.name;
        lines = checked.lines;
      }

      const verified =
        name !== null &&
        name.length > 0 &&
        lines.size > 0 &&
        (currentPath !== null ||
          lines.size === ledgerIntervals(ledgerSubscript(anchor, 'intervals')).size);
      const evidence = new Map<string, JsonValue>([
        ['target', promoted],
        ['reason', reason],
        ['anchor_verified', verified],
      ]);
      evidence.set('mapped_path', name);
      evidence.set('mapped_intervals', rangesJson(lines));
      const failureClass = options.failureClass;
      if (failureClass !== undefined && pythonTruthy(failureClass)) {
        evidence.set('failure_class', failureClass);
      }
      if (currentPath !== null && verified) {
        evidence.set('quoted_text', options.quotedText ?? null);
      }
      if (recovered !== null) {
        evidence.set('recovered_anchor', recovered);
        evidence.set('anchor_recovered_from', ledgerSubscript(recovered, 'anchor_recovered_from'));
      }
      if (!pythonTruthy(actor) || !pythonTruthy(reason)) {
        throw integrity('triage requires actor and reason');
      }
      let effective = action;
      if (effective === 'confirmed' && !verified) {
        effective = 'needs-human';
        if (failureClass !== undefined && pythonTruthy(failureClass)) {
          evidence.set('failure_class', 'evidence');
        }
      }
      const fixingCommit = options.fixingCommit ?? null;
      if (effective === 'fixed' || effective === 'already-fixed') {
        if (fixingCommit === null || fixingCommit.length === 0) {
          throw integrity('fixing commit required');
        }
        await repo.resolve(fixingCommit);
        evidence.set('fixing_commit', fixingCommit);
        evidence.set('verification', reason);
      }
      if (effective === 'superseded' && fixingCommit !== null && fixingCommit.length > 0) {
        evidence.set('fixing_commit', await repo.resolve(fixingCommit));
      }
      const canonicalId = options.canonicalId ?? null;
      if (effective === 'duplicate') {
        if (
          canonicalId === null ||
          canonicalId.length === 0 ||
          canonicalId === findingId ||
          (await this.files.readTriage(canonicalId)) === null
        ) {
          throw integrity('duplicate link requires existing canonical issue and evidence');
        }
        evidence.set('canonical_id', canonicalId);
      }

      const evidenceValue = new JsonObject([...evidence]);
      const previous = ledgerSubscript(row, 'previous_event_id');
      const digest = ledgerDigestOf(
        new JsonObject([
          ['previous', previous],
          ['action', effective],
          ['evidence', evidenceValue],
        ]),
      );
      const value = ledgerEvent(
        'finding-event',
        `finding:${findingId}:${digest}`,
        at,
        new JsonObject([
          ['finding_id', findingId],
          ['review_id', ledgerSubscript(row, 'review_id')],
          ['previous_event_id', ledgerSubscript(row, 'previous_event_id')],
          ['action', effective],
          ['evidence', evidenceValue],
          ['actor', actor],
        ]),
      );
      await publication.spool(value); // Durable event before the local transition.
      let next = withKeys(row as JsonObject, [
        ['status', effective],
        ['previous_event_id', ledgerSubscript(value, 'id')],
        ['target_current', promoted],
        ['mapped_path', name],
        ['mapped_intervals', rangesJson(lines)],
        [
          'canonical_id',
          effective === 'duplicate' ? canonicalId : ledgerSubscript(row, 'canonical_id'),
        ],
      ]);
      next = withKeys(next, [['failure_class', evidence.get('failure_class') ?? null]]);
      next = withoutKey(next, 'context_error');
      if (recovered !== null) next = withKeys(next, [['recovered_anchor', recovered]]);
      await this.files.writeTriage(findingId, ledgerCanonicalBytes(next));
      return value;
    });
  }

  /**
   * `Inbox.repair_outcome`: idempotently publish a repair result. Returns
   * `undefined` for both Python `return` paths, the preserved newer
   * generation and the already-published token.
   */
  async repairOutcome(
    publication: FindingPublication,
    findingId: string,
    job: string,
    action: string,
    reason: JsonValue,
    at: string,
    options: RepairOutcomeOptions = {},
  ): Promise<void> {
    await this.inbox.recover(await publication.retained());
    await this.files.withLock(async () => {
      const row = await this.readRow(findingId);
      const current = pythonGet(getOr(row, 'receipt', new JsonObject([])), 'repair_task');
      if (
        current !== undefined &&
        pythonTruthy(current) &&
        (!ledgerValueEqual(current, job) || pythonGet(row, 'status') !== 'delivered')
      ) {
        return; // Preserve newer generations and operator dispositions.
      }
      const evidence = new Map<string, JsonValue>([
        ['repair_task', job],
        ['reason', reason],
        ['fix_pr', options.fixPr ?? null],
      ]);
      if (options.repairBase !== undefined && pythonTruthy(options.repairBase)) {
        evidence.set('repair_base', options.repairBase);
      }
      const failureClass = options.failureClass;
      if (failureClass !== undefined && pythonTruthy(failureClass)) {
        evidence.set('failure_class', failureClass);
      }
      const retained = await publication.retained();
      let effective = action;
      if (
        effective === 'needs-retriage' &&
        failureClass !== undefined &&
        pythonTruthy(failureClass) &&
        failureClass !== 'owner-decision'
      ) {
        if (retryCount(retained, row) >= (options.maxFindingRetries ?? 2))
          effective = 'needs-human';
      }
      const fixingCommit = options.fixingCommit ?? null;
      if (fixingCommit !== null && fixingCommit.length > 0) {
        evidence.set('fixing_commit', fixingCommit);
        evidence.set('verification', reason);
      }
      if (options.sourceEvidence !== undefined && pythonTruthy(options.sourceEvidence)) {
        evidence.set('source_evidence', options.sourceEvidence);
      }
      const evidenceValue = new JsonObject([...evidence]);
      const token = ledgerDigestOf(
        new JsonObject([
          ['job', job],
          ['action', effective],
          ['evidence', evidenceValue],
        ]),
      );
      // Retained outbox records survive acknowledgment and caller crashes.
      const key = `repair-outcome:${token}`;
      if (
        retained.some(
          (item) =>
            ledgerSubscript(item, 'event_type') === 'finding-event' &&
            ledgerSubscript(item, 'source_key') === key,
        )
      ) {
        return;
      }
      const value = ledgerEvent(
        'finding-event',
        key,
        at,
        new JsonObject([
          ['finding_id', findingId],
          ['review_id', ledgerSubscript(row, 'review_id')],
          ['previous_event_id', ledgerSubscript(row, 'previous_event_id')],
          ['action', effective],
          ['evidence', evidenceValue],
          ['actor', 'crq-repair'],
        ]),
      );
      await publication.spool(value);
      const next = withKeys(row as JsonObject, [
        ['status', effective],
        ['previous_event_id', ledgerSubscript(value, 'id')],
        ['failure_class', evidence.get('failure_class') ?? null],
      ]);
      await this.files.writeTriage(findingId, ledgerCanonicalBytes(next));
    });
  }

  /** The explicit-anchor quote check; a refusal falls back to an unmapped anchor. */
  private async checkQuote(
    repo: FindingRepo,
    entries: JsonObject,
    currentPath: string,
    options: TriageOptions,
  ): Promise<{ name: string | null; lines: ReadonlySet<number> }> {
    try {
      const selected = ledgerIntervals(options.currentLines ?? null);
      const entry = entries.get(currentPath);
      if (entry === undefined) throw new LedgerIntegrityError(`'${currentPath}'`);
      const blob = asString(ledgerSubscript(entry, 'blob'), 'blob');
      const text = pythonSplitlines(decodeUtf8(await repo.catBlob(blob)));
      const ordered = [...selected].sort((left, right) => left - right);
      const quote = ordered
        .filter((line) => line >= 1 && line <= text.length)
        .map((line) => text[line - 1])
        .join('\n');
      const quoted = options.quotedText;
      if (
        selected.size === 0 ||
        (ordered[0] as number) < 1 ||
        (ordered[ordered.length - 1] as number) > text.length ||
        typeof quoted !== 'string' ||
        pythonStrip(quoted).length === 0 ||
        quote !== quoted
      ) {
        throw new LedgerIntegrityError('quote mismatch');
      }
      return { name: currentPath, lines: selected };
    } catch (error) {
      if (isRecoverableAnchorError(error)) {
        return { name: null, lines: new Set() };
      }
      throw error;
    }
  }

  private async readRow(findingId: string): Promise<JsonValue> {
    const bytes = await this.files.readTriage(findingId);
    if (bytes === null) throw new FindingRowMissingError(findingId);
    return ledgerLoads(bytes);
  }
}

/** The `needs-retriage` retry walk over retained finding events. */
function retryCount(retained: readonly JsonValue[], row: JsonValue): number {
  const events = new Map<string, JsonValue>();
  for (const item of retained) {
    if (pythonGet(item, 'event_type') === 'finding-event') {
      const id = ledgerSubscript(item, 'id');
      if (typeof id === 'string') events.set(id, item);
    }
  }
  let previous: JsonValue = pythonGet(row, 'previous_event_id') ?? null;
  let count = 0;
  const seen = new Set<string>();
  for (;;) {
    assertHashable(previous);
    if (typeof previous !== 'string' || !events.has(previous) || seen.has(previous)) break;
    seen.add(previous);
    const payload = ledgerSubscript(events.get(previous) as JsonValue, 'payload');
    const klass = pythonGet(getOr(payload, 'evidence', new JsonObject([])), 'failure_class');
    const actor = getOr(payload, 'actor', '');
    const action = pythonGet(payload, 'action');
    if (
      typeof actor === 'string' &&
      actor.startsWith('crq-') &&
      (action === 'needs-human' || action === 'needs-retriage') &&
      klass !== undefined &&
      pythonTruthy(klass) &&
      klass !== 'owner-decision'
    ) {
      count += 1;
    }
    previous = pythonGet(payload, 'previous_event_id') ?? null;
  }
  if (previous !== null) throw integrity('finding retry history is incomplete or cyclic');
  return count;
}

/** One vendor event against the finding's path, title and body. */
function matchesFinding(event: JsonObject, finding: JsonValue): boolean {
  if (event.get('type') !== 'finding') return false;
  const fileName = event.get('fileName');
  const path =
    fileName !== undefined && pythonTruthy(fileName) ? fileName : (event.get('path') ?? null);
  if (!ledgerValueEqual(path, ledgerSubscript(finding, 'path'))) return false;
  const title = event.get('title');
  if (
    !ledgerValueEqual(
      title !== undefined && pythonTruthy(title) ? title : DEFAULT_ANCHOR_TITLE,
      ledgerSubscript(finding, 'title'),
    )
  ) {
    return false;
  }
  const comment = event.get('comment');
  const body = event.get('body');
  const text =
    comment !== undefined && pythonTruthy(comment)
      ? comment
      : body !== undefined && pythonTruthy(body)
        ? body
        : pythonJsonText(event as never, {
            asciiOnly: true,
            sortKeys: false,
            spacedSeparators: true,
          });
  return ledgerValueEqual(text, ledgerSubscript(finding, 'body'));
}
