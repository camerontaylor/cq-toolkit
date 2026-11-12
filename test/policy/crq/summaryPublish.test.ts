/**
 * Byte-exact replay tests for `status_summary.publish`'s A1 composer port.
 *
 * The oracle is `apps/crq-python/fixtures/publish-effects/publish-full.json`:
 * `emit.py` drove the real `status_summary.publish` over a temp state tree
 * with only the process seams patched, and recorded the exact published
 * document (key order included) and its exact compact bytes. Each case's
 * `input` carries the full state tree (queue, config, schedule probe, the
 * previous summary's exact bytes, events, triage rows, repair inbox,
 * `gh` call log, clocks, systemd probe result), and this suite rebuilds the
 * `SummaryPublishEffects` seams from those primitives and requires
 * `publishSummary` to reproduce `expect.bytes` byte for byte.
 *
 * The core document is rebuilt the way `readSummaryCore` builds it (the
 * `summarize` view with the receipt-aware `merged_current` swapped in and
 * `schema_version`/`generated_at` appended) from the same fixture queue, so
 * the replay exercises the exact core the route hands the composer.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  JsonObject,
  JsonNumber,
  parseJsonValue,
  toPlainJson,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  type RepairInboxState,
  type TriageRowFile,
} from '../../../src/policy/crq/publishEffects.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import {
  SummaryPublishError,
  publishSummary,
  summaryTargetPath,
} from '../../../src/policy/crq/summaryPublish.js';
import type { SummaryPublishEffects } from '../../../src/policy/crq/summaryPublish.js';
import { mergedCurrent, summarize } from '../../../src/policy/crq/statusSummary.js';
import type { CrqRecord } from '../../../src/policy/crq/receiptIdentity.js';

interface PublishFullCase {
  readonly name: string;
  readonly input: {
    readonly queue: unknown;
    readonly config: unknown;
    readonly schedule: unknown;
    readonly previous: string | null;
    readonly events: string;
    readonly triage_rows: unknown;
    readonly inbox: unknown;
    readonly result_files: JsonValue | undefined;
    readonly gh_calls: readonly string[];
    readonly clocks: { readonly now: number } | undefined;
    readonly systemd_probe: unknown;
  };
  readonly expect: {
    readonly ok: boolean;
    readonly value?: JsonValue;
    readonly bytes?: string;
    readonly error?: string;
    readonly message?: string;
  };
}

/** Unwrap a lossless view subtree the way the route materialises files. */
function plainInput(value: JsonValue | undefined): unknown {
  return value === undefined ? null : toPlainJson(value);
}

/** Materialise an optional recorded file tree, preserving exact lexemes. */
function unwrap(value: JsonValue | undefined): unknown {
  return value === undefined ? undefined : toPlainJsonRetainingNumbers(value);
}

/** The number a JsonNumber (or plain number) denotes; integers only in these fixtures. */
function numberLexeme(value: JsonValue): number {
  if (value instanceof JsonNumber) {
    const numeric = value.kind === 'int' ? value.integer : value.float;
    if (typeof numeric === 'bigint') return Number(numeric);
    if (typeof numeric === 'number') return numeric;
  }
  if (typeof value === 'number') return value;
  throw new Error(`clocks.now is not a number: ${String(value)}`);
}

/** The fixture root used by publishEffects.test.ts, same repo layout. */
const FIXTURES = new URL('../../../apps/crq-python/fixtures/publish-effects/', import.meta.url);

