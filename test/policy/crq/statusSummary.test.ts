/**
 * Differential tests for the read-only crq status projection (migration A1).
 *
 * Two sources of truth are replayed:
 *
 * - the shared group-P families `summary`, `status-helpers` and `usage`
 *   (`fixtures/group-p/`, owned by the 0.3 foundation and NOT edited here), and
 * - the A1 families under `fixtures/a1-status/`, emitted by `emit.py` from the
 *   Python oracle at the same commit: receipt-bound `merged_current`, the
 *   summarize edges from `test_status_summary.py`, and `client_health.snapshot`.
 *
 * The Python comparison is exact for every field. The only fields removed
 * before comparing are the two additive #1420 keys, `label` and
 * `repair_origin`; nothing else is normalised, so an unrelated divergence
 * fails the test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ClientHealthError, clientHealthSnapshot } from '../../../src/policy/crq/clientHealth.js';
import {
  JsonNumber,
  JsonObject,
  comparePythonNumbers,
  parseJsonValue,
  pythonNumbersEqual,
  toPlainJson,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  pythonJsonText,
  receiptJsonBytes,
  receiptJsonDigest,
  receiptJsonText,
  sha256Hex,
} from '../../../src/policy/crq/pythonJson.js';
import {
  LABEL_MAX_UNITS,
  StatusSummaryError,
  boundLabel,
  epochSeconds,
  labelForItem,
  mergedCurrent,
  pythonIntValue,
  repairRecordIndex,
  reposSummary,
  summarize,
  type StatusSummaryView,
  type SummarizeOptions,
} from '../../../src/policy/crq/statusSummary.js';
import { currentEquivalence, reusableCurrent } from '../../../src/policy/crq/receiptIdentity.js';
import { parseCrqState, stateValueWithNumbers } from '../../../src/policy/crq/state.js';
import { parseUtc } from '../../../src/policy/crq/utc.js';
import {
  UsageSlotsError,
  nextSlot,
  parseUsage,
  type VendorUsage,
} from '../../../src/policy/crq/usageSlots.js';

const GROUP_P = new URL('../../../apps/crq-python/fixtures/group-p/', import.meta.url);
const A1 = new URL('../../../apps/crq-python/fixtures/a1-status/', import.meta.url);
const COMPACT = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion' as const,
  indent: null,
};

type RecordValue = Record<string, unknown>;

interface Expectation {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly message?: string;
}

interface VectorCase {
  readonly family: string;
  readonly name: string;
  readonly source: string;
  readonly input: RecordValue;
  readonly expect: Expectation;
}

interface LosslessVectorCase extends VectorCase {
  readonly expectBytes?: string;
  readonly expectCoreOnly?: boolean;
}

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly pythonError: string; readonly message: string };

function loadFamily(directory: URL, name: string): VectorCase[] {
  // Keep the JSON literally: `usage.limit: 3.0` must stay a float so the
  // oracle fallback is exercised through the same shape a byte reader sees.
  const lossless = parseJsonValue(readFileSync(new URL(`${name}.json`, directory), 'utf8'));
  if (!(lossless instanceof JsonObject)) throw new Error(`${name}: root is not an object`);
  const root = recordOf(toPlainJson(lossless), name);
  const cases = root.cases;
  const losslessCases = lossless.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  if (!Array.isArray(losslessCases)) throw new Error(`${name}: missing lossless cases`);
  return cases.map((entry, index) => {
    const row = recordOf(entry, name);
    const expectation = recordOf(row.expect, `${name}/${String(row.name)}`);
    const input = recordOf(row.input, `${name} input`);
    spliceLosslessUsage(input, losslessCases[index]);
    return {
      family: name,
      name: stringOf(row.name, 'name'),
      source: stringOf(row.source, 'source'),
      input,
      expect: {
        ok: expectation.ok === true,
        value: expectation.value,
        ...(typeof expectation.error === 'string' ? { error: expectation.error } : {}),
        ...(typeof expectation.message === 'string' ? { message: expectation.message } : {}),
      },
    };
  });
}

/**
 * Load a family without materialising numbers inside `input.queue`, and keep
 * the Python reserialisation of `expect.value` as `expect.bytes`.
 *
 * Config/status/events keep their materialised shape because the projection
 * consumes them as ordinary values; the queue is the boundary under test.
 */
