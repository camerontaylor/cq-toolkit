// `review_transport._retained_records` parity: the TS loader replays Python-generated
// vectors (apps/crq-python/retained_records_vectors.py), including the records Python
// returns without validating them and the exceptions it lets escape.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { createReviewEffects } from '../../../src/adapters/crq/reviewEffects.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { toPlainJson } from '../../../src/policy/crq/jsonValue.js';

interface Vector {
  readonly name: string;
  readonly files: readonly { root: string; name: string; b64: string }[];
  readonly expect: { records?: string[]; error?: string };
}

const document = JSON.parse(
  await readFile(
    new URL('../../../apps/crq-python/fixtures/crq-retained-records/cases.json', import.meta.url),
    'utf8',
  ),
) as { cases: Vector[] };

/** Python `json.dumps(record, sort_keys=True)` over ids and integers only needs a stable key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

async function replay(vector: Vector) {
  const root = await mkdtemp(join(tmpdir(), 'crq-retained-parity-'));
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  const state = join(root, 'state');
  for (const file of vector.files) {
    const target = join(state, file.root, 'pending', file.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.b64, 'base64'));
  }
  if (vector.name.startsWith('directory-named-json')) {
    await mkdir(join(state, 'record-outbox', 'pending', 'a-dir.json'), { recursive: true });
  }
  const config = parseJsonValue(JSON.stringify({ clone, repos: [] }), { duplicates: 'error' });
  if (!(config instanceof JsonObject)) throw new Error('config');
  const pool = new GitPool();
  try {
    const { effects } = createReviewEffects({
      root,
      repo: 'camerontaylor/cq-toolkit',
      config,
      pool,
    });
    return await effects.retainedRecords();
  } finally {
    pool.killAll();
  }
}

describe('retainedRecords matches review_transport._retained_records', () => {
  for (const vector of document.cases) {
    test(vector.name, async () => {
      if (vector.expect.error !== undefined) {
        await expect(replay(vector)).rejects.toMatchObject({ name: vector.expect.error });
        return;
      }
      const records = await replay(vector);
      expect(
        records.map((record) => JSON.stringify(sortKeys(toPlainJson(record, { bigints: false })))),
      ).toEqual(
        (vector.expect.records ?? []).map((text) => JSON.stringify(sortKeys(JSON.parse(text)))),
      );
    });
  }
});