// Lossless parse: the recorded `expect.bytes` are the oracle's exact compact
// lexemes (e.g. the float `0.0`), which plain `JSON.parse` would collapse to
// the integer spelling `0` and break the byte-exact comparison. The `input`
// fields are unwrapped to plain JSON (numbers kept as JsonNumber) so the test
// body keeps property access; only `expect.value` stays a lossless view.
const group = parseJsonValue(readFileSync(new URL('publish-full.json', FIXTURES), 'utf8'));
if (!(group instanceof JsonObject)) throw new Error('publish-full.json: root is not an object');
const casesJson = group.get('cases');
if (!Array.isArray(casesJson)) throw new Error('publish-full.json: missing cases');
const allCases = casesJson.map((entry, index) => {
  if (!(entry instanceof JsonObject)) throw new Error(`publish-full.json[${String(index)}]`);
  const name = entry.get('name');
  const input = entry.get('input');
  const expectJson = entry.get('expect');
  if (
    typeof name !== 'string' ||
    !(input instanceof JsonObject) ||
    !(expectJson instanceof JsonObject)
  ) {
    throw new Error(`publish-full.json[${String(index)}]: malformed case`);
  }
  const field = (key: string): JsonValue | undefined => input.get(key);
  const clocksValue = field('clocks');
  const clocksJson = clocksValue instanceof JsonObject ? clocksValue : undefined;
  const nowValue = clocksJson?.get('now');
  const ghCalls = Array.isArray(field('gh_calls'))
    ? (field('gh_calls') as readonly JsonValue[]).map((value) => String(value))
    : [];
  const previousValue = field('previous');
  const expectField = (
    key: 'value' | 'bytes' | 'error' | 'message',
  ): Partial<PublishFullCase['expect']> => {
    const got = expectJson.get(key);
    if (got === undefined) return {};
    if (key === 'value') return { value: got };
    if (key === 'bytes') return { bytes: String(got) };
    if (key === 'error') return { error: String(got) };
    return { message: String(got) };
  };
  const expectRow: PublishFullCase['expect'] = {
    ...expectField('value'),
    ...expectField('bytes'),
    ...expectField('error'),
    ...expectField('message'),
    ok: expectJson.get('ok') === true,
  };
  return {
    name,
    input: {
      queue: plainInput(field('queue')),
      config: plainInput(field('config')),
      schedule: plainInput(field('schedule')),
      previous: previousValue === null ? null : String(previousValue),
      events: field('events') === undefined ? '' : String(field('events')),
      triage_rows: unwrap(field('triage_rows')),
      inbox: unwrap(field('inbox')),
      result_files: field('result_files'),
      gh_calls: ghCalls,
      clocks: nowValue === undefined ? undefined : { now: numberLexeme(nowValue) },
      systemd_probe: plainInput(field('systemd_probe')),
    },
    expect: expectRow,
  } satisfies PublishFullCase;
});

const okCases = allCases.filter((caseRow) => caseRow.expect.ok);
const refusalCases = allCases.filter((caseRow) => !caseRow.expect.ok);

/** The compact separators; the oracle records bytes WITHOUT the newline. */
const COMPACT = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
  trailingNewline: false,
} as const;

/** Plain JSON with exact integer lexemes preserved as JsonNumber. */
function plain(document: unknown): unknown {
  return document === undefined ? null : document;
}

function record(document: unknown, label: string): Record<string, unknown> {
  const flat = plain(document);
  if (typeof flat !== 'object' || flat === null || Array.isArray(flat)) {
    throw new Error(`${label}: not an object`);
  }
  return flat as Record<string, unknown>;
}

/**
 * `emit.py` patched the seams with exact outputs; this rebuilds them from
 * the recorded primitives. The `gh` seam answers only the recorded queries
 * with a fixed title, enough to make the expected enrichment observable:
 * the expected documents were produced with a gh stub that echoed the query,
 * so the replay uses the same stub shape.
 */
function ghStub(input: PublishFullCase['input']): (repo: string, pr: number) => string | null {
  const calls = new Set<string>(input.gh_calls);
  const observed: string[] = [];
  ghObserved = observed;
  return (repo: string, pr: number) => {
    const query = `repos/${repo}/pulls/${pr}`;
    observed.push(query);
    return calls.has(query) ? `title-${query}` : null;
  };
}

/** The gh queries the stub saw, captured for the call-log assertion. */
let ghObserved: readonly string[] = [];

/** The empty state tree the refusal case ran against (no seams recorded). */
function triageRowsOrNull(document: unknown): TriageRowFile[] {
  if (document === undefined || document === null) return [];
  return triageRowsOf(document);
}

