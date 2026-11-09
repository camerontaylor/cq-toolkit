import { pythonSchemaAccepts } from '../../../src/policy/crq/pythonSchema.js';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CRQ_STATE_SCHEMA_NAMES,
  crqStateSchemaDocuments,
  type CrqStateSchemaName,
} from '../../../src/policy/crq/schemas.js';
import {
  parseCrqState,
  parseCrqStateLines,
  validateCrqState,
  type CrqStateResult,
} from '../../../src/policy/crq/state.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';

const ROOT = new URL('../../../', import.meta.url);
const POLICY = new URL('policy/crq/', ROOT);
const FIXTURES = new URL('apps/crq-python/fixtures/crq-state-schema-samples/', ROOT);
const DEPLOYED = new URL('apps/crq-python/fixtures/state-20261109/', ROOT);
const AUTHOR_CAPTURE = new URL('apps/crq-python/fixtures/author-0e35cd11.json', ROOT);

interface IndexEntry {
  path: string;
  schema: CrqStateSchemaName;
  lines?: boolean;
  text?: boolean;
}

const index = JSON.parse(readFileSync(new URL('index.json', FIXTURES), 'utf8')) as {
  documents: IndexEntry[];
};

function read(path: URL): string {
  return readFileSync(path, 'utf8');
}

describe('generated schemas against phase 0.2', () => {
  test('every checked-in schema is embedded and nothing extra is', () => {
    const files = readdirSync(POLICY)
      .filter((name) => name.endsWith('.schema.json'))
      .sort();
    expect([...CRQ_STATE_SCHEMA_NAMES]).toEqual(files);
  });

  test('embedded documents are byte-for-byte equivalent to the policy files', () => {
    for (const name of CRQ_STATE_SCHEMA_NAMES) {
      const source = toPlainJson(parseJsonValue(read(new URL(name, POLICY))));
      expect(crqStateSchemaDocuments[name], name).toEqual(source);
    }
  });

  test('every schema has a representative fixture and vice versa', () => {
    const used = new Set(index.documents.map((entry) => entry.schema));
    const committed = new Set<string>(CRQ_STATE_SCHEMA_NAMES);
    expect([...committed].filter((name) => !used.has(name as CrqStateSchemaName))).toEqual([]);
    expect([...used].filter((name) => !committed.has(name))).toEqual([]);
  });

  test('the queue schema has no top-level schema_version (phase 0.2 decision)', () => {
    const queue = crqStateSchemaDocuments['queue.schema.json'] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(queue.properties['schema_version']).toBeUndefined();
    expect(queue.required).not.toContain('schema_version');
  });

  test('every live queue item kind is described and exercised by the sample', () => {
    const queue = crqStateSchemaDocuments['queue.schema.json'] as {
      properties: {
        items: {
          items: {
            properties: { kind: { enum: string[] } };
          };
        };
      };
    };
    const kinds = new Set(queue.properties.items.items.properties.kind.enum);
    const fixture = parseJsonValue(read(new URL('queue.json', FIXTURES)));
    const items = (toPlainJson(fixture) as { items: Array<{ kind: string }> }).items;
    expect(new Set(items.map((item) => item.kind))).toEqual(kinds);
  });
});

describe('representative state fixtures', () => {
  test('every document, JSONL line and text timestamp validates', () => {
    for (const entry of index.documents) {
      const text = read(new URL(entry.path, FIXTURES));
      if (entry.text) {
        expect(parseCrqState(entry.schema, text), entry.path).toMatchObject({ ok: true });
        continue;
      }
      if (entry.lines) {
        const results = parseCrqStateLines(entry.schema, text);
        expect(results.length).toBeGreaterThan(0);
        for (const result of results) {
          expect(result, `${entry.path}:${String(result.line)}`).toMatchObject({ ok: true });
        }
        continue;
      }
      expect(parseCrqState(entry.schema, text), entry.path).toMatchObject({ ok: true });
    }
  });

  test('the synthetic deployed snapshot validates read-only', () => {
    const documents: Array<[string, CrqStateSchemaName, 'json' | 'lines' | 'text']> = [
      ['queue.json', 'queue.schema.json', 'json'],
      ['heartbeat.json', 'heartbeat.schema.json', 'json'],
      ['repair/provider-cooldowns.json', 'provider-cooldowns.schema.json', 'json'],
      ['runs/open-101-20261108T235500Z/meta.json', 'run-meta.schema.json', 'json'],
      ['runs/open-101-20261108T235500Z/exit.json', 'run-exit.schema.json', 'json'],
      [
        'runs/open-101-20261108T235500Z/classification.json',
        'run-classification.schema.json',
        'json',
      ],
      ['runs/open-101-20261108T235500Z/secret-scan.json', 'run-secret-scan.schema.json', 'json'],
      ['events.jsonl', 'events.schema.json', 'lines'],
      ['work.jsonl', 'work-record.schema.json', 'lines'],
      ['next-review-at', 'next-review-at.schema.json', 'text'],
    ];
    for (const [path, schema, kind] of documents) {
      const text = read(new URL(path, DEPLOYED));
      if (kind === 'lines') {
        for (const result of parseCrqStateLines(schema, text)) {
          expect(result, `${path}:${String(result.line)}`).toMatchObject({ ok: true });
        }
      } else {
        expect(parseCrqState(schema, text), path).toMatchObject({ ok: true });
      }
    }
  });

  test('the captured historical queue validates with an unknown top-level key', () => {
    const capture = parseJsonValue(read(AUTHOR_CAPTURE)) as JsonObject;
    const queue = (capture.get('capture') as JsonObject).get('queue');
    expect(queue).toBeInstanceOf(JsonObject);
    expect((queue as JsonObject).has('unknown')).toBe(true);
    expect(validateCrqState('queue.schema.json', queue as JsonObject)).toMatchObject({ ok: true });
  });
});

