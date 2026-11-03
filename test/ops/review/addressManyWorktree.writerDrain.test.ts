import { constants } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import {
  makeAddressOwnership,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';

import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import * as ownershipModule from '../../../src/ops/review/internal/addressOwnership.js';

import {
  authorityState,
  damageGuard,
  deferred,
  fixture,
  terminalReport,
} from './addressManyWorktree.helpers.js';

// Filesystem fault gates are test-only. Every unaffected operation is real.
const fsFaults = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void),
  link: undefined as
    | undefined
    | ((phase: 'before' | 'after', source: string, destination: string) => Promise<void>),
  open: undefined as
    | undefined
    | ((path: string, flags: string | number | undefined) => Promise<void>),
  sync: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      fsFaults.effect?.();
      return actual.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.effect?.();
      return actual.writeFile(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      fsFaults.effect?.();
      await fsFaults.link?.('before', String(args[0]), String(args[1]));
      await actual.link(...args);
      await fsFaults.link?.('after', String(args[0]), String(args[1]));
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      fsFaults.effect?.();
      await fsFaults.open?.(String(args[0]), args[1]);
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        fsFaults.effect?.();
        await fsFaults.sync?.(String(args[0]));
        await sync();
      };
      return file;
    },
  };
});

test.each(['success', 'report-failure', 'owner-loss', 'alias', 'alias-caught', 'opaque'] as const)(
  'cancelled bulk participants drain every actual writer before shared reports: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const started = [deferred(), deferred()],
      arrive = deferred(),
      releaseWriter = deferred(),
      aliasDetected = deferred(),
      firstWriterReady = deferred();
    const alias = mode === 'alias' || mode === 'alias-caught';
    const writers: Promise<unknown>[] = [];
    const reports = [
      terminalReport(join(f.root, 'terminal-seven.json')),
      terminalReport(join(f.root, 'terminal-nine.json')),
    ];
    if (alias) reports[1]!.reportPath = reports[0]!.reportPath;
    let owner: Awaited<ReturnType<typeof makeAddressOwnership>>;
    let reportWrites = 0;
    let terminalReturns = 0;
    const reportOrder: string[] = [];
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        if (index === 1 && (mode === 'report-failure' || alias)) await firstWriterReady.promise;
        return withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            try {
              await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            } catch (error) {
              aliasDetected.resolve();
              if (mode === 'alias-caught')
                return { status: 'needs-human' as const, reason: 'caught alias fixture' };
              throw error;
            }
            writers.push(
              lease.track(async () => {
                if (mode === 'opaque' && index === 0)
                  ownershipModule.noteAddressOpaqueInvocation(lease);
                started[index]!.resolve();
                if (index === 0) firstWriterReady.resolve();
                try {
                  await releaseWriter.promise;
                } finally {
                  await writeFile(
                    join(f.root, `actual-finally-${index}`),
                    'writer finally settled',
                  );
                }
              }),
            );
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease).finally(() => {
              terminalReturns++;
            });
          },
        );
      });
    let pending: Promise<unknown> | undefined;
    try {
      owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      fsFaults.open = async (path, flags) => {
        if (
          (path === reports[0]!.reportPath || path === reports[1]!.reportPath) &&
          typeof flags === 'number' &&
          flags & constants.O_CREAT
        ) {
          reportWrites++;
          reportOrder.push(path);
          if (mode === 'report-failure' && path === reports[1]!.reportPath)
            throw new Error('terminal report persistence fault');
        }
      };
      pending = owner.withLock(async () => {
        const children = [7, 9].map((pr, index) =>
          owner.address(
            {
              pr,
              head: f.prs[index]!.headRefOid,
              headRepo: 'fixture/base',
              headRefName: `fixture-distinct-${pr}`,
            },
            { repoRoot: f.repo.root, source: `pr:${pr}` },
          ),
        );
        // Observe rejection immediately; alias refusal can precede cancellation.
        const outcomes = Promise.allSettled(children);
        if (alias) {
          await aliasDetected.promise;
          parent.abort();
          arrive.resolve();
          return outcomes.then((rows) => {
            if (mode === 'alias-caught') return;
            if (rows.some((row) => row.status === 'rejected'))
              throw new Error('terminal report target alias');
          });
        }
        await Promise.all(started.map((entry) => entry.promise));
        parent.abort();
        arrive.resolve();
        return Promise.all(children);
      });
      const observed = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (alias) await aliasDetected.promise;
      else await Promise.all(started.map((entry) => entry.promise));
      await arrive.promise;
      // Child control arrivals alone cannot settle an actual writer/finally.
      expect(reportWrites).toBe(0);
      expect(terminalReturns).toBe(0);
      await expect(lstat(reports[0]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await authorityState(owner.guardPath)).state).toBe('active');
      if (mode === 'owner-loss') await damageGuard(owner.guardPath, 'replace');
      releaseWriter.resolve();
      const outcome = await observed;
      await Promise.allSettled(writers);
      expect(await readFile(join(f.root, 'actual-finally-0'), 'utf8')).toContain('settled');
      if (mode === 'success') {
        expect(outcome).toHaveProperty('value');
        for (let index = 0; index < 2; index++) {
          expect(await readFile(join(f.root, `actual-finally-${index}`), 'utf8')).toContain(
            'settled',
          );
          const report = JSON.parse(
            await readFile(reports[index]!.reportPath, 'utf8'),
          ) as ReviewAddressReport;
          expect(report.reasons).toEqual(['parent cancelled']);
          expect(report.failed).toEqual([]);
        }
        expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('error');
        if (mode === 'report-failure') {
          if ('error' in outcome)
            expect(String(outcome.error)).toContain('terminal report persistence fault');
          expect(reportOrder).toEqual(reports.map((report) => report.reportPath));
          expect(
            (JSON.parse(await readFile(reports[0]!.reportPath, 'utf8')) as ReviewAddressReport)
              .reasons,
          ).toEqual(['parent cancelled']);
          await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
        } else {
          expect(reportWrites).toBe(0);
          expect(reportOrder).toEqual([]);
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
          if (alias && 'error' in outcome) expect(String(outcome.error)).toContain('alias');
        }
      }
    } finally {
      releaseWriter.resolve();
      arrive.resolve();
      firstWriterReady.resolve();
      await Promise.allSettled([...writers, ...(pending ? [pending] : [])]);
      fsFaults.open = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);
test('pending actual writer exceeds drain bound without terminal IO and late settle cannot reopen authority', async () => {
  const f = await fixture();
  const parent = new AbortController(),
    release = deferred(),
    entered = deferred();
  const report = terminalReport(join(f.root, 'pending-terminal-report.json'));
  let writer: Promise<unknown> | undefined,
    elapsed = 0;
  const actualNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + elapsed);
  try {
    await expect(
      withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          writer = lease.track(async () => {
            entered.resolve();
            await release.promise;
            await writeFile(join(f.root, 'late-finally'), 'settled');
          });
          await entered.promise;
          parent.abort();
          const cancelled = ownershipModule.addressCancelledResult(lease);
          elapsed = 60_001;
          return cancelled;
        },
      ),
    ).rejects.toThrow('actual writers/control arrivals unresolved');
    await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    release.resolve();
    await writer;
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    release.resolve();
    await writer;
    clock.mockRestore();
    await f.repo.cleanup();
  }
});