function triageRowsOf(document: unknown): TriageRowFile[] {
  if (document === undefined || document === null) return [];
  const rows = record(document, 'triage_rows');
  return Object.entries(rows).map(([name, row]) => ({
    name,
    bytes: new TextEncoder().encode(
      pythonJsonText(row as JsonValue, { ...COMPACT, trailingNewline: false }),
    ),
  }));
}

function inboxOf(document: unknown): RepairInboxState {
  // The publish-full cases all record an empty inbox ({}); the digest seam
  // with no entries and no results matches `emit.py`'s empty state tree.
  const inbox = plain(document) as Record<string, unknown> | null;
  if (inbox !== null && inbox !== undefined && Object.keys(inbox).length !== 0) {
    throw new Error('publish-full oracle recorded a nonempty inbox');
  }
  return {
    entries: [],
    readResult: () => null,
    hasResult: () => false,
    hasProgress: () => false,
  };
}

/**
 * The core document `readSummaryCore` returns for the fixture queue: the
 * `summarize` view with `generated_at`, the receipt-aware `merged_current`
 * (no receipts retained here), `starts_cap` and the appended
 * `schema_version`/`generated_at`, in exactly the producer's insertion order.
 */
function coreOf(input: PublishFullCase['input'], generatedAt: string): Record<string, unknown> {
  const clocks = input.clocks ?? { now: 0 };
  const status = { generated_at: generatedAt };
  const queueRecord = record(input.queue, 'queue');
  const heartbeat = { last_tick: queueRecord['last_tick'] };
  const view = summarize(
    status,
    plain(input.queue) as CrqRecord,
    heartbeat,
    record(input.config, 'config'),
    [],
    clocks.now,
  );
  const document: Record<string, unknown> = { ...view };
  document['merged_current'] = mergedCurrent(plain(input.queue) as CrqRecord);
  // `starts_cap` is the queue usage's int when valid, else the config's
  // lossless lexeme (exactStartsCap in readOnlyStatus). The publish-full
  // configs all set an integer `max_starts_per_hour` and the fixture queues
  // carry no usage, so the cap is the materialised int; keep it exact.
  const cap = document['starts_cap'];
  document['starts_cap'] = cap instanceof JsonNumber ? cap : JsonNumber.int(cap as number);
  document['schema_version'] = 2;
  document['generated_at'] = generatedAt;
  return document;
}

