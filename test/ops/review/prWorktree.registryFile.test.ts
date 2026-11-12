import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readLegacyReviewHint } from '../../../src/adapters/git/legacyReviewRegistry.js';

test('legacy map is read-only and ignores unrelated malformed entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-legacy-'));
  const source = join(dir, 'worktrees.json');
  const bytes = JSON.stringify({
    7: { path: join(dir, 'checkout'), branch: 'cq-review/pr-7' },
    8: null,
  });
  await writeFile(source, bytes);
  expect(await readLegacyReviewHint([source], 7)).toEqual({
    path: join(dir, 'checkout'),
    branch: 'cq-review/pr-7',
  });
  expect(await readLegacyReviewHint([source], 9)).toBeUndefined();
  expect(await readFile(source, 'utf8')).toBe(bytes);
});

test('conflicting requested hints and corrupt files refuse with paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-legacy-'));
  const first = join(dir, 'first.json'),
    second = join(dir, 'second.json');
  await writeFile(first, JSON.stringify({ 7: { path: join(dir, 'a'), branch: 'cq-review/pr-7' } }));
  await writeFile(
    second,
    JSON.stringify({ 7: { path: join(dir, 'b'), branch: 'cq-review/pr-7' } }),
  );
  await expect(readLegacyReviewHint([first, second], 7)).rejects.toThrow(second);
  await writeFile(second, '{');
  await expect(readLegacyReviewHint([first, second], 7)).rejects.toThrow(second);
  expect(await readFile(second, 'utf8')).toBe('{');
});
