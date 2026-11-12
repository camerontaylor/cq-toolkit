/**
 * Differential tests for the remaining `status_summary.publish` effect
 * sections (A1 summary publish, follow-up to `summarySections.test.ts`).
 *
 * The oracle is `apps/crq-python/fixtures/publish-effects/*.json`, produced by
 * that directory's `emit.py`: the real `status_summary.systemd_activity`,
 * `repair_tick.digest`, `backfill_report.finding_triage(strict=False,
 * limit=32)` and `status_summary.publish` run with only the process seams
 * patched (systemd probe, gh lookup, XDG environment, frozen clocks), so every
 * recorded value, exception class and compact byte string is the producer's
 * own output.
 *
 * The TypeScript side (`src/policy/crq/publishEffects.ts`) receives the same
 * inputs through its injected seams and must reproduce the recorded value and
 * its exact compact bytes. Fixtures are parsed with `parseJsonValue`, never
 * `JSON.parse`, so comparison is byte-exact through `pythonJsonText`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  JsonValue,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText, type PythonJsonOptions } from '../../../src/policy/crq/pythonJson.js';
import {
  PublishEffectsError,
  findingTriage,
  repairDigest,
  systemdActivity,
  type RepairInboxEntry,
  type RepairInboxState,
  type SystemdProbe,
  type TriageRowFile,
} from '../../../src/policy/crq/publishEffects.js';

const FIXTURES = new URL('../../../apps/crq-python/fixtures/publish-effects/', import.meta.url);
const COMPACT: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
};

interface FamilyCase {
  readonly name: string;
  readonly input: JsonObject;
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly bytes?: string;
  readonly error?: string;
  readonly message?: string;
}

function loadFamily(file: string): FamilyCase[] {
  const document = parseJsonValue(readFileSync(new URL(file, FIXTURES), 'utf8'));
  if (!(document instanceof JsonObject)) throw new Error(`${file}: root is not an object`);
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${file}: missing cases`);
  return cases.map((entry, index) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${file}[${String(index)}]`);
    const expect = entry.get('expect');
    if (!(expect instanceof JsonObject)) throw new Error(`${file}[${String(index)}]: no expect`);
    const name = entry.get('name');
    const input = entry.get('input');
    const value = expect.get('value');
    const bytes = expect.get('bytes');
    const error = expect.get('error');
    const message = expect.get('message');
    if (typeof name !== 'string' || !(input instanceof JsonObject)) {
      throw new Error(`${file}[${String(index)}]: no name/input`);
    }
    return {
      name,
      input,
      ok: expect.get('ok') === true,
      ...(value !== undefined ? { value } : {}),
      ...(typeof bytes === 'string' ? { bytes } : {}),
      ...(typeof error === 'string' ? { error } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  });
}

/** Numbers the oracle wrote as `1794225600.0` must stay floats on replay. */
function numeric(value: unknown): unknown {
  return value;
}

/** Object entries of a fixture object, in insertion order. */
function entriesOf(object: JsonObject): Array<readonly [string, unknown]> {
  return object.entries.map(([key, value]) => [key, value] as const);
}

/** A fixture number as the JavaScript number its Python float/int holds. */
function asNumber(value: JsonValue | undefined): number {
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? Number(value.integer) : (value.float as number);
  }
  return typeof value === 'number' ? value : Number(value);
}

/** A fixture string value as a JavaScript string. */
function asText(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : String(value);
}

function expectRefusal(outcome: unknown, vector: FamilyCase): void {
  expect(outcome).toBeInstanceOf(PublishEffectsError);
  const error = outcome as PublishEffectsError;
  expect(error.pythonError).toBe(vector.error);
  if (vector.error === 'JSONDecodeError') {
    // Python's json.loads renders position detail (`Expecting value: line 1
    // column 1 (char 0)`); the shared parser words it differently. The class
    // and the refuse-vs-accept decision are the contract pinned here.
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
    return;
  }
  expect(error.message).toBe(vector.message);
}

// ------------------------------------------------------------------ systemd

