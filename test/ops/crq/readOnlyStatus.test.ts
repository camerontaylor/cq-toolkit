/**
 * Oracle and CLI tests for the A1 read-only status route.
 *
 * The expected values come from the Python oracle fixtures under
 * `apps/crq-python/fixtures/a1-status/`, emitted at the same commit. The route
 * is driven through the real filesystem adapter, so the test covers the file
 * boundary (lossless `usage.limit`, JSONL line semantics, receipt bytes and
 * the atomic-free read-only contract) rather than only the pure functions.
 *
 * Summary expectations are the `status_summary.summarize` output with
 * `status_as_of` replaced by the publish clock value: `status_summary.publish`
 * synthesises `{"generated_at": generated}` and
 * `{"last_tick": queue.last_tick}` instead of reading `status.json` or
 * `heartbeat.json`. The two additive #1420 keys are removed from the actual
 * document before comparison because Python does not emit them.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runStatusCli, type StatusStateRoots } from '../../../src/adapters/crq/statusSource.js';
import { utcIsoSeconds } from '../../../src/ops/crq/readOnlyStatus.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText, receiptJsonBytes } from '../../../src/policy/crq/pythonJson.js';
import { parseCrqState } from '../../../src/policy/crq/state.js';

const A1 = new URL('../../../apps/crq-python/fixtures/a1-status/', import.meta.url);
const FIXED_NOW = 1_794_225_600; // 2026-11-09T12:00:00Z
const JSON_BYTES = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
} as const;

interface VectorCase {
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expectOk: boolean;
  readonly expectValue?: JsonValue;
  readonly expectError?: string;
}

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function loadFamily(name: string): VectorCase[] {
  const document = parseJsonValue(readFileSync(new URL(`${name}.json`, A1), 'utf8'));
  if (!(document instanceof JsonObject)) throw new Error(`${name}: root is not an object`);
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  return cases.map((entry, index) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${name}: case ${index} is not an object`);
    const input = entry.get('input');
    const expectation = entry.get('expect');
    const caseName = entry.get('name');
    const source = entry.get('source');
    if (!(input instanceof JsonObject) || !(expectation instanceof JsonObject)) {
      throw new Error(`${name}: case ${index} has no input/expect object`);
    }
    if (typeof caseName !== 'string' || typeof source !== 'string') {
      throw new Error(`${name}: case ${index} has no name/source`);
    }
    const value = expectation.get('value');
    const error = expectation.get('error');
    return {
      name: caseName,
      source,
      input,
      expectOk: expectation.get('ok') === true,
      ...(value === undefined ? {} : { expectValue: value }),
      ...(typeof error === 'string' ? { expectError: error } : {}),
    };
  });
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${label}: expected an object`);
  return value;
}

function requireNumber(value: JsonValue | undefined, label: string): number {
  if (value === undefined) throw new Error(`${label}: expected a number`);
  const plain = toPlainJson(value);
  if (typeof plain !== 'number') throw new Error(`${label}: expected a number`);
  return plain;
}

function compact(value: unknown): string {
  return pythonJsonText(value, JSON_BYTES);
}

async function makeRoots(): Promise<StatusStateRoots> {
  const base = await mkdtemp(join(tmpdir(), 'crq-readonly-status-'));
  dirs.push(base);
  const runnerRoot = join(base, 'runner');
  const stateRoot = join(base, 'state');
  await mkdir(runnerRoot, { recursive: true });
  await mkdir(join(stateRoot, 'receipts'), { recursive: true });
  return { runnerRoot, stateRoot };
}

interface StateWrite {
  readonly queue: JsonObject;
  readonly config?: JsonObject;
  readonly events?: readonly JsonValue[];
  readonly receipts?: ReadonlyMap<string, Uint8Array>;
}

async function writeState(roots: StatusStateRoots, state: StateWrite): Promise<void> {
  await writeFile(join(roots.stateRoot, 'queue.json'), compact(state.queue));
  if (state.config !== undefined) {
    await writeFile(join(roots.runnerRoot, 'config.json'), compact(state.config));
  }
  await writeFile(join(roots.stateRoot, 'events.jsonl'), eventsText(state.events ?? []));
  for (const [id, bytes] of state.receipts ?? []) {
    await writeFile(join(roots.stateRoot, 'receipts', `${id}.json`), bytes);
  }
}

function eventsText(events: readonly JsonValue[]): string {
  return events.length === 0 ? '' : `${events.map((event) => compact(event)).join('\n')}\n`;
}

async function runCli(
  argv: readonly string[],
  roots: StatusStateRoots,
  now: number,
): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runStatusCli(
    argv,
    roots,
    {
      write: (text) => {
        stdout += text;
      },
      error: (text) => {
        stderr += text;
      },
    },
    () => now,
  );
  return { exitCode, stdout, stderr };
}

/**
 * Every real queue item carries an id; the pure-function fixtures are minimal.
 * A generated id is unreferenced by the case's events, so it cannot change the
 * oracle outcome.
 */
