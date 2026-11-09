import { constants } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
  terminalInput,
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

test.each([false, true])(
  'closed participant stays immutable; late receipt cannot be reclaimed: %s',
  async (late) => {
    const f = await fixture();
    const parent = new AbortController();
    const closed = deferred(),
      entered = deferred(),
      arrive = deferred(),
      release = deferred(),
      secondReady = deferred();
    const reports = [
      terminalReport(join(f.root, 'closed-terminal.json')),
      terminalReport(join(f.root, 'open-terminal.json')),
    ];
    reports[0]!.reasons.push('already returned before cancellation');
    let actual: Promise<unknown> | undefined;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        const result = await withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            if (index === 0) {
              if (late) {
                const binding = ownershipModule.addressTerminalWorkerBinding(lease);
                const attempt = await ownershipModule.recordAddressTerminalAttempt(
                  binding,
                  terminalInput(f.repo),
                );
                actual = lease.track(async () => {
                  entered.resolve();
                  await release.promise;
                  ownershipModule.deferAddressTerminalAttempt(binding, attempt);
                });
                void actual.catch(() => undefined);
                await entered.promise;
              }
              await writeFile(reports[0]!.reportPath, 'immutable closed participant report');
              return {
                status: 'needs-human' as const,
                reason: 'already closed',
                report: reports[0]!,
              };
            }
            secondReady.resolve();
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease);
          },
        );
        if (index === 0) closed.resolve();
        return result;
      });
    let pending: Promise<unknown> | undefined;
    try {
      const owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      pending = owner.withLock(async () => {
        const first = owner.address(
          {
            pr: 7,
            head: f.prs[0].headRefOid,
            headRepo: 'fixture/base',
            headRefName: 'closed-seven',
          },
          { repoRoot: f.repo.root, source: 'pr:7' },
        );
        void first.catch(() => undefined);
        await closed.promise;
        if (late) {
          await expect(first).rejects.toThrow('detached child work requires quarantine');
          await expect(
            owner.address(
              {
                pr: 9,
                head: f.prs[1].headRefOid,
                headRepo: 'fixture/base',
                headRefName: 'open-nine',
              },
              { repoRoot: f.repo.root, source: 'pr:9' },
            ),
          ).rejects.toThrow();
          throw new Error('detached child refused');
        }
        const second = owner.address(
          { pr: 9, head: f.prs[1].headRefOid, headRepo: 'fixture/base', headRefName: 'open-nine' },
          { repoRoot: f.repo.root, source: 'pr:9' },
        );
        const outcomes = Promise.allSettled([first, second]);
        await secondReady.promise;
        parent.abort();
        arrive.resolve();
        release.resolve();
        const rows = await outcomes;
        const rejected = rows.find((row) => row.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        return rows;
      });
      const outcome = await pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (late) {
        release.resolve();
        await actual;
      }
      expect(await readFile(reports[0]!.reportPath, 'utf8')).toBe(
        'immutable closed participant report',
      );
      expect(reports[0]!.reasons).toEqual(['already returned before cancellation']);
      if (late) {
        expect(outcome).toHaveProperty('error');
        await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('value');
        expect(
          (JSON.parse(await readFile(reports[1]!.reportPath, 'utf8')) as ReviewAddressReport)
            .reasons,
        ).toEqual(['parent cancelled']);
      }
    } finally {
      arrive.resolve();
      release.resolve();
      await Promise.allSettled([...(actual ? [actual] : []), ...(pending ? [pending] : [])]);
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);
test.each([
  'head',
  'index',
  'foreign-file',
  'path',
  'mode',
  'cancel-again',
  'restore-io',
  'cleanup-owner-loss',
] as const)(
  'terminal evidence guards preserve changed caller state or honest prior ref effects: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-identity-report.json'));
    const before = f.repo.git('rev-parse', 'HEAD').trim();
    let expectedHead = before;
    try {
      const pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW CANCELLED PARTIAL\n');
          if (mode === 'head') expectedHead = f.repo.commitAll('foreign head movement');
          if (mode === 'index') f.repo.git('add', '--', 'src/a.ts');
          if (mode === 'foreign-file')
            await writeFile(join(f.repo.root, 'README.md'), 'foreign bytes retained');
          if (mode === 'path') {
            await rename(join(f.repo.root, 'src/a.ts'), join(f.root, 'preserved-original-file'));
            await writeFile(join(f.repo.root, 'src/a.ts'), 'replacement bytes retained');
          }
          if (mode === 'mode') {
            const actual =
              await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            await actual.chmod(join(f.repo.root, 'src/a.ts'), 0o755);
          }
          if (mode === 'restore-io')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                throw new Error('terminal restore IO fault');
            };
          if (mode === 'cleanup-owner-loss')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                await damageGuard(
                  join(f.repo.root, '.git', 'cq-review-address-ownership.owner.json'),
                  'replace',
                );
            };
          if (mode === 'cancel-again')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                parent.abort();
            };
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      if (mode === 'cancel-again') {
        const result = await pending;
        expect(result.status).toBe('needs-human');
        expect(report.failed).toHaveLength(1);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      } else {
        await expect(pending).rejects.toThrow(/terminal|owner|authority/);
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          mode === 'path' ? 'replacement bytes retained' : 'RAW CANCELLED PARTIAL\n',
        );
        if (mode === 'restore-io' || mode === 'cleanup-owner-loss') {
          expect(report.failed).toHaveLength(1);
          expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
            'RAW CANCELLED PARTIAL\n',
          );
        } else expect(report.failed).toEqual([]);
      }
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(expectedHead);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'terminal-fixture/*')).toBe('');
    } finally {
      fsFaults.open = undefined;
      await f.repo.cleanup();
    }
  },
);

test('a drained terminal lifetime removes its private session directory', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const commonDir = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const before = new Set(await readdir(commonDir));
  const report = terminalReport(join(f.root, 'terminal-disposal-report.json'));
  try {
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW CANCELLED PARTIAL\n');
        parent.abort();
        expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    const created = (await readdir(commonDir)).filter((name) => !before.has(name));
    expect(created.filter((name) => name.startsWith('cq-address-terminal-'))).toEqual([]);
  } finally {
    await f.repo.cleanup();
  }
});

test('a vanished journal directory ends the terminal attempt without quarantine', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const reportDir = join(f.root, 'vanished-journal');
  const report = terminalReport(join(reportDir, 'terminal-report.json'));
  try {
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW CANCELLED PARTIAL\n');
        parent.abort();
        // The whole journal tree (whose missing tail bind deliberately did
        // not create) disappears before the terminal run: ordinary parent
        // cancellation timing, not evidence of tampering.
        await rm(reportDir, { recursive: true, force: true });
        expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
        const outcome = await ownershipModule.addressCancelledResult(lease);
        expect(outcome.status).toBe('needs-human');
        expect(outcome.report).toBe(report);
        return outcome;
      },
    );
    expect(result.status).toBe('needs-human');
    // A fresh lifetime admits immediately: no attended recovery is required.
    const probe = await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => 'admitted',
    );
    expect(probe).toBe('admitted');
  } finally {
    await f.repo.cleanup();
  }
});
