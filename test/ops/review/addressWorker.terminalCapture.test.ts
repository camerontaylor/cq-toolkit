import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressOwnership from '../../../src/ops/review/internal/addressRunLifecycle.js';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { makeAddressWorker } from '../../../src/ops/review/addressWorker.js';
import { finding, fixture } from './addressWorker.helpers.js';

test('a structural terminal binding never dispatches a driver or edits a file', async () => {
  const f = await fixture(undefined, '', { terminalBinding: Object.freeze({ terminal: true }) });
  try {
    const result = await f.engine.fix(finding(), 1);
    expect(result.reason).toContain('forged worker association');
    expect(f.attempts).toEqual([]);
    expect(f.calls()).toBe(0);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    await f.cleanup();
  }
});

test.each(['commit', 'restore'] as const)(
  'worker releases its terminal capture after %s',
  async (transition) => {
    const f = await fixture(
      undefined,
      '',
      transition === 'restore' ? { firstStopReason: 'error' } : {},
    );
    const originalRelease = addressOwnership.releaseAddressTerminalAttempt;
    const release = vi
      .spyOn(addressOwnership, 'releaseAddressTerminalAttempt')
      .mockImplementation((binding, attempt) => {
        // Refund only once the source is clean and its normal outcome has settled.
        expect(f.repo.git('diff', '--name-only')).toBe('');
        const head = f.repo.git('rev-parse', 'HEAD').trim();
        if (transition === 'commit') expect(head).not.toBe(f.initial);
        else expect(head).toBe(f.initial);
        originalRelease(binding, attempt);
      });
    try {
      await withAddressOwnership(
        { repoRoot: f.repo.root, git: f.engineDeps.git, source: 'local', production: false },
        async (lease) => {
          const binding = addressOwnership.addressTerminalWorkerBinding(lease);
          // Initialize the authenticated session before baseline candidate cleanup.
          await addressOwnership.checkpointAddressTerminalWorker(binding, f.repo.root, f.initial);
          const engine = makeAddressWorker({ ...f.engineDeps, terminalBinding: binding });
          const result = await engine.fix(finding(), 1);
          if (transition === 'commit') {
            expect(result.commit, result.reason).toBeTruthy();
            expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('GOOD\n');
          } else {
            expect(result.commit).toBeUndefined();
            expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
          }
          expect(release).toHaveBeenCalledTimes(1);
          expect(release.mock.calls[0]![0]).toBe(binding);
          expect(() =>
            addressOwnership.releaseAddressTerminalAttempt(binding, release.mock.calls[0]![1]),
          ).toThrow('stale');
        },
      );
    } finally {
      release.mockRestore();
      await f.cleanup();
    }
  },
);

test.each(['rejected', 'deferred'] as const)(
  'terminal captures recycle across 65 sequential %s outcomes',
  async (disposition) => {
    const f = await fixture(
      async (input) =>
        input.outputSchema?.name === 'review.address.closure/v1'
          ? { closed: true, reason: 'false positive confirmed' }
          : { disposition, reason: 'no edit needed', evidence: [{ path: 'src/a.ts', line: 1 }] },
      '',
      {
        configure: (config) => {
          config.budgets = { ...config.budgets, run: { wallMs: 600_000, maxTokens: 100_000 } };
          config.checks[0]!.addressOnly = true;
        },
      },
    );
    try {
      await withAddressOwnership(
        { repoRoot: f.repo.root, git: f.engineDeps.git, source: 'local', production: false },
        async (lease) => {
          const binding = addressOwnership.addressTerminalWorkerBinding(lease);
          await addressOwnership.checkpointAddressTerminalWorker(binding, f.repo.root, f.initial);
          const engine = makeAddressWorker({ ...f.engineDeps, terminalBinding: binding });
          for (let index = 0; index < 65; index++) {
            const result = await engine.fix(finding(), 1);
            expect(result.finding.status, result.reason).toBe(disposition);
            expect(result.reason).toBe('no edit needed');
          }
          expect(f.calls()).toBe(disposition === 'rejected' ? 130 : 65);
          expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        },
      );
    } finally {
      await f.cleanup();
    }
  },
  180_000,
);

test('a capture release failure after commit does not restore, retain or retry', async () => {
  const f = await fixture(undefined, '', { workerAttempts: 2, rescueBase: 1 });
  const release = vi
    .spyOn(addressOwnership, 'releaseAddressTerminalAttempt')
    .mockImplementation(() => {
      throw new Error('synthetic release failure');
    });
  try {
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.engineDeps.git, source: 'local', production: false },
      async (lease) => {
        const binding = addressOwnership.addressTerminalWorkerBinding(lease);
        await addressOwnership.checkpointAddressTerminalWorker(binding, f.repo.root, f.initial);
        const engine = makeAddressWorker({ ...f.engineDeps, terminalBinding: binding });
        const result = await engine.fix(finding(), 1);
        expect(result.reason).toContain('synthetic release failure');
        // The commit landed and was verified: it is reported, not hidden behind
        // a deferred row whose retry would re-dispatch committed work.
        expect(result.finding.status, result.reason).toBe('fixed');
        expect(result.commit).toBeTruthy();
        expect(f.attempts.filter((row) => row.invocation === 'edit')).toHaveLength(1);
        expect(result.failedAttempts).toEqual([]);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).not.toBe(f.initial);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('GOOD\n');
        expect(
          f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/failed/'),
        ).toBe('');
        expect(release).toHaveBeenCalledTimes(1);
      },
    );
  } finally {
    release.mockRestore();
    await f.cleanup();
  }
});
