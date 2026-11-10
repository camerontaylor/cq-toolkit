import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  withAddressOwnership,
  addressCancelledResult,
  bindAddressTerminalReport,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { deferred, fixture, terminalReport } from './addressManyWorktree.helpers.js';

test('cancellation waits for actual writer before returning', async () => {
  const f = await fixture();
  const started = deferred(),
    release = deferred();
  const controller = new AbortController();
  const path = join(f.root, 'writer-finished');
  let settled = false;
  const pending = withAddressOwnership(
    {
      repoRoot: f.repo.root,
      git: f.run,
      source: 'local',
      production: false,
      signal: controller.signal,
    },
    async (lease) => {
      await bindAddressTerminalReport(lease, terminalReport(join(f.root, 'report.json')));
      const writer = lease.track(async () => {
        started.resolve();
        await release.promise;
        await writeFile(path, 'drained');
      });
      await started.promise;
      controller.abort();
      await writer;
      return addressCancelledResult(lease);
    },
  );
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  try {
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await pending;
    expect(await readFile(path, 'utf8')).toBe('drained');
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await f.repo.cleanup();
  }
});
