import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeRepoDiffScanner, type DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address failed-attempt branches', () => {
  test('SHA256 failure branches are ordinary single-parent commits with create-only identity', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'SHA256 PARTIAL\n');
        throw new Error('partial failure');
      },
      '',
      { objectFormat: 'sha256' },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      const retained = result.failedAttempts![0]!;
      expect(retained.sha).toMatch(/^[a-f0-9]{64}$/);
      expect(f.repo.git('rev-parse', retained.branch).trim()).toBe(retained.sha);
      expect(f.repo.git('rev-list', '--parents', '-n', '1', retained.sha).trim()).toBe(
        `${retained.sha} ${f.initial}`,
      );
      expect(f.repo.git('show', `${retained.branch}:src/a.ts`)).toBe('SHA256 PARTIAL\n');
    } finally {
      await f.cleanup();
    }
  });
  test('collision exhaustion is bounded and preserves unarchived owned bytes', async () => {
    let collisions = 0;
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'UNCAPTURED\n');
        throw new Error('failure');
      },
      '',
      {
        gitHook: async (args, run) => {
          if (args.includes('update-ref') && args.some((arg) => arg.includes('/failed/'))) {
            collisions++;
            return { code: 1, stdout: '', stderr: 'reference already exists' };
          }
          if (
            args.includes('rev-parse') &&
            args.some((arg) => arg.startsWith('refs/heads/cq-address/'))
          )
            return run(['rev-parse', 'HEAD']);
          return run(args);
        },
      },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status).toBe('deferred');
      expect(result.reason).toContain('collision limit');
      expect(collisions).toBe(32);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('UNCAPTURED\n');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
    } finally {
      await f.cleanup();
    }
  });

  test('failed capture owns only its assigned file while a concurrent sibling remains dirty', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(async (input) => {
      const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
      if (file === 'src/b.ts') {
        await writeFile(join(input.workspace!.path, file), 'SIBLING DIRTY\n');
        entered();
        await gate;
        throw new Error('sibling failed');
      }
      await writeFile(join(input.workspace!.path, file), 'OWNED PARTIAL\n');
      throw new Error('owned failed');
    });
    let sibling: ReturnType<typeof f.engine.fix> | undefined;
    try {
      sibling = f.engine.fix(finding('src/b.ts'), 1);
      await held;
      const failed = await f.engine.fix(finding(), 1);
      const retained = failed.failedAttempts![0]!;
      expect(retained.executionHead).toBe(f.initial);
      expect(retained.parent).toBe(f.initial);
      expect(retained.tier).toBe('worker');
      expect(f.repo.git('rev-parse', retained.branch).trim()).toBe(retained.sha);
      expect(f.repo.git('rev-list', '--parents', '-n', '1', retained.sha).trim()).toBe(
        `${retained.sha} ${f.initial}`,
      );
      expect(f.repo.git('diff', '--name-only', retained.parent, retained.sha).trim()).toBe(
        'src/a.ts',
      );
      expect(f.repo.git('show', `${retained.sha}:src/a.ts`)).toBe('OWNED PARTIAL\n');
      expect(f.repo.git('show', `${retained.sha}:src/b.ts`)).toBe('BAD\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('SIBLING DIRTY\n');
      expect(f.repo.git('show', '-s', '--format=%an <%ae>%n%B', retained.sha)).toContain(
        'CQ fix engine <cq-fix-engine@invalid>',
      );
      expect(f.repo.git('show', '-s', '--format=%B', retained.sha)).toContain('Cq-Tier: worker');
      const evidence = failed.finding.evidence;
      if (typeof evidence !== 'string') throw new Error('expected legacy evidence text');
      expect(JSON.parse(evidence)).toEqual(retained);
      expect(f.attempts[1]!.failedAttempt).toEqual(retained);
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/stash', 'refs/cq')).toBe('');
      release();
      const other = await sibling;
      expect(other.failedAttempts![0]!.sha).not.toBe(retained.sha);
      expect(
        f.repo
          .git(
            'diff',
            '--name-only',
            other.failedAttempts![0]!.parent,
            other.failedAttempts![0]!.sha,
          )
          .trim(),
      ).toBe('src/b.ts');
    } finally {
      release();
      await sibling;
      await f.cleanup();
    }
  });
  test('collisions preserve existing branches and worker/rescue history continues ordinals', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(
          join(input.workspace!.path, 'src/a.ts'),
          `${input.modelSpec.model} PARTIAL\n`,
        );
        throw new Error('provider failed');
      },
      '',
      { workerAttempts: 2, rescueBase: 1, runPrefix: 'cq-address/collision' },
    );
    try {
      const digest = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16);
      const collision = `cq-address/collision/failed/review-${digest('review')}/fixture-${digest('fixture')}/src-a-ts-${digest('src/a.ts')}/a1`;
      const identity = Buffer.from(JSON.stringify(['review', 'fixture', 'src/a.ts'])).toString(
        'base64url',
      );
      const collisionSha = f.repo
        .git(
          'commit-tree',
          f.repo.git('write-tree').trim(),
          '-p',
          f.initial,
          '-m',
          `cq-failed(unfixed): src/a.ts\n\nprovider failed\n\nCq-Run: cq-address/collision\nCq-Unit: review/fixture\nCq-Task: src/a.ts\nCq-Ref-Identity: ${identity}\nCq-Attempt: 1\nCq-Tier: worker\nCq-Model: mock/worker\nCq-Gate: related\nCq-Outcome: unfixed`,
        )
        .trim();
      f.repo.git('update-ref', `refs/heads/${collision}`, collisionSha);
      const failed = await f.engine.fix(finding(), 1);
      expect(failed.failedAttempts?.map((row) => [row.ordinal, row.tier])).toEqual([
        [2, 'worker'],
        [3, 'worker'],
        [4, 'rescue'],
      ]);
      expect(f.repo.git('rev-parse', collision).trim()).toBe(collisionSha);
      for (const row of failed.failedAttempts!) {
        expect(f.repo.git('rev-parse', row.branch).trim()).toBe(row.sha);
        expect(f.repo.git('show', '-s', '--format=%B', row.sha)).toContain(
          `Cq-Attempt: ${row.ordinal}`,
        );
        expect(f.repo.git('rev-parse', `${row.sha}^`).trim()).toBe(f.initial);
      }
      expect(f.attempts.map((row) => row.failedAttempt?.sha)).toEqual(
        failed.failedAttempts!.map((row) => row.sha),
      );
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['clean', 'tainted'] as const)(
    '%s immutable leaf whitespace reaches the configured path policy before rescue',
    async (mode) => {
      const leaf = mode === 'tainted' ? ' PRIVATE\n' : ' PUBLIC\n';
      const scans: Array<Array<{ text: string; path?: string }>> = [];
      let configured: DiffSecretScanner;
      let rescueCalls = 0;
      const f = await fixture(
        async (input) => {
          if (input.modelSpec.model === 'worker') {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), leaf);
            throw new Error('retain whitespace');
          }
          rescueCalls++;
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'rescued' };
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          return { disposition: 'fixed', reason: 'rescued', evidence: [] };
        },
        '',
        {
          rescueBase: 1,
          providerRequest: true,
          configure: (config) => {
            config.review!.denylistPatternsFile = 'patterns.yml';
          },
          scanner: async (components) => {
            if (components.some((part) => part.path === '.git/cq-failed-commit-message'))
              scans.push([...components]);
            return configured(components);
          },
        },
      );
      try {
        await f.repo.write(
          'patterns.yml',
          "rules:\n  - id: private-leaf\n    description: anchored whitespace\n    regex: '^ PRIVATE'\n    path: '^src/a\\.ts$'\n    sample: ' PRIVATE'\nclean_probes:\n  - ' PUBLIC'\n",
        );
        f.repo.commitAll('configured leaf policy');
        configured = makeRepoDiffScanner(f.repo.root, 'patterns.yml');
        const result = await f.engine.fix(finding(), 1);
        expect(result.finding.status, result.reason).toBe(
          mode === 'tainted' ? 'deferred' : 'fixed',
        );
        expect(rescueCalls).toBe(mode === 'tainted' ? 0 : 3);
        expect(scans).toHaveLength(mode === 'tainted' ? 1 : 4);
        for (const scan of scans) {
          expect(
            scan
              .filter((part) => part.path === 'src/a.ts')
              .slice(-2)
              .map((part) => part.text),
          ).toEqual(['BAD\n', leaf]);
        }
        expect(f.repo.git('show', `${result.failedAttempts![0]!.sha}:src/a.ts`)).toBe(leaf);
        if (mode === 'tainted') expect(result.reason).toMatch(/upload/);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each(['clean', 'positive', 'feedback-positive', 'missing', 'fault'] as const)(
    '%s immutable feedback is scanned before rescue edit and feedback',
    async (mode) => {
      const scans: Array<Array<{ text: string; path?: string }>> = [];
      const prompts: string[] = [];
      const f = await fixture(
        async (input) => {
          if (input.modelSpec.model === 'worker') {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'RETAINED PARTIAL\n');
            throw new Error('worker failure provenance');
          }
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'rescued' };
          prompts.push(input.prompt);
          if (!input.prompt.startsWith('related-check feedback')) {
            expect(await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8')).toBe('BAD\n');
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          }
          return { disposition: 'fixed', reason: 'rescued', evidence: [] };
        },
        '',
        {
          rescueBase: 1,
          providerRequest: true,
          scanner: async (components) => {
            if (components.some((part) => part.text.includes('Cq-Tier: worker'))) {
              scans.push([...components]);
              if (mode === 'fault') throw new Error('feedback scanner unavailable');
              if (mode === 'missing') return [];
              if (
                mode === 'positive' ||
                (mode === 'feedback-positive' &&
                  components[0]!.text.startsWith('related-check feedback'))
              )
                return components.map((part) => ({
                  component: part.component,
                  hits: [{ ruleId: 'tainted', lines: [1] }],
                }));
            }
            return components.map((part) => ({ component: part.component, hits: [] }));
          },
        },
      );
      try {
        const result = await f.engine.fix(finding(), 1);
        expect(result.failedAttempts!.length).toBeGreaterThan(0);
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(scan.some((part) => part.text === 'BAD\n')).toBe(true);
          expect(scan.some((part) => part.text === 'RETAINED PARTIAL\n')).toBe(true);
          expect(
            scan.some(
              (part) =>
                part.path === '.git/cq-failed-commit-message' &&
                part.text.includes('worker failure provenance'),
            ),
          ).toBe(true);
        }
        if (mode === 'clean') {
          expect(result.finding.status, result.reason).toBe('fixed');
          expect(prompts).toHaveLength(2);
          expect(prompts.every((prompt) => prompt.includes('+RETAINED PARTIAL'))).toBe(true);
          // Both invocation-boundary scans and provider-boundary scans include immutable contents.
          expect(scans).toHaveLength(4);
        } else {
          expect(result.finding.status).toBe('deferred');
          expect(prompts).toHaveLength(mode === 'feedback-positive' ? 1 : 0);
          expect(f.calls()).toBe(mode === 'feedback-positive' ? 2 : 1);
          expect(result.reason).toMatch(/upload/);
          expect(result.failedAttempts).toHaveLength(mode === 'feedback-positive' ? 2 : 1);
          expect(
            f.attempts
              .filter((row) => row.invocation === 'edit')
              .map((row) => row.failedAttempt?.sha),
          ).toEqual(result.failedAttempts!.map((row) => row.sha));
        }
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a failed sibling uses the verified parent but retains its earlier dispatch head', async () => {
    let bothEdited!: () => void, releaseFailure!: () => void;
    let edits = 0;
    const ready = new Promise<void>((r) => {
      bothEdited = r;
    });
    const failGate = new Promise<void>((r) => {
      releaseFailure = r;
    });
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'closed' };
      if (input.prompt.startsWith('related-check feedback'))
        return { disposition: 'fixed', reason: 'feedback', evidence: [] };
      const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
      await writeFile(
        join(input.workspace!.path, file),
        file === 'src/a.ts' ? 'GOOD\n' : 'FAILED SIBLING\n',
      );
      if (++edits === 2) bothEdited();
      await ready;
      if (file === 'src/b.ts') {
        await failGate;
        throw new Error('sibling failure');
      }
      return { disposition: 'fixed', reason: 'edited', evidence: [] };
    });
    let a: ReturnType<typeof f.engine.fix> | undefined,
      b: ReturnType<typeof f.engine.fix> | undefined;
    try {
      a = f.engine.fix(finding(), 1);
      b = f.engine.fix(finding('src/b.ts'), 1);
      const fixed = await a;
      expect(fixed.finding.status, fixed.reason).toBe('fixed');
      releaseFailure();
      const failed = await b;
      const retained = failed.failedAttempts![0]!;
      expect(retained.executionHead).toBe(f.initial);
      expect(retained.parent).toBe(fixed.commit);
      expect(f.repo.git('show', `${retained.sha}:src/a.ts`)).toBe('GOOD\n');
      expect(f.repo.git('diff', '--name-only', retained.parent, retained.sha).trim()).toBe(
        'src/b.ts',
      );
    } finally {
      releaseFailure();
      await Promise.allSettled([a, b]);
      await f.cleanup();
    }
  });
  test('a moved failed branch refuses rescue feedback without losing its recorded SHA', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        throw new Error('provider failure');
      },
      '',
      {
        rescueBase: 1,
        gitHook: async (args, run) => {
          const ref = args.find((arg) => arg.startsWith('refs/heads/cq-address/'));
          if (args.includes('rev-parse') && args.includes('--verify') && ref)
            await run(['update-ref', ref, 'HEAD']);
          return run(args);
        },
      },
    );
    try {
      const failed = await f.engine.fix(finding(), 1);
      expect(failed.reason).toContain('no longer matches');
      expect(f.calls()).toBe(1);
      expect(failed.failedAttempts).toHaveLength(1);
      expect(f.repo.git('show', `${failed.failedAttempts![0]!.sha}:src/a.ts`)).toBe('PARTIAL\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test('execution admission waits for sibling commit verification and registration', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let heldOnce = false;
    const f = await fixture(undefined, '', {
      gitHook: async (args, run) => {
        if (!heldOnce && args.at(-2) === 'rev-parse' && args.at(-1)?.endsWith('^')) {
          heldOnce = true;
          entered();
          await gate;
        }
        return run(args);
      },
    });
    let first: ReturnType<typeof f.engine.fix> | undefined,
      second: ReturnType<typeof f.engine.fix> | undefined;
    try {
      first = f.engine.fix(finding(), 1);
      await held;
      const unregistered = f.repo.git('rev-parse', 'HEAD').trim();
      expect(unregistered).not.toBe(f.initial);
      second = f.engine.fix(finding('src/b.ts'), 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      expect(f.attempts.some((row) => row.finding === 'src/b.ts')).toBe(false);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.finding.status, a.reason).toBe('fixed');
      expect(b.finding.status, b.reason).toBe('fixed');
      expect(b.observedHead).toBe(a.commit);
      expect(f.repo.git('rev-parse', `${b.commit}^`).trim()).toBe(a.commit);
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await f.cleanup();
    }
  });
});
