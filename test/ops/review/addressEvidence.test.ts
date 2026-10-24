import { describe, expect, test } from 'vitest';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import {
  addressFailureFeedback,
  pinAddressFailure,
  type AddressFailedAttempt,
} from '../../../src/ops/review/internal/addressEvidence.js';
import { makeTestRepo } from '../dev/repo.js';

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
