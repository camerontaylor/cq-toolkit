/**
 * Collection normalisation for external review observations (`review_record.py`).
 *
 * Import identity is `(producer, source id, report digest)`. Repeated ingestion
 * of the same artifact is idempotent; a correction supersedes the original
 * record while retaining it; one malformed import is quarantined with a
 * readable reason and never blocks queue scheduling. A manual/agent record is a
 * historical report: incomplete scope metadata stays unknown, full-branch
 * coverage is never claimed, no findings are synthesized and no independent
 * acceptance verdict is issued.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerEvent,
  ledgerCanonicalBytes,
  ledgerDigestOf,
} from './ledger.js';
import { pythonJsonText, sha256Hex } from './pythonJson.js';

/** `review_ledger.REPORT_PRODUCERS`. */
export const REPORT_PRODUCERS = ['manual', 'agent'] as const;
/** `review_ledger.REPO`: the canonical repository spelling. */
export const LEDGER_REPOSITORY = 'camerontaylor/cq-toolkit';
export const MAX_REPORT_BYTES = 256 * 1024;
/** The publisher refuses a serialized event above 1 MiB. */
export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_EXPANDED_SCOPE_LINES = 2_000_000;

const VERDICT_OUTCOMES: Readonly<Record<string, string>> = {
  APPROVED: 'completed',
  CHANGES_REQUESTED: 'completed',
  COMMENTED: 'completed',
};

/** One submitted manual/agent report, already normalised from the wire. */
export interface SubmittedRecord {
  readonly producer: string;
  readonly id: string;
  readonly reportBytes: Uint8Array;
  readonly repo: string | null;
  readonly head: string | null;
  readonly base: string | null;
  readonly headTree: string | null;
  readonly target: string | null;
  readonly reviewer: string | null;
  readonly authenticatedSubmitter: string | null;
  readonly verdict: string | null;
  readonly claimedScope: JsonValue | null;
  readonly independence: string | null;
  readonly supersedes: string | null;
  readonly forgeEvidence: string | null;
}

export class RecordRefused extends Error {
  override readonly name: string = 'RecordRefused';
}

function artifact(digest: string): JsonObject {
  return new JsonObject([
    ['sha256', digest],
    ['location', `imported-report:${digest}`],
    ['kind', 'report'],
  ]);
}

function scopeConfidence(claimed: JsonValue | null): string {
  return claimed !== null && Array.isArray(claimed) && claimed.length > 0 ? 'claimed' : 'unknown';
}

function completionEvidence(verdict: string | null): string | null {
  if (verdict === null) return null;
  return pythonJsonText(
    new JsonObject([
      ['kind', 'claimed-verdict'],
      ['verdict', verdict],
    ]),
    { asciiOnly: true, sortKeys: true, spacedSeparators: true, indent: null },
  );
}

function scopeRows(claimed: JsonValue | null): JsonValue[] {
  return Array.isArray(claimed) ? claimed : [];
}

/**
 * `review_record.normalize_record`: one report into a retained ledger review
 * event plus its report digest. Never creditable and never vendor-completed.
 */
