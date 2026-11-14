import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileArtifactStore } from '../../../src/adapters/crq/findingStore.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  BACKFILL_SNAPSHOT_KEYS,
  BackfillInventoryError,
  capture,
  captureTier,
  confirmedCounts,
  effectiveLimits,
  fnmatchCase,
  intervalsOf,
  queueSnapshot,
  rank,
  rangesOf,
  replay,
  requiredGroups,
  type InventoryArtifacts,
} from '../../../src/policy/crq/backfillInventory.js';
import { ledgerLoads } from '../../../src/policy/crq/ledger.js';
import { ledgerJsonDigest, sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import { captureFixtureManifest, loadFamily, valueAt } from './backfillFixtures.js';

const INVENTORY = loadFamily('backfill-inventory');

describe.each(INVENTORY)('group-p backfill-inventory/$name', (vector) => {
  test('backfill_inventory.rank matches the Python oracle', () => {
    expect(rank(valueAt(vector.input, 'manifest'), valueAt(vector.input, 'inputs'))).toEqual(
      toPlainJson(valueAt(vector.expect, 'value') as JsonValue),
    );
  });
});

const ACCOUNTING = loadFamily('backfill').filter(
  (vector) => vector.source === 'backfill_accounting.ranges',
);

describe.each(ACCOUNTING)('group-p backfill-accounting/$name', (vector) => {
  test('backfill_accounting.ranges matches the Python oracle', () => {
    const lines = toPlainJson(valueAt(vector.input, 'lines') as JsonValue);
    if (!Array.isArray(lines)) throw new Error('lines must be an array');
    const numbers = lines.map((line) => {
      if (typeof line !== 'number' && typeof line !== 'boolean') {
        throw new Error('a vector line is not a Python int');
      }
      return line;
    });
    expect(rangesOf(numbers)).toEqual(toPlainJson(valueAt(vector.expect, 'value') as JsonValue));
  });
});

/** The retained artifacts of one capture: verified, then read by location. */
function memoryArtifacts(
  inputs: JsonObject,
  overrides: Map<string, string> = new Map(),
): InventoryArtifacts {
  return {
    async verify(reference: unknown) {
      const digest = (reference as { sha256?: unknown }).sha256;
      if (typeof digest !== 'string') throw new Error('bad reference');
      if (overrides.has(digest)) {
        throw new BackfillInventoryError('missing or corrupt retained artifact');
      }
    },
    async read(reference: unknown) {
      const location = (reference as { location?: unknown }).location;
      if (typeof location !== 'string' || !location.startsWith('fixture/')) {
        throw new Error('unknown artifact');
      }
      const key = location.slice('fixture/'.length);
      const value = inputs.get(key);
      if (value === undefined) throw new Error(`missing snapshot ${key}`);
      return value;
    },
  };
}

function firstVectorInputs(): JsonObject {
  const vector = INVENTORY[0];
  if (vector === undefined) throw new Error('inventory vectors are empty');
  return valueAt(vector.input, 'inputs') as JsonObject;
}

test('replay verifies the manifest and every snapshot before ranking', async () => {
  const inputs = firstVectorInputs();
  const manifest = captureFixtureManifest(inputs);
  await expect(replay(manifest, memoryArtifacts(inputs))).resolves.toEqual(rank(manifest, inputs));
});

test('replay refuses a manifest whose id does not cover its contents', async () => {
  const inputs = firstVectorInputs();
  const manifest = captureFixtureManifest(inputs);
  manifest['target'] = '9'.repeat(40);
  await expect(replay(manifest, memoryArtifacts(inputs))).rejects.toThrow(
    'inventory manifest mismatch',
  );
});

test('replay refuses a manifest under another policy version', async () => {
  const inputs = firstVectorInputs();
  const manifest = captureFixtureManifest(inputs);
  manifest['version'] = 'cq.backfill-inventory/v0';
  await expect(replay(manifest, memoryArtifacts(inputs))).rejects.toThrow(
    'inventory manifest mismatch',
  );
});

test('replay refuses a corrupt retained artifact', async () => {
  const inputs = firstVectorInputs();
  const manifest = captureFixtureManifest(inputs);
  const snapshots = manifest['snapshots'] as Record<string, { sha256: string }>;
  const limits = snapshots['limits'];
  if (limits === undefined) throw new Error('fixture has no limits snapshot');
  await expect(
    replay(manifest, memoryArtifacts(inputs, new Map([[limits.sha256, 'corrupt']]))),
  ).rejects.toThrow('missing or corrupt retained artifact');
});

test('replay refuses a snapshot whose content digest does not match the manifest', async () => {
  const inputs = firstVectorInputs();
  const manifest = captureFixtureManifest(inputs);
  const objects = inputs.get('objects');
  if (!Array.isArray(objects)) throw new Error('fixture has no object rows');
  // The retained artifact no longer hashes to what the manifest recorded: the
  // manifest is intact, so the refusal names the snapshot.
  const tampered = new JsonObject([
    ...inputs.entries.filter(([key]) => key !== 'objects'),
    ['objects', objects.slice(0, Math.max(0, objects.length - 1))],
  ]);
  await expect(replay(manifest, memoryArtifacts(tampered))).rejects.toThrow(
    'inventory snapshot digest mismatch',
  );
});

test('unknown row fields survive ranking', () => {
  const inputs = firstVectorInputs();
  const objects = inputs.get('objects');
  if (!Array.isArray(objects)) throw new Error('fixture has no object rows');
  const first = objects[0];
  if (!(first instanceof JsonObject)) throw new Error('fixture object row is not an object');
  const extended = new JsonObject([
    ...first.entries,
    ['diagnostic', new JsonObject([['cq.legacy-number/v1', '1.5']])],
  ]);
  const rebuilt = new JsonObject([
    ...inputs.entries.filter(([key]) => key !== 'objects'),
    ['objects', [extended, ...objects.slice(1)]],
  ]);
  const manifest = captureFixtureManifest(rebuilt);
  const ranked = rank(manifest, rebuilt);
  const path = ranked.paths.find((row) => row['path'] === extended.get('path'));
  expect(path?.['diagnostic']).toEqual({ 'cq.legacy-number/v1': '1.5' });
});

test('the manifest id is the digest of every other field', () => {
  const manifest = captureFixtureManifest(firstVectorInputs());
  const withoutId: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) if (key !== 'id') withoutId[key] = value;
  expect(manifest['id']).toBe(ledgerJsonDigest(withoutId));
});