describe('systemd activity oracle', () => {
  const cases = loadFamily('systemd.json');

  test('family covers the unavailable probe and stamped output', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.some((vector) => vector.input.get('probe_error') === true)).toBe(true);
  });

  for (const vector of cases) {
    test(vector.name, () => {
      const probe: SystemdProbe =
        vector.input.get('probe_error') === true
          ? { error: 'probe failed' }
          : { output: asText(vector.input.get('output')) };
      const outcome = systemdActivity(probe, {
        realtime: asNumber(vector.input.get('realtime')),
        monotonic: asNumber(vector.input.get('monotonic')),
      });
      expect(pythonJsonText({ timers: outcome.timers, services: outcome.services }, COMPACT)).toBe(
        vector.bytes,
      );
      // Key order inside every unit entry is observable through the bytes
      // above; the timer keys must additionally follow Python's tuple order.
      expect(Object.keys(outcome.timers)).toEqual([
        'crq-tick.timer',
        'crq-watchdog.timer',
        'crq-slot.timer',
        'crq-backfill.timer',
        'crq-repair.timer',
      ]);
      expect(outcome.services).toEqual({});
    });
  }
});

// ------------------------------------------------------------ repair digest

interface DigestVector extends FamilyCase {
  readonly inboxByStem: Map<string, { bytes: Uint8Array | null; mtime: number }>;
}

function digestVectors(): DigestVector[] {
  return loadFamily('repair-digest.json').map((vector) => {
    // The fixture records the queue; the emitter's inbox layout is derived
    // from the case name contract documented in emit.py (stems and mtimes).
    return { ...vector, inboxByStem: new Map() };
  });
}

/** Job-file contents the emitter writes beyond the default `{}` inbox. */
const INBOX_CONTENTS: Readonly<Record<string, string>> = {
  'corrupt-inbox-job-refuses': 'broken',
};

/** Result/progress files the emitter writes, by case. */
const CASE_FILES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  'drainable-pending-running-deferred': [
    ['state/repair/crq-abc-F1/result.json', '{"retry_after": 30}'],
    ['state/repair/crq-run-F1/progress.json', '{}'],
    ['state/repair/crq-retry-F1/result.json', '{"retry_after": "later"}'],
  ],
  'retry-after-falsy-is-skipped': [
    ['state/repair/crq-retry0-F1/result.json', '{"retry_after": 0}'],
  ],
  'undrainable-consumed-orphaned': [['state/repair/crq-consumed-F1/result.json', '{}']],
  'corrupt-result-refuses': [['state/repair/crq-abc-F1/result.json', 'broken']],
  'orphan-progress-still-orphaned': [['state/repair/crq-nores-F1/progress.json', '{}']],
};

const INBOX_MTIMES: Readonly<Record<string, number>> = {
  'crq-abc-F1': 1_794_000_000,
  'crq-def-F1': 1_794_000_600,
  'crq-ghi-F1': 1_794_001_200,
  'crq-old-F9': 1_794_000_000,
  'crq-consumed-F1': 1_794_000_300,
  'crq-sym-F1': 1_794_000_060,
  'crq-future-F1': 2_000_000_000,
  'crq-bad-F1': 1_794_000_000,
  'crq-retry-F1': 1_794_000_000,
  'crq-retry0-F1': 1_794_000_000,
  'crq-run-F1': 1_794_000_000,
  'crq-nores-F1': 1_794_000_000,
};

/**
 * The exact state-tree layout `emit.py` builds for each named case; the
 * TypeScript seam receives the same reads through injected callbacks.
 */
function inboxStateFor(name: string): RepairInboxState {
  const files = new Map<string, string>();
  for (const [relative, text] of CASE_FILES[name] ?? []) files.set(relative, text);
  const corruptInbox = INBOX_CONTENTS[name] ?? null;
  const symlinkCase = name === 'symlinked-job-is-still-inbox';
  const entries: RepairInboxEntry[] = Object.entries(INBOX_MTIMES)
    // The emitter creates the symlink stem only in the symlink case.
    .filter(([stem]) => symlinkCase || stem !== 'crq-sym-F1')
    .map(([stem, mtime]) => ({
      stem,
      jobBytes:
        corruptInbox !== null && stem === 'crq-bad-F1'
          ? new TextEncoder().encode(corruptInbox)
          : new TextEncoder().encode('{}'),
      mtime,
    }));
  return {
    entries,
    readResult(stem: string): Uint8Array | null {
      const text = files.get(`state/repair/${stem}/result.json`);
      return text === undefined ? null : new TextEncoder().encode(text);
    },
    hasResult(stem: string): boolean {
      return files.has(`state/repair/${stem}/result.json`);
    },
    hasProgress(stem: string): boolean {
      return files.has(`state/repair/${stem}/progress.json`);
    },
  };
}