function loadLosslessFamily(directory: URL, name: string): LosslessVectorCase[] {
  const lossless = parseJsonValue(readFileSync(new URL(`${name}.json`, directory), 'utf8'));
  if (!(lossless instanceof JsonObject)) throw new Error(`${name}: root is not an object`);
  const cases = lossless.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  return cases.map((entry, index) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${name}: case ${index} is not an object`);
    const expectation = entry.get('expect');
    const inputDocument = entry.get('input');
    const caseName = entry.get('name');
    const source = entry.get('source');
    if (!(expectation instanceof JsonObject) || !(inputDocument instanceof JsonObject)) {
      throw new Error(`${name}: case ${index} has no input/expect object`);
    }
    if (typeof caseName !== 'string' || typeof source !== 'string') {
      throw new Error(`${name}: case ${index} has no name/source`);
    }
    const materialised = new Set(['status', 'heartbeat', 'config', 'events', 'now']);
    const input: RecordValue = {};
    for (const [key, value] of inputDocument.entries) {
      input[key] = materialised.has(key) ? toPlainJson(value) : toPlainJsonRetainingNumbers(value);
    }
    const value = expectation.get('value');
    const error = expectation.get('error');
    const bytes = expectation.get('bytes');
    return {
      family: name,
      name: caseName,
      source,
      input,
      expect: {
        ok: expectation.get('ok') === true,
        ...(value === undefined ? {} : { value: toPlainJson(value) }),
        ...(typeof error === 'string' ? { error } : {}),
        ...(typeof expectation.get('message') === 'string'
          ? { message: expectation.get('message') as string }
          : {}),
      },
      ...(typeof bytes === 'string' ? { expectBytes: bytes } : {}),
      ...(expectation.get('core_only') === true ? { expectCoreOnly: true } : {}),
    };
  });
}

/** Restore the one numeric lexeme `summarize` still distinguishes. */
function spliceLosslessUsage(input: RecordValue, losslessCase: unknown): void {
  if (!(losslessCase instanceof JsonObject)) return;
  const losslessInput = losslessCase.get('input');
  const queue = input.queue;
  if (!(losslessInput instanceof JsonObject) || !isRecordObject(queue)) return;
  const queueDocument = losslessInput.get('queue');
  const usage = queue.usage;
  if (!(queueDocument instanceof JsonObject) || !isRecordObject(usage)) return;
  const usageDocument = queueDocument.get('usage');
  if (!(usageDocument instanceof JsonObject)) return;
  const limit = usageDocument.get('limit');
  if (limit instanceof JsonNumber) usage.limit = limit;
}

function recordOf(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as RecordValue;
}

function isRecordObject(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}: expected a string`);
  return value;
}

function arrayOf(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value;
}

function numberOf(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new Error(`${label}: expected a number`);
  return value;
}

