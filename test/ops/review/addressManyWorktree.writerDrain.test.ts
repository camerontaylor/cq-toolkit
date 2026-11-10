import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  withAddressOwnership,
  addressCancelledResult,
  bindAddressTerminalReport,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { deferred, fixture, terminalReport } from './addressManyWorktree.helpers.js';

// The old shared-child harness fabricated participants of one common-dir owner.
// Real bulk exclusion and cancellation evidence now run through addressMany.slotOwnership
// and addressCheckoutRecovery; this file pins actual-writer drain at the new owner.

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

test('drain timeout retains incomplete ownership after the late writer closes', async () => {
  const f = await fixture();
  const controller = new AbortController(),
    release = deferred(),
    entered = deferred();
  const report = terminalReport(join(f.root, 'pending-terminal-report.json'));
  let writer: Promise<unknown> | undefined;
  let elapsed = 0;
  const now = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
  const opts = { repoRoot: f.repo.root, git: f.run, source: 'local', production: false };
  try {
    await expect(
      withAddressOwnership({ ...opts, signal: controller.signal }, async (lease) => {
        await bindAddressTerminalReport(lease, report);
        writer = lease.track(async () => {
          entered.resolve();
          await release.promise;
          await writeFile(join(f.root, 'late-finally'), 'settled');
        });
        await entered.promise;
        controller.abort();
        const cancelled = addressCancelledResult(lease);
        elapsed = 60_001;
        return cancelled;
      }),
    ).rejects.toThrow(/actual writers\/control arrivals unresolved/);
    await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withAddressOwnership(opts, async () => undefined)).rejects.toThrow(
      /busy|incomplete/i,
    );
    release.resolve();
    await writer;
    await expect(withAddressOwnership(opts, async () => undefined)).rejects.toThrow(
      /busy|incomplete/i,
    );
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    release.resolve();
    await writer;
    clock.mockRestore();
    await f.repo.cleanup();
  }
});