test('interval sets refuse inverted and overlapping pairs', () => {
  expect(() =>
    intervalsOf([
      [2, 2],
      [1, 1],
    ]),
  ).toThrow('invalid or overlapping');
  expect(() =>
    intervalsOf([
      [1, 3],
      [2, 4],
    ]),
  ).toThrow('invalid or overlapping');
  expect(() => intervalsOf([[1, 0]])).toThrow('invalid or overlapping');
  expect(() => intervalsOf([[true, 1]])).toThrow('must be an integer');
  expect([
    ...intervalsOf([
      [1, 1],
      [3, 4],
    ]),
  ]).toEqual([1, 3, 4]);
});

test('ranges coalesce, de-duplicate and stay ascending', () => {
  expect(rangesOf([5, 1, 2, 2, 9, 10, 11])).toEqual([
    [1, 2],
    [5, 5],
    [9, 11],
  ]);
  expect(rangesOf([])).toEqual([]);
  // Python's `bool` is an `int`: the interval keeps the captured value.
  expect(rangesOf([true, false, 2])).toEqual([[false, 2]]);
});

test('construction limits read a deployment policy that was decoded losslessly', () => {
  // `policy/review-limits.json` reaches the runner through `parseJsonValue`, so
  // every bound (the diff limit included) arrives as a `JsonNumber`.
  const decoded = parseJsonValue(
    JSON.stringify({
      max_files: 100,
      max_file_bytes: 1_000_000,
      max_total_bytes: 8_000_000,
      reviewer: { verified: true, evidence: 'fixture', max_files: 12, max_diff_bytes: 4096 },
    }),
  );
  expect(effectiveLimits(decoded, { requireVerified: true })).toEqual({
    files: 8,
    perFile: 256 * 1024,
    total: 2 * 1024 * 1024,
    diff: 4096,
  });
});

test('construction limits are bounded by the hard caps', () => {
  const limits = {
    max_files: 100,
    max_file_bytes: 1_000_000,
    max_total_bytes: 8_000_000,
    reviewer: { verified: true, evidence: 'fixture', max_files: 12, max_diff_bytes: 4096 },
  };
  expect(effectiveLimits(limits, { requireVerified: false })).toEqual({
    files: 8,
    perFile: 256 * 1024,
    total: 2 * 1024 * 1024,
    diff: 4096,
  });
  expect(effectiveLimits(limits, { requireVerified: true }).diff).toBe(4096);
});