function capture(action: () => unknown): Outcome {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return {
      ok: false,
      pythonError: pythonErrorName(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function pythonErrorName(error: unknown): string {
  if (error instanceof StatusSummaryError) return error.pythonError;
  if (error instanceof ClientHealthError) return error.pythonError;
  if (error instanceof UsageSlotsError) return error.pythonError;
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'ValueError';
  return error instanceof Error ? error.name : 'Error';
}

/** JSON round trip: drops absent optional keys and keeps null explicit. */
function plain(value: unknown): unknown {
  // JsonNumber keeps an exact integer for the wire writer; materialise it only
  // for the rounded generic comparison. Byte-exact large-integer cases below
  // compare through receiptJsonText instead.
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      entry instanceof JsonNumber ? toPlainJson(entry) : entry,
    ),
  ) as unknown;
}

function assertOutcome(vector: VectorCase, outcome: Outcome): void {
  const label = `${vector.family}/${vector.name}`;
  if (vector.expect.ok) {
    expect(outcome.ok, label).toBe(true);
    if (!outcome.ok) return;
    expect(plain(outcome.value), label).toEqual(vector.expect.value);
    return;
  }
  expect(outcome.ok, label).toBe(false);
  if (outcome.ok) return;
  // The group-P contract compares `ok`/`error`/`value` only: exception text is
  // diagnostic and varies across Python patch levels (and our AttributeError
  // analogues). `expect.message` stays in the fixture for humans.
  expect(outcome.pythonError, label).toBe(vector.expect.error);
}

/** Remove ONLY the additive #1420 keys; everything else compares exactly. */
function withoutAdditiveKeys(view: StatusSummaryView): unknown {
  const clone = plain(view) as { pending_items: RecordValue[] };
  for (const item of clone.pending_items) {
    delete item.label;
    delete item.repair_origin;
  }
  return clone;
}

function runSummarize(input: RecordValue, options?: SummarizeOptions): unknown {
  return summarize(
    recordOf(input.status, 'status'),
    recordOf(input.queue, 'queue'),
    recordOf(input.heartbeat, 'heartbeat'),
    recordOf(input.config, 'config'),
    arrayOf(input.events, 'events'),
    numberOf(input.now, 'now'),
    options,
  );
}

function receiptReader(input: RecordValue) {
  const receipts = isRecordObject(input.receipts) ? input.receipts : undefined;
  if (receipts === undefined) return undefined;
  return (receiptId: string): Uint8Array | null => {
    if (!Object.prototype.hasOwnProperty.call(receipts, receiptId)) return null;
    return receiptJsonBytes(receipts[receiptId]);
  };
}

function runMergedCurrent(input: RecordValue): unknown {
  return mergedCurrent(recordOf(input.queue, 'queue'), receiptReader(input));
}

function runReposSummary(input: RecordValue): unknown {
  return reposSummary(
    recordOf(input.queue, 'queue'),
    input.primary,
    arrayOf(input.configured, 'configured'),
  );
}

function usageOf(value: unknown): VendorUsage | null {
  if (value === null || value === undefined) return null;
  const row = recordOf(value, 'usage');
  const usage: { -readonly [K in keyof VendorUsage]: VendorUsage[K] } = {};
  for (const key of ['remaining', 'limit', 'rollingWindowMs', 'fullCapacityInMs'] as const) {
    if (typeof row[key] === 'number') usage[key] = row[key];
  }
  return usage;
}

function runUsageVector(vector: VectorCase): unknown {
  if (vector.source === 'usage_slots.parse_usage') {
    return parseUsage(stringOf(vector.input.stream, 'stream'));
  }
  if (vector.source !== 'usage_slots.next_slot') {
    throw new Error(`unhandled usage source ${vector.source}`);
  }
  const at = parseUtc(vector.input.at);
  if (at === null) throw new Error('next_slot fixture has an invalid at');
  const starts = arrayOf(vector.input.starts, 'starts').map((value) => {
    const instant = parseUtc(value);
    if (instant === null) throw new Error('next_slot fixture has an invalid start');
    return instant;
  });
  const result = nextSlot(starts, at, usageOf(vector.input.usage));
  return { utc: result === null ? null : result.iso };
}

function runStatusHelper(vector: VectorCase): unknown {
  switch (vector.source) {
    case 'status_summary.timestamp':
      return { epoch: epochSeconds(vector.input.value) };
    case 'status_summary.merged_current':
      return runMergedCurrent(vector.input);
    case 'status_summary.repos_summary':
      return runReposSummary(vector.input);
    default:
      throw new Error(`unhandled status-helper source ${vector.source}`);
  }
}

function runA1Vector(vector: VectorCase): unknown {
  switch (vector.source) {
    case 'status_summary.summarize':
      return runSummarize(vector.input);
    case 'status_summary.merged_current':
      return runMergedCurrent(vector.input);
    case 'client_health.snapshot':
      return clientHealthSnapshot(
        recordOf(vector.input.queue, 'queue'),
        numberOf(vector.input.now ?? 0, 'now'),
      );
    default:
      throw new Error(`unhandled A1 source ${vector.source}`);
  }
}

function runLosslessSummarize(input: RecordValue): unknown {
  return summarize(
    recordOf(input.status, 'status'),
    recordOf(input.queue, 'queue'),
    recordOf(input.heartbeat, 'heartbeat'),
    recordOf(input.config, 'config'),
    arrayOf(input.events, 'events'),
    numberOf(input.now, 'now'),
  );
}

function runLosslessMergedCurrent(input: RecordValue): unknown {
  const raw = isRecordObject(input.receipt_bytes) ? input.receipt_bytes : {};
  return mergedCurrent(recordOf(input.queue, 'queue'), (receiptId) => {
    const encoded = raw[receiptId];
    return typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : null;
  });
}

function parseNumericText(text: string): JsonValue {
  return parseJsonValue(text, {
    parseConstant: (raw) =>
      JsonNumber.float(
        raw === 'NaN'
          ? Number.NaN
          : raw === 'Infinity'
            ? Number.POSITIVE_INFINITY
            : Number.NEGATIVE_INFINITY,
      ),
  });
}

function runNumericVector(input: RecordValue): unknown {
  const left = parseNumericText(stringOf(input.a, 'a'));
  const right = parseNumericText(stringOf(input.b, 'b'));
  const equal = pythonNumbersEqual(left, right);
  const compare = comparePythonNumbers(left, right);
  return {
    equal: equal === true,
    compare,
    ...(compare === null ? { error: 'TypeError' } : {}),
  };
}

function runLosslessA1Vector(vector: LosslessVectorCase): unknown {
  switch (vector.source) {
    case 'status_summary.summarize':
      return runLosslessSummarize(vector.input);
    case 'status_summary.merged_current':
      return runLosslessMergedCurrent(vector.input);
    case 'review_receipt.current_equivalence':
      return { digest: currentEquivalence(vector.input.capture) };
    case 'review_receipt.digest':
      return {
        float: receiptJsonDigest(vector.input.float_paths as JsonValue),
        bigint: receiptJsonDigest(vector.input.bigint_paths as JsonValue),
      };
    case 'python.numeric_compare':
      return runNumericVector(vector.input);
    default:
      throw new Error(`unhandled lossless A1 source ${vector.source}`);
  }
}

/** Remove only the two additive #1420 keys without materialising JsonNumber. */
function withoutAdditiveLossless(view: StatusSummaryView): unknown {
  const pending = view.pending_items.map((item) => {
    const copy: RecordValue = { ...item };
    delete copy.label;
    delete copy.repair_origin;
    return copy;
  });
  return { ...(view as unknown as RecordValue), pending_items: pending };
}

describe.each(loadFamily(GROUP_P, 'summary'))('group-p summary/$name', (vector) => {
  test('every non-additive field matches the Python oracle', () => {
    const outcome = capture(() => runSummarize(vector.input));
    if (!vector.expect.ok || !outcome.ok) {
      assertOutcome(vector, outcome);
      return;
    }
    expect(withoutAdditiveKeys(outcome.value as StatusSummaryView)).toEqual(vector.expect.value);
  });
});

describe.each(loadFamily(GROUP_P, 'status-helpers'))('group-p status-helpers/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    assertOutcome(
      vector,
      capture(() => runStatusHelper(vector)),
    );
  });
});