export function normalizeRecord(
  submitted: SubmittedRecord,
  at: string,
): { readonly value: JsonObject; readonly digestHex: string } {
  if (!(REPORT_PRODUCERS as readonly string[]).includes(submitted.producer)) {
    throw new RecordRefused('record producer must be manual or agent');
  }
  if (submitted.id.length === 0 || submitted.id.length > 200) {
    throw new RecordRefused('record source id is missing or oversized');
  }
  if (submitted.reportBytes.length === 0) {
    throw new RecordRefused('record report bytes are missing');
  }
  if (submitted.reportBytes.length > MAX_REPORT_BYTES) {
    throw new RecordRefused('report exceeds 256 KiB import bound');
  }
  if (submitted.authenticatedSubmitter === null || submitted.authenticatedSubmitter.length === 0) {
    throw new RecordRefused('record requires the authenticated submitter');
  }
  for (const key of ['head', 'base'] as const) {
    const value = submitted[key];
    if (value !== null && !/^[0-9a-f]{40,64}$/.test(value)) {
      throw new RecordRefused(`record ${key} identity is not a commit hash`);
    }
  }
  const claimed = submitted.claimedScope;
  if (claimed !== null && !Array.isArray(claimed)) {
    throw new RecordRefused('claimed scope must be a list of scope rows or absent');
  }
  let expanded = 0;
  for (const row of scopeRows(claimed)) {
    if (!(row instanceof JsonObject) || typeof row.get('path') !== 'string') {
      throw new RecordRefused('claimed scope rows need a path');
    }
    const intervalsValue = row.get('intervals');
    const intervals = intervalsValue === undefined || intervalsValue === null ? [] : intervalsValue;
    if (!Array.isArray(intervals)) {
      throw new RecordRefused('claimed scope intervals must be a list of start/end pairs');
    }
    for (const pair of intervals) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new RecordRefused('claimed scope interval is not a start/end pair');
      }
      const [start, end] = pair;
      if (
        !(start instanceof JsonNumber) ||
        start.kind !== 'int' ||
        start.integer === null ||
        !(end instanceof JsonNumber) ||
        end.kind !== 'int' ||
        end.integer === null ||
        start.integer > end.integer
      ) {
        throw new RecordRefused('claimed scope interval is not a start/end pair');
      }
      expanded += Number(end.integer - start.integer + 1n);
    }
  }
  if (expanded > MAX_EXPANDED_SCOPE_LINES) {
    throw new RecordRefused('claimed scope exceeds the expanded-line budget');
  }
  const declared =
    submitted.verdict === null ? null : (VERDICT_OUTCOMES[submitted.verdict] ?? 'unverified');
  const completion = completionEvidence(submitted.verdict);
  if (declared === 'completed' && completion === null) {
    throw new RecordRefused('completed record requires completion evidence or unknown outcome');
  }
  // A claimed verdict completes the report but never verifies scope.
  const outcome = declared === 'completed' ? 'unverified' : (declared ?? 'unverified');
  const digestHex = sha256Hex(submitted.reportBytes);
  const rows = scopeRows(claimed);
  const branchLabel =
    submitted.target !== null && !/^[0-9a-f]{40,64}$/.test(submitted.target)
      ? submitted.target
      : null;
  const subjectId = (branchLabel === null ? '' : `${branchLabel}@`) + submitted.id;
  const targetCommit = branchLabel === null ? submitted.target : null;
  const versionedId = `${submitted.id}:${digestHex.slice(0, 16)}`;
  const repo = submitted.repo ?? LEDGER_REPOSITORY;
  const payload = new JsonObject([
    ['repo', repo],
    ['subject_id', subjectId],
    ['job_id', `record:${submitted.producer}:${submitted.id}`],
    ['attempt_id', `record:${digestHex.slice(0, 16)}`],
    [
      'source',
      new JsonObject([
        ['repo', repo],
        ['producer', submitted.producer],
        ['type', submitted.producer],
        ['id', versionedId],
        ['authenticated', false],
      ]),
    ],
    [
      'provenance',
      new JsonObject([
        ['authenticated_submitter', submitted.authenticatedSubmitter],
        ['claimed_reviewer', submitted.reviewer ?? 'unknown'],
        ['forge_evidence', submitted.forgeEvidence ?? 'off-forge-import'],
        ['completion_evidence', completion],
        ['scope_confidence', scopeConfidence(claimed)],
        ['independence', submitted.independence ?? null],
      ]),
    ],
    ['base', submitted.base ?? '0'.repeat(40)],
    ['head', submitted.head ?? '0'.repeat(40)],
    ['head_tree', submitted.headTree ?? '0'.repeat(40)],
    ['target', targetCommit ?? '0'.repeat(40)],
    ['target_tree', '0'.repeat(40)],
    ['policy_digest', ledgerDigestOf(new JsonObject([['unknown-policy', true]]))],
    ['scope_digest', ledgerDigestOf(rows)],
    ['paths', []],
    ['requested_scope', rows],
    ['input_scope', rows],
    ['reviewed_scope', []],
    [
      'completion',
      new JsonObject([
        ['terminal', outcome === 'completed'],
        ['skipped', false],
        ['scope_verified', false],
        ['exit_code', JsonNumber.int(outcome === 'completed' ? 0 : -1)],
        ['errors', outcome === 'completed' ? [] : ['no verifiable completion evidence']],
      ]),
    ],
    ['outcome', outcome],
    ['artifacts', [artifact(digestHex)]],
    ['findings', []],
  ]);
  const withSupersedes =
    submitted.supersedes === null
      ? payload
      : new JsonObject([...payload.entries, ['supersedes', submitted.supersedes]]);
  const sourceKey = `${repo}:${submitted.producer}:${versionedId}`;
  return { value: ledgerEvent('review', sourceKey, at, withSupersedes), digestHex };
}

