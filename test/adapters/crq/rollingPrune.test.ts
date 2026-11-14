import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mayPruneRollingWrapper,
  pruneRollingWrappers,
} from '../../../src/adapters/crq/rollingPrune.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  checkpointDigest,
  reconcileWrapperKey,
  RECONCILE_METHOD_CLOSED_UPDATED,
} from '../../../src/policy/crq/reconcileCheckpoint.js';

const repo = 'acme/repo';
const after = '2026-09-01T00:00:00Z';
const before = '2026-09-01T00:12:00Z';
const cutoff = '2026-10-01T00:00:00Z';
const key = reconcileWrapperKey(repo, { after, before }, RECONCILE_METHOD_CLOSED_UPDATED);
function wrapper(complete = true, dry = false): string {
  const body = new JsonObject([
    ['source', new JsonObject([['method', RECONCILE_METHOD_CLOSED_UPDATED]])],
    [
      'checkpoint',
      new JsonObject([
        ['after', after],
        ['before', before],
        ['complete', complete],
        ['dry_run', dry],
      ]),
    ],
  ]);
  return JSON.stringify({
    source: { method: RECONCILE_METHOD_CLOSED_UPDATED },
    checkpoint: { after, before, complete, dry_run: dry },
    digest: checkpointDigest(body),
  });
}
function queue(value: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(value)) as JsonObject;
}

describe('rolling wrapper retention', () => {
  it('requires identity, integrity, enrollment and age proof', () => {
    const check = (
      text: string,
      pathKey = key,
      watermark = before,
      bound = cutoff,
      keep = new Set<string>(),
    ) => mayPruneRollingWrapper(text, pathKey, repo, watermark, bound, keep);
    expect(check(wrapper())).toBe(true);
    expect(check(wrapper(false))).toBe(false);
    expect(check(wrapper(true, true))).toBe(false);
    expect(check(wrapper().replace('closed-updated-v1', 'all-number-slots-v1'))).toBe(false);
    expect(check(wrapper(), 'f'.repeat(64))).toBe(false);
    expect(check(wrapper(), key, after)).toBe(false);
    expect(check(wrapper(), key, before, before)).toBe(false);
    expect(check(wrapper(), key, before, cutoff, new Set([key]))).toBe(false);
    expect(check('{')).toBe(false);
  });

  it('retains referenced and malformed wrappers, then removes eligible files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolling-prune-'));
    const dir = join(root, 'reconcile');
    await mkdir(dir);
    const path = join(dir, `${key}.json`);
    await writeFile(path, wrapper());
    await writeFile(join(dir, 'bad.json'), '{');
    expect(
      await pruneRollingWrappers(
        root,
        repo,
        queue({ merged_watermark: before, merged_discovery: { after, before } }),
        cutoff,
      ),
    ).toBe(0);
    expect(
      await pruneRollingWrappers(
        root,
        repo,
        queue({ merged_watermark: before, merged_reconcile: { checkpoint_key: key } }),
        cutoff,
      ),
    ).toBe(0);
    expect(
      await pruneRollingWrappers(root, repo, queue({ merged_watermark: before }), cutoff),
    ).toBe(1);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dir, 'bad.json'), 'utf8')).toBe('{');
  });
});