describe.each(loadFamily(GROUP_P, 'usage'))('group-p usage/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    assertOutcome(
      vector,
      capture(() => runUsageVector(vector)),
    );
  });
});

describe.each(loadFamily(A1, 'summarize'))('a1 summarize/$name', (vector) => {
  test('every non-additive field matches the Python oracle', () => {
    const outcome = capture(() => runSummarize(vector.input));
    if (!vector.expect.ok || !outcome.ok) {
      assertOutcome(vector, outcome);
      return;
    }
    expect(withoutAdditiveKeys(outcome.value as StatusSummaryView)).toEqual(vector.expect.value);
  });
});

describe.each(loadFamily(A1, 'merged-current'))('a1 merged-current/$name', (vector) => {
  test('matches the Python oracle, including receipt refusals', () => {
    assertOutcome(
      vector,
      capture(() => runA1Vector(vector)),
    );
  });
});

describe.each(loadFamily(A1, 'client-health'))('a1 client-health/$name', (vector) => {
  test('matches the Python oracle', () => {
    assertOutcome(
      vector,
      capture(() => runA1Vector(vector)),
    );
  });
});

describe.each(
  loadLosslessFamily(A1, 'passthrough-summarize').filter((vector) => !vector.expectCoreOnly),
)('a1 passthrough summarize/$name', (vector) => {
  test('summary bytes match Python reserialisation exactly', () => {
    const outcome = capture(() => runLosslessA1Vector(vector));
    if (!vector.expect.ok || !outcome.ok) {
      assertOutcome(vector, outcome);
      return;
    }
    if (vector.expectBytes === undefined) throw new Error(`${vector.name}: missing expect.bytes`);
    expect(
      pythonJsonText(withoutAdditiveLossless(outcome.value as StatusSummaryView), COMPACT),
    ).toBe(vector.expectBytes);
  });
});