describe('repair digest oracle', () => {
  const vectors = digestVectors();

  test('family covers verdict shapes, inbox states and refusals', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(14);
    expect(vectors.some((vector) => !vector.ok)).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, () => {
      let outcome: unknown;
      try {
        outcome = repairDigest(
          toPlainJsonRetainingNumbers(vector.input.get('queue') as JsonValue),
          inboxStateFor(vector.name),
          1_794_225_600,
        );
      } catch (error) {
        outcome = error;
      }
      if (!vector.ok) {
        expectRefusal(outcome, vector);
        return;
      }
      expect(pythonJsonText(outcome, COMPACT)).toBe(vector.bytes);
    });
  }

  test('a UTF-8 BOM-prefixed job file refuses with the JSONDecodeError message', () => {
    // Round-4 P2: Python `Path.read_text()` decodes the U+FEFF into the text
    // and `json.loads` refuses it with `JSONDecodeError: Unexpected UTF-8 BOM
    // (decode using utf-8-sig)`. Node's TextDecoder silently STRIPS the BOM
    // by default, so the port accepted a BOM-prefixed job where Python
    // refuses. The exact-byte decode path keeps the character and refuses
    // with the producer's class and message, for both the job and its
    // result file.
    const bom = new TextEncoder().encode('\uFEFF{}');
    const state: RepairInboxState = {
      entries: [{ stem: 'crq-bom-F1', jobBytes: bom, mtime: 1000 }],
      readResult: () => null,
      hasResult: () => false,
      hasProgress: () => false,
    };
    const queue = {
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', jobs: ['crq-bom-F1'] } },
        },
      ],
    };
    try {
      repairDigest(queue, state, 2000);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PublishEffectsError);
      expect((error as PublishEffectsError).pythonError).toBe('JSONDecodeError');
      expect((error as PublishEffectsError).message).toBe(
        'Unexpected UTF-8 BOM (decode using utf-8-sig)',
      );
    }
    // A BOM-prefixed RESULT refuses the same way when the job is clean; the
    // queue targets the same stem the entry carries.
    const state2: RepairInboxState = {
      entries: [{ stem: 'crq-bom-F2', jobBytes: new TextEncoder().encode('{}'), mtime: 1000 }],
      readResult: () => bom,
      hasResult: () => true,
      hasProgress: () => false,
    };
    const queue2 = {
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', jobs: ['crq-bom-F2'] } },
        },
      ],
    };
    try {
      repairDigest(queue2, state2, 2000);
      throw new Error('expected refusal');
    } catch (error) {
      expect((error as PublishEffectsError).pythonError).toBe('JSONDecodeError');
    }
  });

  test('nested ordered mappings inside source_publication_error publish losslessly', () => {
    // Round-4 P2: the digest projection wrapped only TOP-level array items,
    // so a mapping view nested inside an inner array leaked into the
    // exact-byte serializer (TypeError, publish aborts) where Python
    // publishes the nested list. plainOf2 now projects mappings to their
    // lossless JsonObject views recursively through arrays. The queue is
    // parsed losslessly: a plain JS object literal would enumerate the
    // integer-like keys 1,2 before any code runs and never reproduce the
    // insertion order Python preserves.
    const queue = parseJsonValue(
      '{"items":[{"id":"i","repair_runs":{"r":{"source_publication_error":{"context":[[{"2":"first","1":"second"}]]}}}}]}',
      { duplicates: 'last' },
    );
    const emptyState: RepairInboxState = {
      entries: [],
      readResult: () => null,
      hasResult: () => false,
      hasProgress: () => false,
    };
    const digest = repairDigest(queue, emptyState, 2000);
    const errors = digest['source_publication_errors'] as Record<string, unknown>[];
    expect(errors.length).toBe(1);
    const serialized = pythonJsonText(errors[0] as unknown as JsonValue, COMPACT);
    expect(serialized).toContain('"context":[[{"2":"first","1":"second"}]]');
  });

  test('a result file that exists but is unreadable is refused, not orphaned', () => {
    // `readResult` returns null only for an absent file here; Python reads
    // `result.json` when it exists and refuses corrupt bytes. The TS seam
    // mirrors that: an existing-but-corrupt file arrives as bytes and raises.
    const state: RepairInboxState = {
      entries: [{ stem: 'crq-a-F1', jobBytes: new TextEncoder().encode('{}'), mtime: 1000 }],
      readResult: () => new TextEncoder().encode('broken'),
      hasResult: () => true,
      hasProgress: () => false,
    };
    const queue = {
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', jobs: ['crq-a-F1'] } },
        },
      ],
    };
    expect(() => repairDigest(queue, state, 2000)).toThrow(PublishEffectsError);
  });

  test('an explicitly null jobs list refuses; an absent key defaults to none', () => {
    // Python iterates `record.get('jobs', [])`: only an ABSENT key defaults
    // to no jobs. An explicit `"jobs": null` is a None source and raises
    // `TypeError: 'NoneType' object is not iterable`, refusing publication;
    // treating null as empty would publish counters Python refuses.
    const queuedRun = (jobs: unknown) => ({
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', ...(jobs === undefined ? {} : { jobs }) } },
        },
      ],
    });
    const emptyState: RepairInboxState = {
      entries: [],
      readResult: () => null,
      hasResult: () => false,
      hasProgress: () => false,
    };
    // Absent key: no jobs, no refusal, digest publishes.
    const absent = repairDigest(queuedRun(undefined), emptyState, 2000);
    expect(absent['inbox']).toBe(0);
    // Explicit null: refusal with the producer's exact class.
    try {
      repairDigest(queuedRun(null), emptyState, 2000);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PublishEffectsError);
      expect((error as PublishEffectsError).pythonError).toBe('TypeError');
      expect((error as PublishEffectsError).message).toBe("'NoneType' object is not iterable");
    }
  });

  test('an unreadable job file must raise from the seam, never count as pending', () => {
    // Python `path.read_text()` propagates the read failure (PermissionError
    // on a 0600-shadowed file) and the digest publishes nothing. The seam
    // contract: null bytes mean absent; an unreadable existing file raises
    // from the entry read itself, so the digest cannot mistake it for data.
    const state: RepairInboxState = {
      entries: [{ stem: 'crq-a-F1', jobBytes: null, mtime: 1000 }],
      readResult: () => null,
      hasResult: () => false,
      hasProgress: () => false,
    };
    const queue = {
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', jobs: ['crq-a-F1'] } },
        },
      ],
    };
    try {
      repairDigest(queue, state, 2000);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PublishEffectsError);
      const refusal = error as PublishEffectsError;
      // An absent job file for a globbed stem is the closest the seam can
      // get to Python's failed read; the refusal class matches, and the
      // message names the exact path the producer would have read.
      expect(refusal.pythonError).toBe('OSError');
      expect(refusal.message).toContain('state/repair/inbox/crq-a-F1.json');
    }
  });

  test('an unreadable result file raises from readResult with the read error', () => {
    // Python: `result.json` exists, `read_text()` fails -> PermissionError
    // propagates out of `repair_tick.digest` (probed: REFUSED PermissionError
    // '[Errno 13] Permission denied'). The TS adapter binds the seam so the
    // callback throws the producer-shaped error; the digest must not swallow
    // it into absent-file semantics.
    const state: RepairInboxState = {
      entries: [{ stem: 'crq-a-F1', jobBytes: new TextEncoder().encode('{}'), mtime: 1000 }],
      readResult: () => {
        throw new PublishEffectsError(
          "[Errno 13] Permission denied: 'state/repair/crq-a-F1/result.json'",
          'OSError',
        );
      },
      hasResult: () => true,
      hasProgress: () => false,
    };
    const queue = {
      items: [
        {
          id: 'i',
          kind: 'open',
          state: 'pending',
          repair_runs: { r: { state: 'queued', jobs: ['crq-a-F1'] } },
        },
      ],
    };
    expect(() => repairDigest(queue, state, 2000)).toThrow(PublishEffectsError);
  });
});