function withItemIds(queue: JsonObject): JsonObject {
  return new JsonObject(
    queue.entries.map(([key, value]) => {
      if (key !== 'items' || !Array.isArray(value)) return [key, value] as const;
      const items = value.map((item, index) => {
        if (!(item instanceof JsonObject)) return item;
        if (item.get('id') !== undefined) return item;
        return new JsonObject([['id', `fixture-item-${String(index)}`], ...item.entries]);
      });
      return [key, items] as const;
    }),
  );
}

function parseOutput(stdout: string): JsonObject {
  const parsed = parseJsonValue(stdout, { duplicates: 'last' });
  if (!(parsed instanceof JsonObject)) throw new Error('output is not a JSON object');
  return parsed;
}

/** Remove only the additive #1420 keys; the Python oracle does not emit them. */
function stripAdditive(value: JsonValue): JsonValue {
  if (!(value instanceof JsonObject)) return value;
  return new JsonObject(
    value.entries.map(([key, entry]) => {
      if (key !== 'pending_items' || !Array.isArray(entry)) return [key, entry] as const;
      return [
        key,
        entry.map((item) =>
          item instanceof JsonObject
            ? new JsonObject(
                item.entries.filter(([name]) => name !== 'label' && name !== 'repair_origin'),
              )
            : item,
        ),
      ] as const;
    }),
  );
}

/**
 * `publish`'s core document: the oracle `summarize` value with the synthetic
 * `generated_at`, then `schema_version` and `generated_at` appended, exactly as
 * `data.update(schema_version=2, generated_at=generated)` does.
 */
function expectedCore(expectValue: JsonObject, generatedAt: string): JsonObject {
  const entries: Array<readonly [string, JsonValue]> = expectValue.entries.map(([key, value]) =>
    key === 'status_as_of' ? ([key, generatedAt] as const) : ([key, value] as const),
  );
  entries.push(['schema_version', JsonNumber.int(2)], ['generated_at', generatedAt]);
  return new JsonObject(entries);
}

const DEFAULT_CONFIG = new JsonObject([
  ['repo', 'owner/repo'],
  ['max_starts_per_hour', JsonNumber.int(10)],
]);

describe('summary core against the Python a1-status oracle', () => {
  const cases = loadFamily('summarize');
  test.each(cases)('$name', async (vector) => {
    const roots = await makeRoots();
    const queue = withItemIds(requireObject(vector.input.get('queue'), `${vector.name} queue`));
    const config = requireObject(vector.input.get('config'), `${vector.name} config`);
    const events = vector.input.get('events');
    if (!Array.isArray(events)) throw new Error(`${vector.name}: events is not an array`);
    const now = requireNumber(vector.input.get('now'), `${vector.name} now`);
    await writeState(roots, { queue, config, events });

    const result = await runCli(['summary-core'], roots, now);
    const accepted = parseCrqState('queue.schema.json', compact(queue));
    if (!accepted.ok) {
      // The phase 0.2 schema is stricter than the pure function's fixture
      // queue (for example `generation: true`); fail closed and say why.
      expect(result.exitCode, vector.name).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('queue-invalid:');
      return;
    }
    if (!vector.expectOk) {
      expect(result.exitCode, vector.name).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('summary-failed:');
      if (vector.expectError !== undefined) {
        expect(result.stderr).toContain(`${vector.expectError}:`);
      }
      return;
    }
    expect(result.stderr, vector.name).toBe('');
    expect(result.exitCode, vector.name).toBe(0);
    const actual = stripAdditive(parseOutput(result.stdout));
    const expected = expectedCore(
      requireObject(vector.expectValue, `${vector.name} value`),
      utcIsoSeconds(now),
    );
    expect(compact(actual), vector.name).toBe(compact(expected));
  });
});

describe('receipt-aware merged_current through the file boundary', () => {
  const cases = loadFamily('merged-current');
  test.each(cases)('$name', async (vector) => {
    const roots = await makeRoots();
    const queue = withItemIds(requireObject(vector.input.get('queue'), `${vector.name} queue`));
    const receipts = new Map<string, Uint8Array>();
    const documents = vector.input.get('receipts');
    if (documents instanceof JsonObject) {
      for (const [id, document] of documents.entries) {
        // Reusing the canonical receipt encoder means the verified cases prove
        // the adapter's byte path; the tampered case proves the digest check.
        receipts.set(id, receiptJsonBytes(document));
      }
    }
    await writeState(roots, { queue, config: DEFAULT_CONFIG, events: [], receipts });

    const result = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(result.stderr, vector.name).toBe('');
    expect(result.exitCode, vector.name).toBe(0);
    const output = parseOutput(result.stdout);
    expect(compact(output.get('merged_current')), vector.name).toBe(
      compact(requireObject(vector.expectValue, `${vector.name} value`)),
    );
  });
});

