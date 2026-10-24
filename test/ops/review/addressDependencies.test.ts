import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { assertAddressDependenciesIsolated } from '../../../src/ops/review/internal/addressDependencies.js';

test.each([
  'store',
  'cycle',
  'source',
  'transitive',
  'foreign',
  'file',
  'dangling',
  'root',
] as const)('dependency isolation inspection: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'cq-dependency-isolation-'));
  try {
    const worker = join(root, 'worker');
    const installed = join(worker, 'node_modules');
    const store = join(root, 'store');
    const source = join(worker, 'packages/lib');
    const foreign = join(root, 'foreign');
    for (const path of [installed, store, source, foreign]) await mkdir(path, { recursive: true });
    await mkdir(join(foreign, '.git'));
    await writeFile(join(source, 'index.js'), 'source bytes\n');
    await writeFile(join(store, 'index.js'), 'installed bytes\n');
    if (mode === 'transitive') await symlink(source, join(store, 'workspace'), 'dir');
    if (mode === 'cycle') await symlink(installed, join(store, 'cycle'), 'dir');
    const target =
      mode === 'source' || mode === 'root'
        ? source
        : mode === 'foreign'
          ? foreign
          : mode === 'file'
            ? join(source, 'index.js')
            : mode === 'dangling'
              ? join(root, 'missing')
              : store;
    await symlink(target, join(installed, 'package'));
    const inspected = assertAddressDependenciesIsolated(
      mode === 'root' ? source : installed,
      [worker],
      () => {},
    );
    if (mode === 'store' || mode === 'cycle') await expect(inspected).resolves.toBeUndefined();
    else
      await expect(inspected).rejects.toThrow(mode === 'dangling' ? /ENOENT/ : /checkout source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([1, 3])(
  'dependency traversal observes cancellation/budget at admission %i',
  async (at) => {
    const root = await mkdtemp(join(tmpdir(), 'cq-dependency-stop-'));
    try {
      const installed = join(root, 'node_modules');
      await mkdir(installed);
      await writeFile(join(installed, 'a.js'), 'installed\n');
      await writeFile(join(installed, 'b.js'), 'installed\n');
      let calls = 0;
      await expect(
        assertAddressDependenciesIsolated(installed, [root], () => {
          if (++calls === at) throw new Error('budget or cancellation');
        }),
      ).rejects.toThrow('budget or cancellation');
      expect(calls).toBe(at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