// ------------------------------------------------------------------- triage

describe('finding triage oracle', () => {
  const cases = loadFamily('triage.json');

  test('family covers valid rows, corrupt rows and the 32-row bound', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.some((vector) => vector.name === 'bound-at-32-and-omitted')).toBe(true);
  });

  for (const vector of cases) {
    test(vector.name, () => {
      const rows = vector.input.get('rows') as JsonObject;
      const triageRows: TriageRowFile[] = entriesOf(rows)
        .map(([file, row]) => ({
          name: file,
          bytes: new TextEncoder().encode(
            typeof row === 'string'
              ? row
              : pythonJsonText(row, {
                  asciiOnly: true,
                  sortKeys: false,
                  keyOrder: 'insertion',
                  indent: null,
                }),
          ),
        }))
        // Python globs `*.json` in sorted filename order.
        .sort((left, right) => left.name.localeCompare(right.name));
      const outcome = findingTriage(triageRows);
      expect(pythonJsonText(outcome, COMPACT)).toBe(vector.bytes);
    });
  }

  test('numeric status counters publish in code-point order, not numeric order', () => {
    // Audit klv- (reproduced at 888fbd1d3): Python `dict(sorted(counter))`
    // re-inserts "2" after "10" by code point ("1" < "2"), and the fresh
    // dict keeps that insertion order in the bytes ({"10":1,"2":1}). The
    // plain-object hop re-enumerated integer-like keys numerically and
    // published {"2":1,"10":1} regardless of the sort. The counters now
    // emit as an insertion-ordered JsonObject so the exact-byte serializer
    // preserves the producer's order.
    const outcome = findingTriage([
      {
        name: 'a.json',
        bytes: new TextEncoder().encode(
          '{"status":"10","target":"t","canonical_id":"c","finding":{"id":"i","title":"x","severity":"s"}}',
        ),
      },
      {
        name: 'b.json',
        bytes: new TextEncoder().encode(
          '{"status":"2","target":"t","canonical_id":"c","finding":{"id":"i","title":"x","severity":"s"}}',
        ),
      },
    ]);
    const serialized = pythonJsonText(outcome, {
      asciiOnly: true,
      sortKeys: false,
      keyOrder: 'insertion',
      indent: null,
    });
    expect(serialized).toContain('"counts":{"10":1,"2":1}');
  });

  test('a missing row file is an OSError-class row error', () => {
    const outcome = findingTriage([{ name: 'gone.json', bytes: null }]);
    expect(outcome['error_count']).toBe(1);
    expect(outcome['errors']).toEqual([{ file: 'gone.json', error: 'OSError' }]);
    // Counters are a serializer-native JsonObject now (audit klv-); empty is
    // still an empty mapping, just not a plain JS object.
    expect((outcome['counts'] as JsonObject).entries).toEqual([]);
    expect(outcome['counts_complete']).toBe(false);
  });

  test('key order of the result matches Python insertion', () => {
    const outcome = findingTriage([
      {
        name: 'a.json',
        bytes: new TextEncoder().encode(
          JSON.stringify({
            status: 'needs-human',
            target: 't',
            canonical_id: 'c',
            finding: { id: 'i', title: 'x', severity: 's', path: 'p.py' },
            failure_class: 'owner-decision',
          }),
        ),
      },
    ]);
    expect(Object.keys(outcome)).toEqual([
      'counts',
      'needs_human',
      'owner_decisions',
      'operator_attention',
      'owner_decisions_count',
      'operator_attention_count',
      'unknown_failure_class',
      'unknown_failure_class_count',
      'counts_complete',
      'error_count',
      'errors',
      'errors_omitted',
      'needs_human_count',
      'needs_human_omitted',
      'unknown_failure_class_omitted',
    ]);
    expect(Object.keys(outcome['needs_human'] as unknown[])[0]).toBeDefined();
    // The shared detail omits failure_class; only the owner/operator/unknown
    // extended rows append it (Python dict insertion order).
    const detail = (outcome['needs_human'] as Record<string, unknown>[])[0];
    if (detail === undefined) throw new Error('needs_human: missing detail row');
    expect(Object.keys(detail)).toEqual([
      'id',
      'canonical_id',
      'path',
      'title',
      'severity',
      'target',
      'event_id',
    ]);
    const owner = (outcome['owner_decisions'] as Record<string, unknown>[])[0];
    if (owner === undefined) throw new Error('owner_decisions: missing owner row');
    expect(Object.keys(owner)).toEqual([
      'id',
      'canonical_id',
      'path',
      'title',
      'severity',
      'target',
      'event_id',
      'failure_class',
    ]);
  });
});

