/**
 * Backfill completion for one counted vendor run (`backfill_history.py`
 * `submitted_scope`/`adapted_terminal_scope`, `backfill_runtime.py`
 * `completion_event`). Inactive: nothing imports this module at runtime.
 *
 * Git and the content store are injected seams, typed locally so this module
 * depends on no merged or unmerged adapter. Everything else is pure: the same
 * raw vendor bytes, item, meta and submission give the same review event.
 */
import { lineRanges } from './backfillAccounting.js';
import {
  findingIntervals,
  REVIEWER_FORMATS,
  terminalScope,
  vendorEvents,
} from './backfillVendorOutput.js';
import { normalizeFinding } from './findingDelivery.js';
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  LEDGER_REPOSITORY,
  ledgerCanonicalBytes,
  ledgerEvent,
  LedgerIntegrityError,
  ledgerPath,
  ledgerScope,
  ledgerSubscript,
  ledgerValueEqual,
  pythonTruthy,
} from './ledger.js';
import { compareCodePoints, pythonJsonText } from './pythonJson.js';
import { pythonStr } from './prReviewFindings.js';

/** The git facts completion needs, resolved by the caller's adapter. */
export interface BackfillRepo {
  /** `repo.entries(rev)`: path to the blob id at that revision. */
  entries(rev: string): ReadonlyMap<string, { readonly blob: string }>;
  /** `repo.changed_intervals(base, head)`: head-side changed lines per path. */
  changedIntervals(base: string, head: string): ReadonlyMap<string, ReadonlySet<number>>;
  /** `git diff --name-only --no-renames -z base head`, decoded as UTF-8. */
  changedPaths(base: string, head: string): readonly string[];
  /** `repo.retain(store, revs)`: the stored git bundle reference. */
  retain(store: BackfillStore, revs: readonly string[]): JsonValue;
  /** `repo.verify_review(event)`: refuse an event the repository cannot back. */
  verifyReview(event: JsonObject): void;
}

export interface BackfillStore {
  /** `store.put(bytes)`: the immutable content reference. */
  put(bytes: Uint8Array): JsonValue;
}

const int = (value: number): JsonNumber => JsonNumber.int(value);

function object(entries: ReadonlyArray<readonly [string, JsonValue]>): JsonObject {
  return new JsonObject(entries);
}

/** `backfill_history.submitted_scope`: head-side hunks of the immutable diff. */
export function submittedScope(repo: BackfillRepo, base: string, head: string): JsonObject[] {
  const entries = repo.entries(head);
  const rows: JsonObject[] = [];
  const changed = [...repo.changedIntervals(base, head)].sort((a, b) =>
    compareCodePoints(a[0], b[0]),
  );
  for (const [name, lines] of changed) {
    const entry = entries.get(name);
    if (lines.size === 0 || entry === undefined) continue;
    rows.push(
      object([
        ['path', name],
        ['blob', entry.blob],
        ['intervals', lineRanges(lines).map(([start, end]) => [int(start), int(end)])],
      ]),
    );
  }
  return rows;
}

const mismatch = (message: string): never => {
  throw new LedgerIntegrityError(message);
};

function isFailure(event: JsonObject): boolean {
  const type = event.get('type');
  return type === 'error' || type === 'action_required';
}

