import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

import * as ownershipModule from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

import { fixture, terminalInput, terminalReport } from './addressManyWorktree.helpers.js';

test('terminal binding rejects structural, replayed and retired capabilities without dispatch', async () => {
  const f = await fixture();
  let binding: object | undefined, attempt: object | undefined;
  try {
    expect(() => ownershipModule.recordAddressTerminalAttempt({}, terminalInput(f.repo))).toThrow(
      'forged worker',
    );
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async (lease) => {
        binding = ownershipModule.addressTerminalWorkerBinding(lease);
        attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        expect(() => ownershipModule.deferAddressTerminalAttempt({}, attempt!)).toThrow(
          'forged worker',
        );
        expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(false);
      },
    );
    expect(() => ownershipModule.releaseAddressTerminalAttempt(binding!, attempt!)).toThrow(
      'after close',
    );
    await expect(
      ownershipModule.recordAddressTerminalAttempt(binding!, terminalInput(f.repo)),
    ).rejects.toThrow('after close');
    expect(() =>
      ownershipModule.addressTerminalWorkerBinding(
        {} as Parameters<typeof ownershipModule.addressTerminalWorkerBinding>[0],
      ),
    ).toThrow('forged worker lease');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    await f.repo.cleanup();
  }
});
test.each([false, true])(
  'terminal reservations recycle sequential captures (large=%s)',
  async (large) => {
    const f = await fixture();
    try {
      if (large) {
        await f.repo.write('src/a.ts', Buffer.alloc(4 * 1024 * 1024, 65));
        f.repo.commitAll('large baseline');
      }
      await withAddressOwnership(
        { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
        async (lease) => {
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          for (let index = 0; index < (large ? 9 : 65); index++) {
            // Failure after reserving bytes must return both reservations.
            await expect(
              ownershipModule.recordAddressTerminalAttempt(binding, {
                ...terminalInput(f.repo),
                parent: '0'.repeat(40),
              }),
            ).rejects.toThrow('HEAD changed');
            const attempt = await ownershipModule.recordAddressTerminalAttempt(
              binding,
              terminalInput(f.repo),
            );
            expect(() => ownershipModule.releaseAddressTerminalAttempt({}, attempt)).toThrow(
              'forged worker',
            );
            ownershipModule.releaseAddressTerminalAttempt(binding, attempt);
            expect(() => ownershipModule.releaseAddressTerminalAttempt(binding, attempt)).toThrow(
              'stale',
            );
          }
        },
      );
    } finally {
      await f.repo.cleanup();
    }
  },
  120_000,
);
test.each(['snapshot', 'total', 'receipts', 'report'] as const)(
  'terminal bounds refuse before retaining excess evidence or writing a report: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-bound-report.json'));
    try {
      if (mode === 'snapshot' || mode === 'total') {
        await f.repo.write(
          'src/a.ts',
          Buffer.alloc(4 * 1024 * 1024 + (mode === 'snapshot' ? 1 : 0), 65),
        );
        f.repo.commitAll('bounded raw baseline');
      }
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
            const binding = ownershipModule.addressTerminalWorkerBinding(lease);
            if (mode === 'report') {
              report.reasons.push('x'.repeat(16 * 1024 * 1024 + 1));
              parent.abort();
              return ownershipModule.addressCancelledResult(lease);
            }
            const count = mode === 'receipts' ? 65 : mode === 'total' ? 9 : 1;
            for (let index = 0; index < count; index++)
              await ownershipModule.recordAddressTerminalAttempt(binding, terminalInput(f.repo));
            throw new Error('bound failed to refuse');
          },
        ),
      ).rejects.toThrow(/bound/);
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    } finally {
      await f.repo.cleanup();
    }
  },
);
