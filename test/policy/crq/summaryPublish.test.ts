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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';

const summaryDirs: string[] = [];

async function tempRoot(): Promise<{ root: string; state: string; xdg: string }> {
  const root = await mkdtemp(join(tmpdir(), 'crq-summary-publish-'));
  summaryDirs.push(root);
  const state = join(root, 'state');
  const xdg = join(root, 'xdg');
  return { root, state, xdg };
}

afterAll(async () => {
  for (const dir of summaryDirs) await rm(dir, { recursive: true, force: true });
});

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
import { summaryStateEffects } from '../../../src/adapters/crq/summarySource.js';
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

  it('enriches a lossless JsonNumber pr: cache hit skips gh, cache miss fires gh', () => {
    // P2-12: the title cache previously keyed by JS typeof, so a JsonNumber
    // pr never matched a cached plain-int entry (forced gh on every item)
    // and was refused gh on a miss. The producer's gate is Python's
    // `type(pr) is int`, which a lossless int lexeme still satisfies.
    // A previous summary seeds the cache the way the real route does.
    const COMPACT_NO_NL = { ...COMPACT, trailingNewline: false };
    const previous = `${pythonJsonText(
      parseJsonValue(
        '{"last_tick":"x","pending_items":[{"repo":"owner/repo","pr":7,"title":"Cached seven"}]}',
      ) as JsonValue,
      COMPACT_NO_NL,
    )}\n`;
    const items = [
      { repo: 'owner/repo', pr: JsonNumber.int(7), title: null },
      { repo: 'owner/repo', pr: 7, title: null },
      { repo: 'owner/repo', pr: JsonNumber.int(9), title: null },
      { repo: 'owner/repo', pr: JsonNumber.float(7, '7.0'), title: null },
    ];
    const core = {
      last_tick: 'x',
      pending_items: items,
      starts_cap: 8,
      generated_at: 'g',
    };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const calls: string[] = [];
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
        root: '/state',
        xdgStateHome: '/xdg',
        now: 0,
        previousBytes: new TextEncoder().encode(previous),
        inbox: {
          entries: [],
          readResult: () => null,
          hasResult: () => false,
          hasProgress: () => false,
        },
        triageRows: [],
        systemd: { error: 'x' },
        systemdClock: { realtime: 0, monotonic: 0 },
        ghTitle: (repo, pr) => {
          calls.push(`repos/${repo}/pulls/${pr}`);
          return `Fresh ${pr}`;
        },
        readReceipt: () => null,
      },
    );
    // JsonNumber 7 hits the cached plain-int 7 (value-equal tuple keys);
    // plain 7 hits too; 9 misses and fires; the float-lexeme 7.0 is
    // value-equal to 7 in Python (1 == 1.0 hashing) so it hits the cached
    // title, but never reaches gh because the gate is `type(pr) is int`.
    expect(calls).toEqual(['repos/owner/repo/pulls/9']);
    const pending = result.value['pending_items'] as { title: unknown }[];
    expect(pending.map((item) => item.title)).toEqual([
      'Cached seven',
      'Cached seven',
      'Fresh 9',
      'Cached seven',
    ]);
    // The published bytes keep the lossless route's exact lexemes: the
    // float-lexeme pr serialises as `7.0`, not `7`.
    expect(result.text).toContain('"pr":7.0');
  });

  it('the adapter preloads gh for a lossless JsonNumber pr (gYDE normalization)', async () => {
    // Audit 6 (gYDE reopened at c00f2109): the adapter gated its gh preload
    // on typeof pr === 'number', so a lossless JsonNumber.int(9) row was
    // never preloaded and publishSummary threw 'gh result not preloaded'
    // where Python's `type(pr) is int` calls gh. The adapter now applies the
    // composer's exported gate, so both boundaries normalize identically.
    const root = await tempRoot();
    const calls: string[] = [];
    const effects = await summaryStateEffects(
      { stateRoot: root.state, xdgStateHome: root.xdg, home: root.root },
      async (argv) => {
        // systemctl is probed unconditionally at assembly; only gh rows are
        // recorded here.
        if (argv[0] === 'gh') calls.push(argv.join(' '));
        return argv[0] === 'gh' ? 'Lossless title' : null;
      },
      [{ repo: 'r', pr: JsonNumber.int(9) }],
      () => 1_700_000,
    );
    expect(calls).toEqual(['gh api repos/r/pulls/9 --jq .title']);
    expect(effects.ghTitle('r', 9)).toBe('Lossless title');
    // And the composer consumes it: the lossless row enriches like Python.
    const core = {
      last_tick: 'x',
      pending_items: [{ repo: 'r', pr: JsonNumber.int(9), title: null }],
      starts_cap: 8,
      generated_at: 'g',
    };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(core, queue, {}, {}, effects);
    expect(result.text).toContain('"title":"Lossless title"');
  });

  it('a falsy title with no cache hit publishes null, not the falsy original', () => {
    // Audit igxo (reproduced at c00f2109): Python's unconditional
    // `item["title"] = item["title"] or titles.get((repo, pr))` overwrites a
    // falsy title with the cache miss (None) even with no previous summary,
    // so the published bytes carry null. The port only assigned on a hit,
    // leaking the empty string into the bytes.
    const core = {
      last_tick: 'x',
      pending_items: [{ repo: 'r', pr: null, title: '' }],
      starts_cap: 8,
      generated_at: 'g',
    };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
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
        ghTitle: () => {
          throw new Error('gh must not fire for a null pr');
        },
        readReceipt: () => null,
      },
    );
    expect(result.text).toContain('"title":null');
    expect(result.text).not.toContain('"title":""');
  });

  it('preserves integer-like context_error key order byte-exactly', () => {
    // Audit igxr (reproduced at c00f2109): Python dicts keep insertion order
    // for integer-like string keys (json.loads preserves the raw lexeme
    // order), but a plain JS object re-enumerates them numerically, so the
    // old toPlain hop reordered {"2","1"} into {"1","2"}. The row must keep
    // its lossless JsonObject view through the exact-byte serializer.
    const row = new TextEncoder().encode(
      '{"status":"delivered","canonical_id":"c","target":"tip","finding":{"id":"i","title":"T","severity":"minor"},"context_error":{"2":"first","1":"second"}}',
    );
    const core = { last_tick: 'x', pending_items: [], starts_cap: 8, generated_at: 'g' };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
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
        triageRows: [{ name: 'a.json', bytes: row }],
        systemd: { error: 'x' },
        systemdClock: { realtime: 0, monotonic: 0 },
        ghTitle: () => null,
        readReceipt: () => null,
      },
    );
    expect(result.text).toContain('"context_error":{"2":"first","1":"second"}');
  });

  it('an empty cached title ({}) is falsy: the gh lookup still fires', () => {
    // r5 residual (reproduced at af5a1b13): the lossless cache stores the
    // previous's non-string titles as JsonObject views, and pyTruthy probed
    // them with Object.keys, which cannot see JsonObject entries: an empty
    // cached dict reported truthy, the gh gate stayed closed and the bytes
    // published "title":{} where Python's `or` treats {} as falsy and calls
    // gh (publishes the fetched title).
    const previous = '{"last_tick":"x","pending_items":[{"repo":"r","pr":5,"title":{}}]}';
    const calls: string[] = [];
    const core = {
      last_tick: 'x',
      pending_items: [{ repo: 'r', pr: 5, title: null }],
      starts_cap: 8,
      generated_at: 'g',
    };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
        root: '/state',
        xdgStateHome: '/xdg',
        now: 0,
        previousBytes: new TextEncoder().encode(previous),
        inbox: {
          entries: [],
          readResult: () => null,
          hasResult: () => false,
          hasProgress: () => false,
        },
        triageRows: [],
        systemd: { error: 'x' },
        systemdClock: { realtime: 0, monotonic: 0 },
        ghTitle: (repo, pr) => {
          calls.push(`repos/${repo}/pulls/${pr}`);
          return 'Fresh 5';
        },
        readReceipt: () => null,
      },
    );
    expect(calls).toEqual(['repos/r/pulls/5']);
    expect(result.text).toContain('"title":"Fresh 5"');
    expect(result.text).not.toContain('"title":{}');
  });

  it('preserves ordered mappings nested inside failure_class arrays byte-exactly', () => {
    // r5 residual (reproduced at af5a1b13): the igxr fix view-wrapped only
    // the TOP-level array items of a row field; failure_class values are
    // lists of lists of dicts, and the inner arrays still projected their
    // dict items through the plain-object hop, reordering {"2","1"} into
    // {"1","2"}. Array elements keep nested mappings as views at any depth.
    const row = new TextEncoder().encode(
      '{"status":"needs-human","canonical_id":"c","target":"tip","finding":{"id":"i","title":"T","severity":"minor"},"failure_class":[[{"2":"first","1":"second"}]]}',
    );
    const core = { last_tick: 'x', pending_items: [], starts_cap: 8, generated_at: 'g' };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
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
        triageRows: [{ name: 'a.json', bytes: row }],
        systemd: { error: 'x' },
        systemdClock: { realtime: 0, monotonic: 0 },
        ghTitle: () => null,
        readReceipt: () => null,
      },
    );
    expect(result.text).toContain('"failure_class":[[{"2":"first","1":"second"}]]');
  });

  it('preserves an explicitly null schedule_id; defaults only an absent key', () => {
    // Python `config.get("schedule_id", "crq-tick.timer")` defaults only an
    // ABSENT key; an explicit null publishes `"id": null` (the fixture
    // publish-sections.json pins that byte shape). Collapsing null to the
    // default changed the configured schedule identity and the bytes.
    const core = { last_tick: 'x', pending_items: [], starts_cap: 8, generated_at: 'g' };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const baseEffects = {
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
    const explicitNull = publishSummary(core, queue, { schedule_id: null }, {}, baseEffects);
    const scheduleNull = (explicitNull.value['schedule'] as Record<string, unknown>)['id'];
    expect(scheduleNull).toBeNull();
    expect(explicitNull.text).toContain('"schedule":{"id":null');
    const absent = publishSummary(core, queue, {}, {}, baseEffects);
    const scheduleDefault = (absent.value['schedule'] as Record<string, unknown>)['id'];
    expect(scheduleDefault).toBe('crq-tick.timer');
  });

  it('keeps __proto__ triage keys as ordinary own keys', () => {
    // P2-13: plain `out[key] =` on a `__proto__` key silently set the
    // prototype (key lost = corrupted document) and the later serialiser
    // refused the degraded object. The producer's dict keeps it as an own
    // key; ours must too, through the lossless serialiser.
    // status `__proto__` is falsy-but-own: it must land in `counts` verbatim
    // (a __proto__-keyed assignment would silently drop it).
    const row = new TextEncoder().encode(
      '{"status":"__proto__","canonical_id":"c","target":"tip","finding":{"id":"i","title":"Needs","severity":"minor"}}',
    );
    const core = { last_tick: 'x', pending_items: [], starts_cap: 8, generated_at: 'g' };
    const queue = { items: [], starts: [], last_tick: 'x' } as unknown as CrqRecord;
    const result = publishSummary(
      core,
      queue,
      {},
      {},
      {
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
        triageRows: [{ name: 'a.json', bytes: row }],
        systemd: { error: 'x' },
        systemdClock: { realtime: 0, monotonic: 0 },
        ghTitle: () => null,
        readReceipt: () => null,
      },
    );
    expect(result.text).toContain('"counts":{"__proto__":1}');
    // And the prototype was never touched.
    expect(Object.getPrototypeOf({}) === Object.prototype).toBe(true);
  });
});

/** `datetime.fromtimestamp(now, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function generatedAtOf(now: number): string {
  return new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