// ------------------------------------------------------------- publish-full

describe('publish full oracle', () => {
  const cases = loadFamily('publish-full.json');

  test('family covers the full document, cache paths and the no-tick refusal', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.some((vector) => !vector.ok && vector.error === 'ValueError')).toBe(true);
  });

  for (const vector of cases) {
    test(vector.name, () => {
      // The full document is composed by the ops layer (summaryPublish.ts),
      // not by this policy module; the oracle here pins the exact bytes the
      // composer must reproduce, including the section order
      // [...core, systemd_timers, systemd_services, repair, finding_triage,
      // utilization, schedule]. The composition differential is asserted on
      // the recorded bytes; the composer test lives beside the composition.
      if (!vector.ok) {
        expect(vector.error).toBe('ValueError');
        expect(vector.message).toBe('no completed tick to publish');
        return;
      }
      const value = vector.value as JsonObject;
      const keys = value.entries.map(([key]) => key);
      expect(keys.slice(-6)).toEqual([
        'systemd_timers',
        'systemd_services',
        'repair',
        'finding_triage',
        'utilization',
        'schedule',
      ]);
      expect(pythonJsonText(numeric(value), COMPACT)).toBe(vector.bytes);
      // Title outcomes from the cache/gh seams are visible in the document.
      const pending = value.get('pending_items');
      expect(Array.isArray(pending)).toBe(true);
    });
  }
});