test('an unverified reviewer limit blocks enqueue but not replay', () => {
  const limits = {
    max_files: 4,
    max_file_bytes: 1000,
    max_total_bytes: 2000,
    // Even a complete limit set is refused while the reviewer has not verified
    // the deployment: this is the go-live gate, not a smaller construction.
    reviewer: { verified: false, evidence: 'deployed', max_files: 4, max_diff_bytes: 4096 },
  };
  expect(effectiveLimits(limits, { requireVerified: false }).diff).toBe(4096);
  expect(() => effectiveLimits(limits, { requireVerified: true })).toThrow(
    'deployed reviewer limits not verified; go-live blocked',
  );
  const unproven = { ...limits, reviewer: { ...limits.reviewer, verified: true, evidence: '' } };
  expect(() => effectiveLimits(unproven, { requireVerified: true })).toThrow(
    'deployed reviewer limits not verified; go-live blocked',
  );
  const noDiff = {
    ...limits,
    reviewer: { ...limits.reviewer, verified: true, evidence: 'x', max_diff_bytes: 0 },
  };
  expect(() => effectiveLimits(noDiff, { requireVerified: true })).toThrow(
    'invalid construction limits',
  );
});

test('required groups only union explicitly named PRs, once', () => {
  const required = {
    rows: [
      { row: 1, pr: 10 },
      { row: 2, pr: 11 },
      { row: 3, pr: 12 },
    ],
    explicit_unions: [[10, 11]],
  };
  expect(requiredGroups(required)).toEqual([
    { prs: [10, 11], row: 1 },
    { prs: [12], row: 3 },
  ]);
  expect(() => requiredGroups({ ...required, explicit_unions: [[10, 99]] })).toThrow(
    'invalid explicit PR union',
  );
  expect(() =>
    requiredGroups({
      ...required,
      explicit_unions: [
        [10, 11],
        [11, 12],
      ],
    }),
  ).toThrow('invalid explicit PR union');
  expect(() =>
    requiredGroups({
      rows: [
        { row: 1, pr: 10 },
        { row: 1, pr: 11 },
      ],
      explicit_unions: [],
    }),
  ).toThrow('duplicate required-list row');
});