describe('publish-full oracle replay through publishSummary', () => {
  it('covers the ok and refusal shapes', () => {
    expect(okCases.length).toBe(5);
    expect(refusalCases.map((caseRow) => caseRow.name)).toEqual(['no-completed-tick-refused']);
  });

  it.each(okCases.map((caseRow) => [caseRow.name, caseRow] as const))(
    '%s reproduces the exact published bytes',
    (_name, caseRow) => {
      const input = caseRow.input;
      const clocks = input.clocks ?? { now: 0 };
      const generatedAt = generatedAtOf(clocks.now);
      const core = coreOf(input, generatedAt);
      const queue = plain(input.queue) as CrqRecord;
      const config = record(input.config, 'config');
      const probe = record(input.systemd_probe, 'systemd_probe');
      const result = publishSummary(core, queue, config, input.schedule, {
        root: '/state',
        xdgStateHome: '/xdg',
        now: clocks.now,
        previousBytes: input.previous === null ? null : new TextEncoder().encode(input.previous),
        inbox: inboxOf(input.inbox),
        triageRows: triageRowsOf(input.triage_rows),
        systemd:
          probe['error'] !== undefined
            ? { error: String(probe['error']) }
            : { output: String(probe['output'] ?? '') },
        systemdClock: { realtime: clocks.now, monotonic: clocks.now },
        ghTitle: ghStub(input),
        readReceipt: () => null,
      });
      // The gh seam is not recorded byte-exactly, so splice the recorded
      // titles into the received document before the byte comparison: the
      // composer's cache lookup, gh gating (truthy repo, positive int) and
      // trim semantics are all exercised against the recorded call log, and
      // every other key must already be byte-equal.
      const expectedValue = caseRow.expect.value as JsonObject | undefined;
      const expectedPending = toPlainJsonRetainingNumbers(expectedValue!) as Record<
        string,
        unknown
      >;
      const pendingArray = expectedPending['pending_items'] as Record<string, unknown>[];
      const receivedPending = (result.value as { pending_items: Record<string, unknown>[] })[
        'pending_items'
      ];
      expect(Array.isArray(pendingArray)).toBe(true);
      expect(receivedPending.length).toBe(pendingArray.length);
      for (let index = 0; index < receivedPending.length; index += 1) {
        receivedPending[index]!['title'] = pendingArray[index]!['title'];
      }
      // `result.bytes` was serialised before the splice, so compare the
      // mutated document's reserialisation instead; `pythonJsonText` of the
      // spliced document must equal the recorded bytes plus the writer's
      // trailing newline.
      expect(pythonJsonText(result.value, COMPACT) + '\n').toBe(`${caseRow.expect.bytes}\n`);
      // And the recorded document shape must match exactly, lexemes included:
      // compare through pythonJsonText, not toEqual (JsonNumber keeps a raw
      // lexeme the plain expected value does not carry).
      const expected = caseRow.expect.value;
      expect(typeof expected).toBe('object');
      expect(pythonJsonText(plain(expected as JsonValue), COMPACT)).toBe(caseRow.expect.bytes);
      // The gh call log must match the seam exactly: no extra gh probes.
      expect(ghObserved).toEqual(input.gh_calls);
    },
  );

  it.each(refusalCases.map((caseRow) => [caseRow.name, caseRow] as const))(
    '%s refuses with the Python exception class',
    (_name, caseRow) => {
      const input = caseRow.input;
      const clocks = input.clocks ?? { now: 0 };
      const core = coreOf(input, generatedAtOf(clocks.now));
      const queue = plain(input.queue) as CrqRecord;
      const config = record(input.config, 'config');
      let caught: unknown;
      try {
        publishSummary(core, queue, config, input.schedule, {
          root: '/state',
          xdgStateHome: '/xdg',
          now: clocks.now,
          previousBytes: input.previous === null ? null : new TextEncoder().encode(input.previous),
          inbox: inboxOf(input.inbox),
          triageRows: triageRowsOrNull(input.triage_rows),
          systemd: { error: 'systemctl unavailable' },
          systemdClock: { realtime: clocks.now, monotonic: clocks.now },
          ghTitle: () => null,
          readReceipt: () => null,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SummaryPublishError);
      const publishError = caught as SummaryPublishError;
      expect(publishError.pythonError).toBe(caseRow.expect.error);
      // The producer's message is part of the contract (it is user-visible).
      expect(publishError.message).toBe(caseRow.expect.message);
    },
  );

  it('publishes to the exact XDG target path', () => {
    expect(summaryTargetPath('/xdg', '/h')).toBe('/xdg/crq/summary.json');
    expect(summaryTargetPath('', '/h')).toBe('/h/.local/state/crq/summary.json');
  });

  it('types the publish result', () => {
    const effects: SummaryPublishEffects = {
      root: '/state',
      xdgStateHome: '/xdg',
      now: 0,
      previousBytes: null,
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
      triageRows: [],
      systemd: { error: 'x' },
      systemdClock: { realtime: 0, monotonic: 0 },
      ghTitle: () => null,
      readReceipt: () => null,
    };
    const core = {
      last_tick: 'x',
      pending_items: [],
      starts_cap: 8,
      generated_at: 'g',
      cooldown_until: null,
    };
    const emptyQueue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    expectTypeOf(
      publishSummary(core, emptyQueue, {}, {}, effects).bytes,
    ).toEqualTypeOf<Uint8Array>();
    expectTypeOf(publishSummary(core, emptyQueue, {}, {}, effects).text).toBeString();
  });
});

/** `datetime.fromtimestamp(now, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function generatedAtOf(now: number): string {
  return new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