describe.each(loadLosslessFamily(A1, 'passthrough-receipt'))(
  'a1 passthrough receipt/$name',
  (vector) => {
    test('raw receipt bytes and numeric identity match Python', () => {
      const outcome = capture(() => runLosslessA1Vector(vector));
      if (!vector.expect.ok || !outcome.ok) {
        assertOutcome(vector, outcome);
        return;
      }
      if (vector.expectBytes === undefined) {
        expect(plain(outcome.value)).toEqual(vector.expect.value);
        return;
      }
      expect(pythonJsonText(outcome.value, COMPACT)).toBe(vector.expectBytes);
    });
  },
);

describe.each(loadLosslessFamily(A1, 'numeric'))('a1 numeric/$name', (vector) => {
  test('Python equality and ordering match the oracle', () => {
    assertOutcome(
      vector,
      capture(() => runLosslessA1Vector(vector)),
    );
  });
});

test('passthrough receipt fixtures retain the exact Python writer bytes', () => {
  for (const vector of loadLosslessFamily(A1, 'passthrough-receipt')) {
    const bytes = vector.input.receipt_bytes;
    if (!isRecordObject(bytes)) continue;
    for (const [id, encoded] of Object.entries(bytes)) {
      if (typeof encoded !== 'string') throw new Error(`${vector.name}: receipt bytes not text`);
      expect(sha256Hex(Buffer.from(encoded, 'base64'))).toBe(id);
    }
  }
});

describe('existing group-P families stay the foundation', () => {
  test('the A1 families are separate files, not additions to group-P', () => {
    for (const name of ['summarize', 'merged-current', 'client-health']) {
      expect(() => loadFamily(A1, name)).not.toThrow();
    }
  });

  test('a changed non-additive field fails the differential', () => {
    const [vector] = loadFamily(GROUP_P, 'summary');
    if (vector === undefined) throw new Error('summary vectors are empty');
    const outcome = capture(() => runSummarize(vector.input));
    if (!outcome.ok) throw new Error('fixture case unexpectedly failed');
    const altered = plain(withoutAdditiveKeys(outcome.value as StatusSummaryView)) as RecordValue;
    altered.starts_cap = numberOf(altered.starts_cap, 'starts_cap') + 1;
    expect(altered).not.toEqual(vector.expect.value);
  });
});

// ---------------------------------------------------------------------------
// Additive #1420 fields (TypeScript-only product decision; no Python patch).

const RUN = 'pr1304-20261109T082400Z';
const NOW = 1_794_225_600;

function summarizeQueue(queue: RecordValue, options?: SummarizeOptions): StatusSummaryView {
  return summarize(
    { generated_at: '2026-11-09T11:55:00Z' },
    queue,
    {},
    { repo: 'owner/repo', max_starts_per_hour: 8 },
    [],
    NOW,
    options,
  );
}

function repairRecord(verdicts: readonly RecordValue[]): RecordValue {
  return { state: 'published', verdicts };
}

