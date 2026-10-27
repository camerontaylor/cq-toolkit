import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitFailedAttempt } from '../../../src/ops/sweep/taskLoop.js';

const exec = promisify(execFile);

test('concurrent units pin plain failed commits under independent run branches and restore clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-evidence-'));
  const git = (cwd: string) => async (args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  try {
    await git(root)(['init', '-b', 'main']);
    await git(root)(['config', 'user.name', 'Fixture']);
    await git(root)(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'source.ts'), 'baseline');
    await git(root)(['add', 'source.ts']);
    await git(root)(['commit', '-m', 'baseline']);
    const a = join(root, 'unit-a');
    const b = join(root, 'unit-b');
    await git(root)(['worktree', 'add', '-b', 'run/a/tests/pkg-a', a, 'HEAD']);
    await git(root)(['worktree', 'add', '-b', 'run/b/tests/pkg-b', b, 'HEAD']);
    const evidence = await Promise.all(
      [
        { cwd: a, runPrefix: 'run/a', slug: 'pkg-a', text: 'a' },
        { cwd: b, runPrefix: 'run/b', slug: 'pkg-b', text: 'b' },
      ].map(async ({ cwd, runPrefix, slug, text }) => {
        await writeFile(join(cwd, 'source.ts'), text);
        await writeFile(join(cwd, 'new.ts'), text);
        const head = await git(cwd)(['rev-parse', 'HEAD']);
        await git(cwd)(['add', '-A', '--', '.']);
        const attempt = await commitFailedAttempt(git(cwd), {
          runPrefix,
          kind: 'tests',
          slug,
          task: 'src/source.ts',
          parent: head,
          firstAttempt: 1,
          tier: 'worker',
          model: { provider: 'fixture', model: 'scripted' },
          gate: 'related',
          outcome: 'unfixed',
          reason: 'related check rejected the edit',
          pushFailed: false,
        });
        await git(cwd)(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
        return { cwd, attempt, text };
      }),
    );
    expect(evidence[0]?.attempt.branch).toMatch(
      /^run\/a\/failed\/tests-[0-9a-f]{16}\/pkg-a-[0-9a-f]{16}\/src-source-ts-[0-9a-f]{16}\/a1$/,
    );
    expect(evidence[1]?.attempt.branch).toMatch(
      /^run\/b\/failed\/tests-[0-9a-f]{16}\/pkg-b-[0-9a-f]{16}\/src-source-ts-[0-9a-f]{16}\/a1$/,
    );
    for (const { cwd, attempt, text } of evidence) {
      expect(await git(root)(['rev-parse', `refs/heads/${attempt.branch}`])).toBe(attempt.sha);
      expect(await git(root)(['show', `${attempt.sha}:new.ts`])).toBe(text);
      expect(await git(root)(['show', `${attempt.sha}:source.ts`])).toBe(text);
      expect(await git(root)(['show', '-s', '--format=%P', attempt.sha])).toBe(
        await git(cwd)(['rev-parse', 'HEAD']),
      );
      expect(await git(root)(['show', '-s', '--format=%an <%ae>', attempt.sha])).toBe(
        'CQ fix engine <cq-fix-engine@invalid>',
      );
      const message = await git(root)(['show', '-s', '--format=%B', attempt.sha]);
      expect(message).toContain('cq-failed(unfixed): src/source.ts');
      expect(message).toContain('Cq-Run: run/');
      expect(message).toContain('Cq-Unit: tests/');
      expect(message).toContain('Cq-Task: src/source.ts');
      expect(message).toContain('Cq-Attempt: 1');
      expect(message).toContain('Cq-Tier: worker');
      expect(message).toContain('Cq-Model: fixture/scripted');
      expect(message).toContain('Cq-Gate: related');
      expect(message).toContain('Cq-Outcome: unfixed');
      expect(await git(cwd)(['status', '--porcelain'])).toBe('');
      expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('baseline');
      await expect(readFile(join(cwd, 'new.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await git(root)(['for-each-ref', '--format=%(refname)', 'refs/stash'])).toBe('');
    expect(await git(root)(['for-each-ref', '--format=%(refname)', 'refs/cq'])).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed-attempt branch collisions increment and push opt-in marks commits to skip CI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-collision-'));
  const git = (cwd: string) => async (args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  try {
    await git(root)(['init', '-b', 'main']);
    await git(root)(['config', 'user.name', 'Fixture']);
    await git(root)(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(root)(['add', 'file.ts']);
    await git(root)(['commit', '-m', 'base']);
    const parent = await git(root)(['rev-parse', 'HEAD']);
    const collision = 'run/failed/tests/pkg/file-ts/a1';
    await git(root)(['update-ref', `refs/heads/${collision}`, parent]);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(root)(['add', '-A', '--', '.']);
    const input = {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts',
      parent,
      firstAttempt: 1,
      tier: 'rescue',
      model: { provider: 'fixture', model: 'rescuer' },
      gate: 'budget',
      outcome: 'escalated-to-human',
      reason: 'token budget exhausted',
      pushFailed: true,
    } as const;
    const attempt = await commitFailedAttempt(git(root), input);
    expect(attempt.branch).toMatch(
      /^run\/failed\/tests-[0-9a-f]{16}\/pkg-[0-9a-f]{16}\/file-ts-[0-9a-f]{16}\/a1$/,
    );
    const retry = await commitFailedAttempt(git(root), input);
    expect(retry.branch).toBe(attempt.branch.replace(/\/a1$/, '/a2'));
    expect(await git(root)(['rev-parse', `refs/heads/${collision}`])).toBe(parent);
    expect(await git(root)(['rev-parse', `refs/heads/${attempt.branch}`])).toBe(attempt.sha);
    const message = await git(root)(['show', '-s', '--format=%B', attempt.sha]);
    expect(message.split('\n')[0]).toBe('cq-failed(escalated-to-human): file.ts [skip ci]');
    expect(message).toContain('Cq-Attempt: 1');
    expect(await git(root)(['show', '-s', '--format=%B', retry.sha])).toContain('Cq-Attempt: 2');
    expect(message).toContain('Cq-Tier: rescue');
    expect(message).toContain('Cq-Gate: budget');
    expect(message).toContain('Cq-Outcome: escalated-to-human');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed-attempt tree failures stop before creating any refs', async () => {
  const calls: string[][] = [];
  await expect(
    commitFailedAttempt(
      async (args) => {
        calls.push(args);
        return '';
      },
      {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task: 'file.ts',
        parent: 'a'.repeat(40),
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'none',
        outcome: 'unfixed',
        reason: 'failure',
        pushFailed: false,
      },
    ),
  ).rejects.toThrow('could not write failed-attempt tree');
  expect(calls).toEqual([['write-tree']]);
});

test('failed ref update errors propagate when verification cannot find a collision', async () => {
  const updateError = new Error('update-ref permission denied');
  const calls: string[][] = [];
  await expect(
    commitFailedAttempt(
      async (args) => {
        calls.push(args);
        if (args[0] === 'write-tree') return 'a'.repeat(40);
        if (args[0] === 'for-each-ref') return '';
        if (args.includes('commit-tree')) return 'b'.repeat(40);
        if (args[0] === 'update-ref') throw updateError;
        if (args[0] === 'rev-parse') throw new Error('branch does not exist');
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task: 'file.ts',
        parent: 'c'.repeat(40),
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'related',
        outcome: 'unfixed',
        reason: 'related check rejected the edit',
        pushFailed: false,
      },
    ),
  ).rejects.toBe(updateError);
  expect(calls.map((args) => args[0])).toEqual([
    'write-tree',
    'for-each-ref',
    '-c',
    'update-ref',
    'rev-parse',
  ]);
});

test('failed refs bound flattened components and use the repository object-id width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-evidence-sha256-'));
  const git = (cwd: string) => async (args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  try {
    await git(root)(['init', '--object-format=sha256', '-b', 'main']);
    await git(root)(['config', 'user.name', 'Fixture']);
    await git(root)(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(root)(['add', 'file.ts']);
    await git(root)(['commit', '-m', 'base']);
    const parent = await git(root)(['rev-parse', 'HEAD']);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(root)(['add', 'file.ts']);
    const attempt = await commitFailedAttempt(git(root), {
      runPrefix: 'run',
      kind: 'kind-'.repeat(40),
      slug: 'slug-'.repeat(40),
      task: 'nested/path-'.repeat(40),
      parent,
      firstAttempt: 1,
      tier: 'worker',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related',
      outcome: 'unfixed',
      reason: 'check rejected the edit',
      pushFailed: false,
    });
    expect(attempt.sha).toHaveLength(64);
    const segments = attempt.branch.split('/');
    expect(
      segments
        .filter((segment) => segment !== 'failed' && !/^a\d+$/.test(segment))
        .every((segment) => segment.length <= 80),
    ).toBe(true);
    expect(await git(root)(['rev-parse', `refs/heads/${attempt.branch}`])).toBe(attempt.sha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('raw task identities produce distinct valid refs for punctuation, Unicode, long and empty prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-identities-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'baseline');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'baseline']);
    const parent = await git(['rev-parse', 'HEAD']);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(['add', 'file.ts']);
    const ids = [
      'a-b.ts',
      'a_b.ts',
      '東京/🦊',
      '!!!',
      '???',
      'long-'.repeat(60) + 'one',
      'long-'.repeat(60) + 'two',
    ];
    const branches = new Set<string>();
    for (const task of ids) {
      const result = await commitFailedAttempt(git, {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task,
        parent,
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'related',
        outcome: 'unfixed',
        reason: 'fixture',
        pushFailed: false,
      });
      expect(await git(['check-ref-format', '--branch', result.branch])).toBe(result.branch);
      expect(result.branch.split('/').every((part) => part.length <= 80)).toBe(true);
      expect(result.branch.endsWith('/a1')).toBe(true);
      expect(branches.has(result.branch)).toBe(false);
      branches.add(result.branch);
      const message = await git(['show', '-s', '--format=%B', result.sha]);
      expect(message).toContain(
        `Cq-Ref-Identity: ${Buffer.from(JSON.stringify(['tests', 'pkg', task])).toString('base64url')}`,
      );
      expect(message).toContain(`Cq-Task: ${task}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a conflicting recorded identity extends the digest instead of consuming another task attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-ref-conflict-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'base']);
    const parent = await git(['rev-parse', 'HEAD']);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(['add', 'file.ts']);
    const input = {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'same-display',
      taskIdentity: 'full-static-signature-B',
      parent,
      firstAttempt: 1,
      tier: 'worker' as const,
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related' as const,
      outcome: 'unfixed' as const,
      reason: 'fixture',
      pushFailed: false,
    };
    const first = await commitFailedAttempt(git, {
      ...input,
      taskIdentity: 'full-static-signature-A',
    });
    const digest = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const occupied = `run/failed/tests-${digest('tests')}/pkg-${digest('pkg')}/same-display-${digest(input.taskIdentity)}/a1`;
    await git(['update-ref', `refs/heads/${occupied}`, first.sha, '0'.repeat(40)]);
    const result = await commitFailedAttempt(git, input);
    expect(result.branch).toMatch(/\/same-display-[0-9a-f]{24}\/a1$/);
    expect(await git(['rev-parse', `refs/heads/${occupied}`])).toBe(first.sha);
    expect(await git(['rev-parse', `refs/heads/${first.branch}`])).toBe(first.sha);
    const retry = await commitFailedAttempt(git, input);
    expect(retry.branch).toBe(result.branch.replace(/\/a1$/, '/a2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolved unit segments keep distinct raw unit names on real Git refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-unit-identities-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'base']);
    const parent = await git(['rev-parse', 'HEAD']);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(['add', 'file.ts']);
    const input = {
      runPrefix: 'run',
      kind: 'a-b',
      slug: 'pkg-a',
      task: 'file.ts',
      parent,
      firstAttempt: 1,
      tier: 'worker' as const,
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related' as const,
      outcome: 'unfixed' as const,
      reason: 'fixture',
      pushFailed: false,
    };
    const first = await commitFailedAttempt(git, {
      ...input,
      kindIdentity: 'a-b',
      slugIdentity: '@pkg/a',
    });
    const second = await commitFailedAttempt(git, {
      ...input,
      kindIdentity: 'a_b',
      slugIdentity: 'pkg.a',
    });
    expect(first.branch).not.toBe(second.branch);
    expect(first.branch.endsWith('/a1')).toBe(true);
    expect(second.branch.endsWith('/a1')).toBe(true);
    for (const [attempt, rawKind, rawSlug] of [
      [first, 'a-b', '@pkg/a'],
      [second, 'a_b', 'pkg.a'],
    ] as const) {
      expect(await git(['check-ref-format', '--branch', attempt.branch])).toBe(attempt.branch);
      expect(await git(['rev-parse', `refs/heads/${attempt.branch}`])).toBe(attempt.sha);
      const message = await git(['show', '-s', '--format=%B', attempt.sha]);
      expect(message).toContain(
        `Cq-Ref-Identity: ${Buffer.from(JSON.stringify([rawKind, rawSlug, 'file.ts'])).toString('base64url')}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate or conflicting identity trailers do not consume an attempt number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-ambiguous-trailers-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'base']);
    const parent = await git(['rev-parse', 'HEAD']);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(['add', 'file.ts']);
    const tree = await git(['write-tree']);
    const digest = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const common = `run/failed/tests-${digest('tests')}/pkg-${digest('pkg')}`;
    for (const [task, extra] of [
      ['duplicate.ts', 'same'],
      ['conflicting.ts', 'different'],
    ] as const) {
      const expected = `Cq-Ref-Identity: ${Buffer.from(JSON.stringify(['tests', 'pkg', task])).toString('base64url')}`;
      const message = `fixture\n\n${expected}\n${extra === 'same' ? expected : 'Cq-Ref-Identity: other'}`;
      const occupiedSha = await git(['commit-tree', tree, '-p', parent, '-m', message]);
      const occupied = `${common}/${task.replace('.', '-')}-${digest(task)}/a1`;
      await git(['update-ref', `refs/heads/${occupied}`, occupiedSha, '0'.repeat(40)]);
      const result = await commitFailedAttempt(git, {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task,
        parent,
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'related',
        outcome: 'unfixed',
        reason: 'fixture',
        pushFailed: false,
      });
      expect(result.branch).toMatch(/-[0-9a-f]{24}\/a1$/);
      expect(await git(['rev-parse', `refs/heads/${occupied}`])).toBe(occupiedSha);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