describe('client health against the Python oracle', () => {
  const cases = loadFamily('client-health');
  test.each(cases)('$name', async (vector) => {
    const roots = await makeRoots();
    const queue = withItemIds(requireObject(vector.input.get('queue'), `${vector.name} queue`));
    const now = requireNumber(vector.input.get('now'), `${vector.name} now`);
    // Health reads only the queue; config and events stay absent on purpose.
    await writeFile(join(roots.stateRoot, 'queue.json'), compact(queue));

    const result = await runCli(['health'], roots, now);
    const accepted = parseCrqState('queue.schema.json', compact(queue));
    if (!accepted.ok) {
      expect(result.exitCode, vector.name).toBe(1);
      expect(result.stderr).toContain('queue-invalid:');
      return;
    }
    if (!vector.expectOk) {
      expect(result.exitCode, vector.name).toBe(1);
      expect(result.stderr).toContain('health-failed:');
      if (vector.expectError !== undefined) {
        expect(result.stderr).toContain(`${vector.expectError}:`);
      }
      return;
    }
    expect(result.stderr, vector.name).toBe('');
    expect(result.exitCode, vector.name).toBe(0);
    expect(compact(parseOutput(result.stdout)), vector.name).toBe(
      compact(requireObject(vector.expectValue, `${vector.name} value`)),
    );
  });
});

describe('CLI contract', () => {
  test('help and usage refusals use the stream and exit code contract', async () => {
    const roots = await makeRoots();
    const help = await runCli(['--help'], roots, FIXED_NOW);
    expect(help).toEqual({
      exitCode: 0,
      stdout: 'usage: crq read-only-status <summary-core|health> [--pretty]\n',
      stderr: '',
    });

    for (const argv of [[], ['nope'], ['summary-core', '--wat']] as const) {
      const result = await runCli(argv, roots, FIXED_NOW);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('usage:');
    }
  });

  test('a missing state document is a classified refusal, not a stack trace', async () => {
    const roots = await makeRoots();
    const result = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^queue-invalid: queue\.json unavailable:/u);
  });

  test('--pretty uses Python indent separators and keeps the trailing newline', async () => {
    const roots = await makeRoots();
    await writeState(roots, {
      queue: new JsonObject([['items', []]]),
      config: DEFAULT_CONFIG,
      events: [],
    });
    const result = await runCli(['summary-core', '--pretty'], roots, FIXED_NOW);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('\n  "backfill_reserved_slots": 1,');
    expect(result.stdout.endsWith('\n}\n')).toBe(true);
  });
});