describe('#1420 pending_items label and repair_origin', () => {
  test('a fix PR carries its run and the first verdict path and reason', () => {
    const view = summarizeQueue({
      items: [
        {
          id: 'pr1304',
          kind: 'open',
          state: 'done',
          repair_runs: {
            [RUN]: repairRecord([
              {
                job: `${RUN}-F1`,
                verdict: 'FIXED',
                reason: 'gitLsRemoteRef now parses only the redacted stdout listing',
                finding: { path: 'src/adapters/git/ratchetGit.ts', severity: 'major' },
              },
              {
                job: `${RUN}-F2`,
                verdict: 'FIXED',
                reason: 'second finding',
                finding: { path: 'src/adapters/git/other.ts', severity: 'minor' },
              },
            ]),
          },
        },
        {
          id: 'pr1400',
          kind: 'open',
          state: 'pending',
          pr: 1400,
          order: 0,
          cycles: [],
          repair_origin: RUN,
        },
      ],
    });
    expect(view.pending_items).toHaveLength(1);
    expect(view.pending_items[0]?.repair_origin).toBe(RUN);
    expect(view.pending_items[0]?.label).toBe(
      'src/adapters/git/ratchetGit.ts: gitLsRemoteRef now parses only the redacted stdout listing (+1)',
    );
  });

  test('the label falls back to a finding title, then body, never a transcript', () => {
    const withTitle = summarizeQueue({
      items: [
        {
          id: 'pr1',
          kind: 'open',
          state: 'done',
          repair_runs: {
            [RUN]: repairRecord([
              { verdict: 'FIXED', finding: { path: 'a.ts', title: 'Guard missing' } },
            ]),
          },
        },
        {
          id: 'fix',
          kind: 'open',
          state: 'pending',
          pr: 2,
          order: 0,
          cycles: [],
          repair_origin: RUN,
        },
      ],
    });
    expect(withTitle.pending_items[0]?.label).toBe('a.ts: Guard missing');
    const withBody = summarizeQueue({
      items: [
        {
          id: 'pr1',
          kind: 'open',
          state: 'done',
          repair_runs: {
            [RUN]: repairRecord([
              { verdict: 'FIXED', finding: { path: 'a.ts', body: 'Body text\nwith a break' } },
            ]),
          },
        },
        {
          id: 'fix',
          kind: 'open',
          state: 'pending',
          pr: 2,
          order: 0,
          cycles: [],
          repair_origin: RUN,
        },
      ],
    });
    expect(withBody.pending_items[0]?.label).toBe('a.ts: Body text with a break');
  });

  test('an unresolvable run keeps repair_origin and falls back to the title', () => {
    const view = summarizeQueue({
      items: [
        {
          id: 'fix',
          kind: 'open',
          state: 'pending',
          pr: 2,
          order: 0,
          cycles: [],
          repair_origin: 'missing-run',
          title: 'fix: Address CodeRabbit findings from missing-run',
        },
      ],
    });
    expect(view.pending_items[0]?.repair_origin).toBe('missing-run');
    expect(view.pending_items[0]?.label).toBe('fix: Address CodeRabbit findings from missing-run');
  });

  test('a PR-less item uses the injected commit subject, and omits the label without one', () => {
    const queue = {
      items: [
        {
          kind: 'merged-current',
          state: 'pending',
          order: 0,
          pr: 5,
          merge_commit: 'a'.repeat(40),
          subject: { repo: 'owner/repo', pr: 5 },
        },
      ],
    };
    const withSubject = summarizeQueue(queue, {
      commitSubjects: new Map([['a'.repeat(40), 'feat: add the thing']]),
    });
    expect(withSubject.pending_items[0]?.label).toBe('feat: add the thing');
    const withoutSubject = summarizeQueue(queue);
    expect(withoutSubject.pending_items[0]).not.toHaveProperty('label');
  });

  test('the latest cycle label is the last queue-text fallback', () => {
    const view = summarizeQueue({
      items: [
        {
          kind: 'push-current',
          state: 'pending',
          order: 0,
          cycles: [{ label: 'older' }, { label: 'push range abc..def at 123' }],
        },
      ],
    });
    expect(view.pending_items[0]?.label).toBe('push range abc..def at 123');
  });

  test('a non-string repair_origin is ignored, not echoed', () => {
    const view = summarizeQueue({
      items: [{ id: 'x', kind: 'open', state: 'pending', order: 0, cycles: [], repair_origin: 7 }],
    });
    expect(view.pending_items[0]).not.toHaveProperty('repair_origin');
  });

  test('labelForItem indexes repair runs by first queue occurrence', () => {
    const items = [
      {
        repair_runs: {
          [RUN]: repairRecord([{ verdict: 'FIXED', reason: 'first', finding: { path: 'a' } }]),
        },
      },
      {
        repair_runs: {
          [RUN]: repairRecord([{ verdict: 'FIXED', reason: 'second', finding: { path: 'b' } }]),
        },
      },
    ];
    const index = repairRecordIndex(items);
    expect(labelForItem({ repair_origin: RUN }, index)).toBe('a: first');
  });
});