/** `backfill_history.adapted_terminal_scope`: known CLI formats, vendor-confirmed hunks only. */
export function adaptedTerminalScope(
  repo: BackfillRepo,
  raw: Uint8Array,
  item: JsonObject,
  meta: JsonObject,
  proof: JsonObject,
): JsonObject[] {
  const version = proof.get('cli_version');
  if (
    typeof version !== 'string' ||
    !REVIEWER_FORMATS.has(version) ||
    proof.get('format') !== REVIEWER_FORMATS.get(version)
  ) {
    mismatch('unknown reviewer version/output format');
  }
  const bound: Array<readonly [string, JsonValue]> = [
    ['run_id', ledgerSubscript(meta, 'run_id')],
    ['head', ledgerSubscript(item, 'head')],
    ['base', ledgerSubscript(item, 'base')],
    ['attempt_id', ledgerSubscript(item, 'attempt_id')],
  ];
  for (const [key, expected] of bound) {
    if (!ledgerValueEqual(proof.get(key) ?? null, expected))
      mismatch('submission identity mismatch');
  }
  const head = ledgerSubscript(item, 'head');
  const base = ledgerSubscript(item, 'base');
  if (
    !ledgerValueEqual(meta.get('head') ?? null, head) ||
    !ledgerValueEqual(meta.get('base') ?? null, base)
  ) {
    mismatch('run metadata subject mismatch');
  }
  const submitted = submittedScope(repo, base as string, head as string);
  if (!ledgerValueEqual(proof.get('submitted_scope') ?? null, submitted)) {
    mismatch('submitted diff scope mismatch');
  }
  const events = vendorEvents(raw);
  if (events.length === 0 || events.some(isFailure)) mismatch('vendor error or missing terminal');
  const terminal = events[events.length - 1] as JsonObject;
  if (
    terminal.get('type') !== 'complete' ||
    terminal.get('status') !== 'review_completed' ||
    terminal.get('outcome') !== 'completed'
  ) {
    mismatch('unknown or incomplete vendor output');
  }
  const contexts = events.filter((event) => event.get('type') === 'review_context');
  if (
    contexts.length !== 1 ||
    !ledgerValueEqual((contexts[0] as JsonObject).get('baseCommit') ?? null, base)
  ) {
    mismatch('vendor context does not bind submitted base');
  }
  const names = terminal.get('reviewedFiles');
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => typeof name !== 'string') ||
    new Set(names).size !== names.length
  ) {
    mismatch('unknown reviewedFiles format');
  }
  const listed = names as string[];
  const submittedPaths = new Set(repo.changedPaths(base as string, head as string));
  if (listed.some((name) => !submittedPaths.has(name))) mismatch('vendor listed unsubmitted path');
  return submitted.filter((row) => listed.includes(row.get('path') as string));
}

/** `ledger.path(name)` as a predicate: Python catches ValueError and TypeError. */
function usablePath(name: JsonValue): string | null {
  try {
    return ledgerPath(name);
  } catch (error) {
    if (error instanceof LedgerIntegrityError) return null;
    throw error;
  }
}

/** One vendor `finding` event as the normalized, immutable finding. */
function findingOf(
  value: JsonObject,
  entries: ReadonlyMap<string, { readonly blob: string }>,
  runId: JsonValue,
): JsonObject {
  const named = pythonTruthy(value.get('fileName')) ? value.get('fileName') : value.get('path');
  const path = usablePath(named ?? null);
  const entry = path === null ? undefined : entries.get(path);
  // Retained raw bytes stay the triage authority for findings whose anchor is
  // absent or outside the pinned repository.
  const intervals = entry === undefined ? [] : findingIntervals(value);
  const id = value.get('id');
  const comment = value.get('comment');
  const body = value.get('body');
  return normalizeFinding(
    'crq-runner-app',
    runId as string,
    object([
      ['source_id', id === undefined || id === null ? null : pythonStr(id)],
      ['severity', value.has('severity') ? (value.get('severity') as JsonValue) : 'info'],
      ['path', path],
      ['blob', entry?.blob ?? null],
      ['intervals', intervals.map(([start, end]) => [int(start), int(end)])],
      [
        'title',
        pythonTruthy(value.get('title'))
          ? (value.get('title') as JsonValue)
          : 'Unverified vendor finding anchor',
      ],
      [
        'body',
        pythonTruthy(comment)
          ? (comment as JsonValue)
          : pythonTruthy(body)
            ? (body as JsonValue)
            : pythonJsonText(value, {
                asciiOnly: true,
                sortKeys: false,
                keyOrder: 'insertion',
                indent: null,
                spacedSeparators: true,
              }),
      ],
    ]),
  );
}

