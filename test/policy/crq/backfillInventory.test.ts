import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  BackfillInventoryError,
  effectiveLimits,
  intervalsOf,
  rank,
  rangesOf,
  replay,
  requiredGroups,
  type InventoryArtifacts,
} from '../../../src/policy/crq/backfillInventory.js';
import { ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';
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
    reviewer: { verified: false, max_files: 4 },
  };
  expect(effectiveLimits(limits, { requireVerified: false }).diff).toBeNull();
  expect(() => effectiveLimits(limits, { requireVerified: true })).toThrow(
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