describe('label bounds: UTF-16 units and Unicode safety', () => {
  test('120 units stays, 121 truncates with one ellipsis', () => {
    expect(boundLabel('x'.repeat(LABEL_MAX_UNITS))).toBe('x'.repeat(LABEL_MAX_UNITS));
    const truncated = boundLabel('x'.repeat(LABEL_MAX_UNITS + 1));
    expect(truncated).toHaveLength(LABEL_MAX_UNITS);
    expect(truncated.endsWith('…')).toBe(true);
  });

  test('an astral character is never split into a lone surrogate', () => {
    const astral = '😀'.repeat(100);
    const truncated = boundLabel(`a.ts: ${astral}`);
    expect(truncated.length).toBeLessThanOrEqual(LABEL_MAX_UNITS);
    expect(hasLoneSurrogate(truncated)).toBe(false);
  });

  test('multi-line reasons collapse to one line before bounding', () => {
    const view = summarizeQueue({
      items: [
        {
          id: 'pr1',
          kind: 'open',
          state: 'done',
          repair_runs: {
            [RUN]: repairRecord([
              { verdict: 'FIXED', reason: 'x\n\t '.repeat(60), finding: { path: 'a.ts' } },
            ]),
          },
        },
        {
          id: 'fix',
          kind: 'open',
          state: 'pending',
          pr: 2,
          order: 0,
          cycles: [],
          repair_origin: RUN,
        },
      ],
    });
    const label = view.pending_items[0]?.label ?? '';
    expect(label).not.toMatch(/\s{2,}/u);
    expect(label).not.toContain('\n');
    expect(label).not.toContain('\t');
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX_UNITS);
  });
});

describe('Python int rules survive materialisation and lossless input', () => {
  test('pythonIntValue mirrors type(value) is int', () => {
    expect(pythonIntValue(8)).toBe(8);
    expect(pythonIntValue(JsonNumber.int(8))).toBe(8);
    expect(pythonIntValue(JsonNumber.float(8))).toBeNull();
    expect(pythonIntValue(8.5)).toBeNull();
    expect(pythonIntValue(true)).toBeNull();
    expect(pythonIntValue('8')).toBeNull();
    expect(pythonIntValue(0)).toBe(0);
    expect(pythonIntValue(-1)).toBe(-1);
    for (const [value, raw] of [
      [1e20, '100000000000000000000'],
      [2 ** 53, '9007199254740992'],
      [JsonNumber.int('9007199254740992'), '9007199254740992'],
      [JsonNumber.int('9007199254740993'), '9007199254740993'],
    ] as const) {
      const exact = pythonIntValue(value);
      expect(exact).toBeInstanceOf(JsonNumber);
      expect((exact as JsonNumber).raw).toBe(raw);
    }
    expect(pythonIntValue(JsonNumber.int('9007199254740991'))).toBe(9007199254740991);
  });

  test('the parsed queue boundary keeps exact int and integral-float lexemes', () => {
    const state = parseCrqState('queue.schema.json', '{"items":[],"usage":{"limit":3.00}}');
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const queue = stateValueWithNumbers(state, [['usage', 'limit']]) as RecordValue;
    const usage = queue.usage as RecordValue;
    expect(usage.limit).toBeInstanceOf(JsonNumber);
    const limit = usage.limit as JsonNumber;
    expect(limit.kind).toBe('float');
    expect(limit.raw).toBe('3.00');

    const capFor = (text: string) => {
      const accepted = parseCrqState('queue.schema.json', text);
      if (!accepted.ok) throw new Error(accepted.issues.join('; '));
      const parsed = stateValueWithNumbers(accepted, [['usage', 'limit']]) as RecordValue;
      return summarize(
        { generated_at: '2026-11-09T11:55:00Z' },
        parsed,
        {},
        { max_starts_per_hour: 10 },
        [],
        NOW,
      ).starts_cap;
    };
    expect(capFor('{"items":[],"usage":{"limit":3}}')).toBe(3);
    for (const literal of ['3.0', '3.00', '3e0', '30e-1', '0.3e1']) {
      expect(capFor(`{"items":[],"usage":{"limit":${literal}}}`), literal).toBe(10);
    }
    expect(capFor('{"items":[]}')).toBe(10);
  });

  test('large integer and float caps keep the Python oracle bytes', () => {
    const cases: Array<[literal: string, fixture: string]> = [
      ['9007199254740991', 'usage-limit-safe-neighbor-is-kept'],
      ['9007199254740992', 'usage-limit-large-exact-int-is-kept'],
      ['9007199254740993', 'usage-limit-large-unrepresentable-int-is-kept'],
      ['-9007199254740993', 'usage-limit-large-negative-falls-back'],
      ['9007199254740992.0', 'usage-limit-large-exact-float-falls-back'],
      ['9007199254740993.0', 'usage-limit-large-integral-float-falls-back'],
      ['9.007199254740993e15', 'usage-limit-large-integral-float-falls-back'],
    ];
    for (const [literal, fixture] of cases) {
      const state = parseCrqState('queue.schema.json', `{"items":[],"usage":{"limit":${literal}}}`);
      if (!state.ok) throw new Error(`${literal}: ${state.issues.join('; ')}`);
      const queue = stateValueWithNumbers(state, [['usage', 'limit']]) as RecordValue;
      const summary = summarize(
        { generated_at: '2026-10-31T00:00:00Z' },
        queue,
        {},
        { max_starts_per_hour: 10 },
        [],
        NOW,
      );
      const expected = losslessStartsCap(fixture);
      expect(receiptJsonText({ starts_cap: summary.starts_cap }), literal).toBe(
        receiptJsonText({ starts_cap: expected }),
      );
    }
  });

  test('a lossless float limit falls back to the configured cap', () => {
    const fallback = summarize(
      { generated_at: '2026-11-09T11:55:00Z' },
      { items: [], usage: { limit: JsonNumber.float(8) } },
      {},
      { max_starts_per_hour: 5 },
      [],
      NOW,
    );
    expect(fallback.starts_cap).toBe(5);
  });

  test('a lossless integral limit is reused from the queue bytes', () => {
    expect(losslessSummary('{"items":[],"usage":{"limit":8}}').starts_cap).toBe(8);
  });

  test('a lossless integral float limit falls back to the configured cap', () => {
    expect(losslessSummary('{"items":[],"usage":{"limit":3.0}}').starts_cap).toBe(5);
  });
});