describe('source-text integer parity', () => {
  const heartbeat = read(new URL('heartbeat.json', FIXTURES));

  test('an integer lexeme validates', () => {
    expect(parseCrqState('heartbeat.schema.json', heartbeat)).toMatchObject({ ok: true });
  });

  test('a float lexeme in an integer position is refused, not rounded through zod', () => {
    const mutated = heartbeat.replace(/"stale_alarm_min": \d+/, '"stale_alarm_min": 36.0');
    expect(mutated).not.toBe(heartbeat);
    const result = parseCrqState('heartbeat.schema.json', mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.divergence).toContain('Python schema rejects');
    }
  });

  test('the same rule applies inside an arbitrary-key map', () => {
    // Written as source text: JSON.stringify(1.0) would erase the float
    // lexeme this test exists to preserve.
    const coverage =
      '{"schema_version":1,"paths":{"a.py":{"review_count":1.0,"last_reviewed_at":null}},"runs":{},"observations":{}}';
    const result = parseCrqState('coverage.schema.json', coverage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.divergence).toContain('Python schema rejects');
  });

  test('a Unicode-digit timestamp is a visible divergence, never a silent pass', () => {
    // Python's `\d` is Unicode-aware and its pattern validator accepts
    // Arabic-Indic digits; zod's ECMAScript `\d` is ASCII-only. The lossless
    // evaluator keeps Python semantics, zod rejects, and parseCrqState reports
    // the disagreement instead of accepting the document.
    const heartbeat = '{"last_tick":"٢٠٢٦-١١-٠٩T٠٩:٤٨:٠٠Z","stale_alarm_min":36,"root":"/srv/crq"}';
    const result = parseCrqState('heartbeat.schema.json', heartbeat);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.divergence).toContain('zod rejected');
  });
});

describe('negatives', () => {
  test('missing required fields are refused by both validators', () => {
    const result = parseCrqState('queue.schema.json', '{}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.divergence).toBeUndefined();
    expect(assertRejected(result)).toMatch(/items/);
  });

  test('a wrong timestamp pattern is refused by both validators', () => {
    const result = parseCrqState(
      'heartbeat.schema.json',
      JSON.stringify({
        last_tick: '2026-11-09T09:48:00+00:00',
        stale_alarm_min: 36,
        root: '/srv/crq',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.divergence).toBeUndefined();
  });

  test('a non-integer numeric value is refused by both validators', () => {
    const result = parseCrqState(
      'heartbeat.schema.json',
      JSON.stringify({ last_tick: '2026-11-09T09:48:00Z', stale_alarm_min: 1.5, root: '/srv/crq' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.divergence).toBeUndefined();
  });

  test('unknown top-level queue keys stay admitted', () => {
    const queue = parseJsonValue(read(new URL('queue.json', FIXTURES)));
    expect(queue).toBeInstanceOf(JsonObject);
    const mutated = new JsonObject([
      ...(queue as JsonObject).entries,
      ['future_accumulator', new JsonObject([['any', ['shape']]])],
    ]);
    expect(validateCrqState('queue.schema.json', mutated)).toMatchObject({ ok: true });
  });

  test('a map interior of the wrong type is refused', () => {
    const document = JSON.stringify({ 'owner/repo': 1 });
    expect(parseCrqState('provider-cooldowns.schema.json', document).ok).toBe(false);
  });
});

function assertRejected(result: CrqStateResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

test('schema additionalProperties applies to inherited object names', () => {
  const rule = { type: 'object', properties: {}, additionalProperties: { type: 'string' } };
  for (const key of ['constructor', 'toString', '__proto__']) {
    expect(pythonSchemaAccepts(rule, parseJsonValue(`{"${key}":1}`)).accepted).toBe(false);
    expect(pythonSchemaAccepts(rule, parseJsonValue(`{"${key}":"ok"}`)).accepted).toBe(true);
  }
});
