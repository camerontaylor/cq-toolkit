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
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { receiptJsonBytes } from '../../../src/policy/crq/pythonJson.js';
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
import { parseUtc } from '../../../src/policy/crq/utc.js';
import {
  UsageSlotsError,
  nextSlot,
  parseUsage,
  type VendorUsage,
} from '../../../src/policy/crq/usageSlots.js';

const GROUP_P = new URL('../../../apps/crq-python/fixtures/group-p/', import.meta.url);
const A1 = new URL('../../../apps/crq-python/fixtures/a1-status/', import.meta.url);

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

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly pythonError: string; readonly message: string };

function loadFamily(directory: URL, name: string): VectorCase[] {
  const document = JSON.parse(readFileSync(new URL(`${name}.json`, directory), 'utf8')) as unknown;
  const root = recordOf(document, name);
  const cases = root.cases;
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  return cases.map((entry) => {
    const row = recordOf(entry, name);
    const expectation = recordOf(row.expect, `${name}/${String(row.name)}`);
    return {
      family: name,
      name: stringOf(row.name, 'name'),
      source: stringOf(row.source, 'source'),
      input: recordOf(row.input, `${name} input`),
      expect: {
        ok: expectation.ok === true,
        value: expectation.value,
        ...(typeof expectation.error === 'string' ? { error: expectation.error } : {}),
        ...(typeof expectation.message === 'string' ? { message: expectation.message } : {}),
      },
    };
  });
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
  return JSON.parse(JSON.stringify(value)) as unknown;
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
});

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