/**
 * Build the queue the way a byte-reading caller must: materialise the document
 * for the projection, but keep `usage` lossless so `3` and `3.0` stay distinct.
 * A plain `JSON.parse` result cannot preserve that distinction.
 */
function losslessQueue(text: string): RecordValue {
  const document = parseJsonValue(text);
  if (!(document instanceof JsonObject)) throw new Error('queue must be an object');
  const queue = toPlainJson(document) as RecordValue;
  queue.usage = document.get('usage');
  return queue;
}

function losslessSummary(text: string): StatusSummaryView {
  return summarize(
    { generated_at: '2026-11-09T11:55:00Z' },
    losslessQueue(text),
    {},
    { max_starts_per_hour: 5 },
    [],
    NOW,
  );
}

describe('receipt identity parity', () => {
  test('a boolean version equals 1 like Python', () => {
    expect(reusableCurrent(...retainedReceipt(true))).toBe(true);
    expect(reusableCurrent(...retainedReceipt(1))).toBe(true);
    expect(reusableCurrent(...retainedReceipt(2))).toBe(false);
  });
});

/**
 * A countable retained receipt whose capture is internally consistent. The
 * version is the variable under test (`True == 1` in Python).
 */
function retainedReceipt(version: unknown): [RecordValue, RecordValue] {
  const paths = [{ path: 'src/a.ts', disposition: 'included' }];
  const capture: RecordValue = {
    target: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    paths,
    scope_digest: receiptJsonDigest(paths),
    policy: 'affected-current-additions-v1',
    projection: 'current-affected-files/full-file-addition-projection',
    reviewer: 'coderabbit-review-agent-committed-v1',
    reviewer_version: 'fixture',
  };
  capture.equivalence = currentEquivalence(capture);
  const document: RecordValue = {
    version,
    capture,
    classification: { counted: true, outcome: 'completed' },
    counted: true,
    outcome: 'terminal-clean',
  };
  return [document, capture];
}

/** The oracle's exact `starts_cap`, still lossless from the fixture bytes. */
function losslessStartsCap(name: string): JsonValue {
  const root = parseJsonValue(readFileSync(new URL('summarize.json', A1), 'utf8'));
  if (!(root instanceof JsonObject)) throw new Error('summarize.json root is not an object');
  const cases = root.get('cases');
  if (!Array.isArray(cases)) throw new Error('summarize.json has no cases');
  for (const entry of cases) {
    if (!(entry instanceof JsonObject) || entry.get('name') !== name) continue;
    const expectation = entry.get('expect');
    if (!(expectation instanceof JsonObject)) throw new Error(`${name}: missing expect`);
    const value = expectation.get('value');
    if (!(value instanceof JsonObject)) throw new Error(`${name}: missing value`);
    const cap = value.get('starts_cap');
    if (cap === undefined) throw new Error(`${name}: missing starts_cap`);
    return cap;
  }
  throw new Error(`${name}: case not found`);
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