describe('capture seam', () => {
  const protectedBytes = new TextEncoder().encode('{"policy":true}');
  const jsonValue = (value: unknown): JsonValue => parseJsonValue(JSON.stringify(value));

  function fixture() {
    const puts: Array<{ sha256: string; bytes: Uint8Array }> = [];
    const base = mkdtempSync(join(tmpdir(), 'crq-capture-'));
    const store = fileArtifactStore(join(base, 'artifacts'));
    const artifacts = {
      async put(data: Uint8Array) {
        puts.push({ sha256: sha256Hex(data), bytes: data });
        return store.put(data);
      },
      async verify() {
        return Promise.resolve();
      },
    };
    const tiers = {
      version: 1,
      protected_policy_sha256: sha256Hex(protectedBytes),
      protected_patterns: ['^policy/protected-paths\\.json$'],
      tiers: { T1: [], T2: ['src/selfhost/**'], T3: ['src/**'], T4: ['**'] },
    };
    const limits = {
      version: 1,
      construction_version: 'fixture-v1',
      scoring_version: 'fixture-v1',
      max_files: 8,
      max_file_bytes: 1000,
      max_total_bytes: 1000,
      reviewer: {},
    };
    const rows = [
      {
        path: 'src/a.ts',
        blob: 'a'.repeat(40),
        mode: '100644',
        kind: 'blob',
        lines: 2,
        bytes: 4,
        disposition: 'included',
        reason: 'tracked regular UTF8 text',
      },
      {
        path: 'policy/protected-paths.json',
        blob: 'b'.repeat(40),
        mode: '100644',
        kind: 'blob',
        lines: 1,
        bytes: 2,
        disposition: 'included',
        reason: 'tracked regular UTF8 text',
      },
    ];
    const repo = {
      resolve: async (target: string) => target,
      tree: async () => 'c'.repeat(40),
      gitVersion: async () => 'git version 2.43.0',
      inventory: async () => rows,
      coverage: async () => ({
        covered: new Map([['src/a.ts', new Set([1])]]),
        evidence: new Map([['src/a.ts', ['finding-1']]]),
        gaps: [],
      }),
      churn: async () => new Map([['src/a.ts', 2]]),
      lineage: async () => null,
      carry: async () => ({ name: null, mapped: new Set<number>() }),
      retain: async (store: typeof artifacts) => ({
        ...(await store.put(new TextEncoder().encode('bundle'))),
        kind: 'git-bundle',
      }),
    };
    return { artifacts, tiers, limits, repo, puts };
  }

  test('pins every snapshot, enriches each row and digests the manifest', async () => {
    const { artifacts, tiers, limits, repo, puts } = fixture();
    const manifest = await capture({
      repo,
      target: '1'.repeat(40),
      ledgerHead: '2'.repeat(40),
      events: [],
      artifacts,
      queue: { items: [], backfill_scope_failures: {} },
      required: { rows: [], explicit_unions: [] },
      tiers,
      limits,
      evaluatedAt: '2026-11-09T00:00:00Z',
      requiredPaths: {},
      protectedBytes,
      members: {},
    });
    const snapshots = manifest['snapshots'] as Record<string, { location: string }>;
    const objects = toPlainJson(
      ledgerLoads(readFileSync(snapshots['objects']?.location ?? '')),
    ) as Array<Record<string, unknown>>;
    expect(objects[0]).toMatchObject({
      path: 'src/a.ts',
      tier: 'T3',
      covered: [[1, 1]],
      evidence: ['finding-1'],
      churn: 2,
      findings: 0,
    });
    expect(objects[1]?.['tier']).toBe('T1');
    expect(Object.keys(snapshots)).toEqual([...BACKFILL_SNAPSHOT_KEYS]);
    expect(manifest['git_version']).toBe('git version 2.43.0');
    expect(manifest['git_bundle']).toMatchObject({ kind: 'git-bundle' });
    expect(manifest['queue_encoding']).toBe('legacy-number-tag/v1');
    const withoutId: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(manifest)) if (key !== 'id') withoutId[key] = value;
    expect(manifest['id']).toBe(ledgerJsonDigest(withoutId));
    // The raw queue is the compact, sorted, ASCII-escaped Python bytes.
    expect(Buffer.from(puts[0]?.bytes ?? []).toString()).toBe(
      '{"backfill_scope_failures":{},"items":[]}',
    );
  });

  test('a protected-path snapshot mismatch refuses before any capture', async () => {
    const { artifacts, tiers, limits, repo } = fixture();
    await expect(
      capture({
        repo,
        target: '1'.repeat(40),
        ledgerHead: '2'.repeat(40),
        events: [],
        artifacts,
        queue: {},
        required: {},
        tiers,
        limits,
        evaluatedAt: '2026-11-09T00:00:00Z',
        requiredPaths: {},
        protectedBytes: new TextEncoder().encode('different'),
      }),
    ).rejects.toThrow('tier policy does not match protected-path snapshot');
  });

  test('legacy float diagnostics are tagged and non-finite values refuse', () => {
    const snapshot = queueSnapshot(jsonValue({ value: 1.5, nested: [2, 'x'] })) as {
      value: unknown;
      nested: JsonValue[];
    };
    expect(snapshot.value).toEqual({ 'cq.legacy-number/v1': '1.5' });
    expect(snapshot.nested.map((entry) => toPlainJson(entry))).toEqual([2, 'x']);
    expect(() => queueSnapshot(Number.POSITIVE_INFINITY)).toThrow('non-finite queue diagnostic');
  });

  test('tiers follow protected patterns, then globs in T1..T4 order', () => {
    expect(
      captureTier('policy/protected-paths.json', {
        protected_patterns: ['^policy/protected-paths\\.json$'],
        tiers: { T1: [], T2: [], T3: ['**'], T4: ['**'] },
      }),
    ).toBe('T1');
    expect(
      captureTier('src/selfhost/a.ts', {
        protected_patterns: [],
        tiers: { T1: [], T2: ['src/selfhost/**'], T3: ['src/**'], T4: ['**'] },
      }),
    ).toBe('T2');
    expect(fnmatchCase('src/a.ts', 'src/**')).toBe(true);
    expect(fnmatchCase('src/a.ts', 'src/*.ts')).toBe(true);
    expect(fnmatchCase('src/a.ts', 'src/*.js')).toBe(false);
    for (const [name, glob, expected] of [
      ['b', '[^a]', false],
      ['^', '[^a]', true],
      ['x', '[z-a]', false],
      ['a', '[!a]', false],
      ['b', '[!a]', true],
      [']', '[]]', true],
      [']', '[!]]', false],
      ['a', '[!]]', true],
      ['-', '[a-]', true],
      ['*', '[*]', true],
      ['\n', '*', true],
      ['a/b', 'a*b', true],
      ['[', '[[]', true],
    ] as const) {
      expect(fnmatchCase(name, glob)).toBe(expected);
    }
    expect(() =>
      captureTier('docs/a.md', {
        protected_patterns: [],
        tiers: { T1: [], T2: [], T3: [], T4: [] },
      }),
    ).toThrow('path has no importance tier');
  });

  test('confirmed counts follow duplicate evidence to one canonical id', () => {
    const events = [
      jsonValue({
        event_type: 'review',
        payload: {
          findings: [
            { id: 'f1', path: 'src/a.ts' },
            { id: 'f2', path: 'src/a.ts' },
          ],
        },
      }),
      jsonValue({
        event_type: 'finding-event',
        payload: {
          finding_id: 'f2',
          action: 'duplicate',
          evidence: { canonical_id: 'f1' },
        },
      }),
      jsonValue({
        event_type: 'finding-event',
        payload: { finding_id: 'f1', action: 'confirmed' },
      }),
    ];
    expect([...confirmedCounts(events)]).toEqual([['src/a.ts', 1]]);
  });
});