describe('Python numeric lexemes through the file boundary', () => {
  test('an integral usage limit is kept and an integral float falls back', async () => {
    for (const [limit, expected] of [
      ['3', '"starts_cap":3,"in_flight"'],
      ['3.0', '"starts_cap":5,"in_flight"'],
      ['3.00', '"starts_cap":5,"in_flight"'],
      ['3e0', '"starts_cap":5,"in_flight"'],
    ] as const) {
      const roots = await makeRoots();
      const queue = parseJsonValue(`{"items":[],"usage":{"limit":${limit}}}`);
      await writeState(roots, {
        queue: requireObject(queue, 'queue'),
        config: new JsonObject([
          ['repo', 'owner/repo'],
          ['max_starts_per_hour', JsonNumber.int(5)],
        ]),
        events: [],
      });
      const result = await runCli(['summary-core'], roots, FIXED_NOW);
      expect(result.exitCode, limit).toBe(0);
      expect(compact(parseOutput(result.stdout)), limit).toContain(expected);
    }
  });

  test('a float config cap keeps its Python float lexeme', async () => {
    for (const [cap, expected] of [
      ['5', '"starts_cap":5,"in_flight"'],
      ['5.0', '"starts_cap":5.0,"in_flight"'],
      ['5e0', '"starts_cap":5.0,"in_flight"'],
    ] as const) {
      const roots = await makeRoots();
      const config = parseJsonValue(`{"repo":"owner/repo","max_starts_per_hour":${cap}}`);
      await writeState(roots, {
        queue: new JsonObject([['items', []]]),
        config: requireObject(config, 'config'),
        events: [],
      });
      const result = await runCli(['summary-core'], roots, FIXED_NOW);
      expect(result.exitCode, cap).toBe(0);
      expect(compact(parseOutput(result.stdout)), cap).toContain(expected);
    }
  });

  test('the starts_cap integer outside the safe range keeps its exact digits', async () => {
    const roots = await makeRoots();
    const queue = parseJsonValue('{"items":[],"usage":{"limit":9007199254740993}}');
    await writeState(roots, {
      queue: requireObject(queue, 'queue'),
      config: DEFAULT_CONFIG,
      events: [],
    });
    const result = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(result.exitCode).toBe(0);
    expect(compact(parseOutput(result.stdout))).toContain(
      '"starts_cap":9007199254740993,"in_flight"',
    );
  });

  test('an aging deadline is a Python float, never an integer', async () => {
    const roots = await makeRoots();
    const queue = parseJsonValue(
      JSON.stringify({
        items: [
          {
            id: 'repeat',
            kind: 'local-review',
            state: 'pending',
            generation: 1,
            repeat_requested: true,
            created_at: '1970-01-01T00:00:00Z',
          },
        ],
      }),
    );
    await writeState(roots, {
      queue: requireObject(queue, 'queue'),
      config: DEFAULT_CONFIG,
      events: [],
    });
    // now = 3599: the deadline (created + 60 min) is 3600.0.
    const result = await runCli(['summary-core'], roots, 3599);
    expect(result.exitCode).toBe(0);
    expect(compact(parseOutput(result.stdout))).toContain('"aging_deadline":3600.0');
  });

  test('a zero health age stays a Python int while a positive age is a float', async () => {
    const future = await makeRoots();
    await writeFile(
      join(future.stateRoot, 'queue.json'),
      JSON.stringify({ client_health: { completed_at: '2026-11-09T12:00:00Z' }, items: [] }),
    );
    const futureResult = await runCli(['health'], future, FIXED_NOW);
    expect(futureResult.exitCode).toBe(0);
    expect(compact(parseOutput(futureResult.stdout))).toContain('"ageSeconds":0,');

    const aged = await makeRoots();
    await writeFile(
      join(aged.stateRoot, 'queue.json'),
      JSON.stringify({ client_health: { completed_at: '2026-11-09T11:50:00Z' }, items: [] }),
    );
    const agedResult = await runCli(['health'], aged, FIXED_NOW);
    expect(agedResult.exitCode).toBe(0);
    expect(compact(parseOutput(agedResult.stdout))).toContain('"ageSeconds":600.0,');
  });
});

describe('read-only invariants', () => {
  test('summary and health do not create, remove or modify any file', async () => {
    const roots = await makeRoots();
    await writeState(roots, {
      queue: new JsonObject([
        ['items', []],
        [
          'client_health',
          new JsonObject([
            ['completed_at', '2026-11-09T11:50:00Z'],
            ['complete', true],
          ]),
        ],
      ]),
      config: DEFAULT_CONFIG,
      events: [],
    });
    const before = await snapshotTree(join(roots.stateRoot, '..'));
    expect((await runCli(['summary-core'], roots, FIXED_NOW)).exitCode).toBe(0);
    expect((await runCli(['health'], roots, FIXED_NOW)).exitCode).toBe(0);
    expect(await snapshotTree(join(roots.stateRoot, '..'))).toEqual(before);
  });

  test('events JSONL follows Python read_events line semantics', async () => {
    const roots = await makeRoots();
    await writeFile(join(roots.stateRoot, 'queue.json'), JSON.stringify({ items: [] }));
    await writeFile(
      join(roots.runnerRoot, 'config.json'),
      '{"repo":"owner/repo","max_starts_per_hour":5}',
    );
    // Unterminated final fragment: ignored, like Python's exception branch.
    await writeFile(join(roots.stateRoot, 'events.jsonl'), '{"event":"x"}\n{"not":');
    const partial = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(partial.exitCode).toBe(0);

    // A complete corrupt record is fatal.
    await writeFile(join(roots.stateRoot, 'events.jsonl'), '{"event":"x"}\n{"not":\n');
    const corrupt = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.stderr).toMatch(/^events-invalid: events\.jsonl line 2:/u);

    // An empty terminated line is corrupt in Python too.
    await writeFile(join(roots.stateRoot, 'events.jsonl'), '{"event":"x"}\n\n');
    const blank = await runCli(['summary-core'], roots, FIXED_NOW);
    expect(blank.exitCode).toBe(1);
    expect(blank.stderr).toMatch(/^events-invalid: events\.jsonl line 2:/u);
  });
});

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    snapshot[path.slice(root.length + 1)] = (await readFile(path)).toString('base64');
  }
  return snapshot;
}
