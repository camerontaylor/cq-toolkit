import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import {
  addressFailureFeedback,
  pinAddressFailure,
  type AddressFailedAttempt,
} from '../../../src/ops/review/internal/addressEvidence.js';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import * as ownershipModule from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { makeTestRepo } from '../dev/repo.js';
import { fixture, terminalInput, terminalReport } from './addressManyWorktree.helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('review.address immutable failure feedback guards', () => {
  test.each(['parent', 'unowned', 'binary', 'replacement', 'size', 'provenance', 'patch'] as const)(
    '%s refusal prevents untrusted or unscannable feedback',
    async (mode) => {
      const repo = await makeTestRepo();
      repo.git('config', 'user.name', 'Test');
      repo.git('config', 'user.email', 'test@example.invalid');
      const run = makeGhRunner({ bin: 'git', cwd: repo.root });
      const git = async (args: string[]) => {
        const result = await run(args);
        if (result.code !== 0) throw new Error(result.stderr);
        return args.includes('-z') || args[0] === 'show' || args[0] === 'diff'
          ? result.stdout
          : result.stdout.trim();
      };
      try {
        const parent = await git(['rev-parse', 'HEAD']);
        await repo.write(
          'src/a.ts',
          mode === 'binary' ? 'PARTIAL\0' : mode === 'replacement' ? 'PARTIAL\uFFFD' : 'PARTIAL\n',
        );
        if (mode === 'unowned') await repo.write('src/b.ts', 'SIBLING\n');
        repo.git('add', '--', 'src/a.ts', ...(mode === 'unowned' ? ['src/b.ts'] : []));
        const pinned = await pinAddressFailure(git, {
          runPrefix: 'cq-address/guards',
          kind: 'review',
          slug: 'fixture',
          task: 'owned',
          parent,
          firstAttempt: 1,
          tier: 'worker',
          model: { provider: 'mock', model: 'worker' },
          gate: 'none',
          outcome: 'unfixed',
          reason: 'provider failed',
          pushFailed: false,
        });
        const prior: AddressFailedAttempt = {
          ...pinned,
          finding: 'owned',
          unit: 'review/fixture',
          file: 'src/a.ts',
          parent: mode === 'parent' ? repo.git('rev-parse', 'HEAD^').trim() : parent,
          executionHead: parent,
          ordinal: 1,
          tier: 'worker',
          gate: 'none',
          reason: 'provider failed',
          model: { provider: 'mock', model: 'worker' },
          outcome: 'unfixed',
        };
        let servedOversizedFile = false;
        await expect(
          addressFailureFeedback(async (args) => {
            if (mode === 'size' && args[0] === 'cat-file') return String(4 * 1024 * 1024 + 1);
            if (mode === 'size' && args[0] === 'show') servedOversizedFile = true;
            if (mode === 'provenance' && args[0] === 'show' && args[1] === '-s')
              return 'x'.repeat(4 * 1024 * 1024 + 1);
            if (mode === 'patch' && args.includes('--binary'))
              return 'x'.repeat(32 * 1024 * 1024 + 1);
            return git(args);
          }, prior),
        ).rejects.toThrow(
          mode === 'parent'
            ? /parentage/
            : mode === 'unowned'
              ? /unowned/
              : mode === 'binary' || mode === 'replacement'
                ? /scannable/
                : /cap/,
        );
        expect(servedOversizedFile).toBe(false);
        expect(await git(['rev-parse', pinned.branch])).toBe(pinned.sha);
        expect(await git(['rev-parse', 'HEAD'])).toBe(parent);
      } finally {
        await repo.cleanup();
      }
    },
  );
});

describe('terminal settle authority rejection after a created ref', () => {
  test('a settle ref created just before the authority check rejects is still reported and the source stays intact', async () => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'authority-after-ref.json'));
    try {
      // Real seam: the lifecycle's own identity check, faulted once the settle ref exists.
      const proto = ownershipModule.AddressCheckoutOwnership.prototype as unknown as {
        assertIdentity(): Promise<void>;
      };
      const original = proto.assertIdentity;
      let faulted = false;
      vi.spyOn(proto, 'assertIdentity').mockImplementation(async function (this: unknown) {
        await original.call(this);
        // Authority stays expired from the moment the settle ref exists.
        if (
          faulted ||
          f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/').includes('/a1')
        ) {
          faulted = true;
          throw new Error('injected authority fault');
        }
      });
      await withAddressOwnership(
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
          await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
          parent.abort();
          ownershipModule.deferAddressTerminalAttempt(binding, attempt);
          return ownershipModule.addressCancelledResult(lease);
        },
      ).catch(() => undefined);
      expect(faulted).toBe(true);
      expect(report.failed).toHaveLength(1);
      expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
      // The authority check precedes every restoration write, so none ran.
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('CANCELLED OWN FILE\n');
    } finally {
      await f.repo.cleanup();
    }
  });
});