/** `backfill_runtime.completion_event`: retain raw bytes, then build the review event. */
export function completionEvent(
  repo: BackfillRepo,
  store: BackfillStore,
  item: JsonObject,
  raw: Uint8Array,
  exitCode: JsonValue,
  meta: JsonObject,
  endedAt: string,
  submission: JsonObject | null = null,
): JsonObject {
  const rawRef = store.put(raw);
  const metaRef = store.put(ledgerCanonicalBytes(meta));
  const head = ledgerSubscript(item, 'head') as string;
  const target = ledgerSubscript(item, 'target') as string;
  const gitRef = repo.retain(store, [ledgerSubscript(item, 'base') as string, head, target]);
  let terminalRows: JsonObject[];
  const submissionRefs: JsonValue[] = [];
  if (submission === null) {
    terminalRows = terminalScope(raw, head);
  } else {
    terminalRows = adaptedTerminalScope(repo, raw, item, meta, submission);
    submissionRefs.push(store.put(ledgerCanonicalBytes(submission)));
  }
  const terminal = ledgerScope(terminalRows);
  const requestedRows = ledgerSubscript(item, 'scope');
  const requested = ledgerScope(requestedRows);
  const reviewed: JsonObject[] = [];
  // Walk the original rows: Python's dict keeps their insertion order.
  for (const row of requestedRows as JsonObject[]) {
    const name = row.get('path') as string;
    const blob = row.get('blob') as string;
    const covered = terminal.get(name)?.get(blob);
    const lines = [...((requested.get(name)?.get(blob) as Set<number>) ?? [])].filter((line) =>
      covered?.has(line),
    );
    if (lines.length === 0) continue;
    reviewed.push(
      object([
        ['path', name],
        ['blob', blob],
        ['intervals', lineRanges(lines).map(([start, end]) => [int(start), int(end)])],
      ]),
    );
  }
  const entries = repo.entries(target);
  const runId = ledgerSubscript(meta, 'run_id');
  const findings: JsonValue[] = [];
  for (const value of vendorEvents(raw)) {
    if (value.get('type') !== 'finding') continue;
    findings.push(findingOf(value, entries, runId));
  }
  const field = (key: string): JsonValue => ledgerSubscript(item, key);
  const payload = object([
    ['repo', LEDGER_REPOSITORY],
    ['subject_id', field('subject_id')],
    ['job_id', field('job_id')],
    ['attempt_id', field('attempt_id')],
    [
      'source',
      object([
        ['repo', LEDGER_REPOSITORY],
        ['producer', 'crq-runner-app'],
        ['type', 'crq-run'],
        ['id', runId],
        ['authenticated', true],
      ]),
    ],
    ['base', field('base')],
    ['head', head],
    ['head_tree', field('head_tree')],
    ['target', target],
    ['target_tree', field('target_tree')],
    ['policy_digest', field('construction_policy_digest')],
    ['scope_digest', field('scope_digest')],
    ['paths', field('paths')],
    ['requested_scope', requestedRows],
    ['input_scope', terminalRows],
    ['reviewed_scope', reviewed],
    [
      'completion',
      object([
        ['terminal', true],
        ['skipped', false],
        ['scope_verified', true],
        ['exit_code', exitCode],
        ['errors', []],
      ]),
    ],
    ['outcome', 'completed'],
    ['artifacts', [rawRef, metaRef, gitRef, ...submissionRefs]],
    ['findings', findings],
  ]);
  const value = ledgerEvent(
    'review',
    `${LEDGER_REPOSITORY}:crq-runner-app:${pythonStr(runId)}`,
    endedAt,
    payload,
  );
  repo.verifyReview(value);
  return value;
}