/** `review_record.quarantine_source_key`. */
export function quarantineSourceKey(reason: string, digestHex: string): string {
  return `record:${digestHex.slice(0, 16)}:quarantine:${ledgerDigestOf(reason).slice(0, 16)}`;
}

/** `review_record._quarantine_event`; `null` when the disposition is unrepresentable. */
export function quarantineEvent(
  reason: string,
  digestHex: string,
  submitted: SubmittedRecord,
  at: string,
): JsonObject | null {
  const claimed = submitted.producer;
  const typed = (REPORT_PRODUCERS as readonly string[]).includes(claimed) ? claimed : 'manual';
  const source = new JsonObject([
    ['repo', LEDGER_REPOSITORY],
    ['producer', claimed.length > 0 ? claimed : 'unknown'],
    ['type', typed],
    ['id', submitted.id.length > 0 ? submitted.id : 'unknown'],
    ['authenticated', false],
  ]);
  const payload = new JsonObject([
    [
      'source',
      new JsonObject([
        ...source.entries.filter(([key]) => key !== 'id'),
        ['id', `${String(source.get('id'))}:${digestHex.slice(0, 16)}`],
      ]),
    ],
    ['source_digest', digestHex],
    ['result', 'unverified'],
    ['reason', reason],
    ['review_id', null],
    ['duplicate_id', null],
    ['artifacts', [artifact(digestHex)]],
  ]);
  try {
    return ledgerEvent('import-result', quarantineSourceKey(reason, digestHex), at, payload);
  } catch (error) {
    if (error instanceof LedgerIntegrityError) return null;
    throw error;
  }
}

/** `review_record.import_record`: idempotent ingestion against retained events. */
export function importRecord(
  submitted: SubmittedRecord,
  at: string,
  existing: readonly JsonObject[],
): { readonly events: readonly JsonObject[]; readonly action: string } {
  let value: JsonObject;
  let digestHex: string;
  try {
    ({ value, digestHex } = normalizeRecord(submitted, at));
  } catch (error) {
    if (!(error instanceof RecordRefused) && !(error instanceof LedgerIntegrityError)) throw error;
    const reason = error.message;
    const digest = sha256Hex(submitted.reportBytes);
    const key = quarantineSourceKey(reason, digest);
    const previous = existing.find(
      (candidate) =>
        candidate.get('event_type') === 'import-result' && candidate.get('source_key') === key,
    );
    if (previous !== undefined) return { events: [previous], action: `quarantined:${reason}` };
    const value = quarantineEvent(reason, digest, submitted, at);
    if (value === null) return { events: [], action: `refused:${reason}` };
    return { events: [value], action: `quarantined:${reason}` };
  }
  const previous = existing.find((candidate) => {
    if (candidate.get('event_type') !== 'review') return false;
    const payload = candidate.get('payload');
    if (!(payload instanceof JsonObject)) return false;
    const artifacts = payload.get('artifacts');
    return (
      candidate.get('source_key') === value.get('source_key') &&
      Array.isArray(artifacts) &&
      artifacts.some((entry) => entry instanceof JsonObject && entry.get('sha256') === digestHex)
    );
  });
  if (previous !== undefined) {
    return { events: [], action: `duplicate:${String(previous.get('id'))}` };
  }
  const payload = value.get('payload');
  const supersedes = payload instanceof JsonObject ? payload.get('supersedes') : null;
  if (typeof supersedes === 'string') {
    const original = existing.find((candidate) => candidate.get('id') === supersedes);
    if (original === undefined)
      return { events: [], action: 'refused:superseded record is unknown' };
    if (original.get('event_type') !== 'review') {
      return { events: [], action: 'refused:superseded record is not a review' };
    }
  }
  return { events: [value], action: `record:${String(value.get('id'))}` };
}

/** The serialized event bound the publisher enforces. */
export function eventExceedsPublisherBound(value: JsonObject): boolean {
  return ledgerCanonicalBytes(value).length > MAX_EVENT_BYTES;
}
