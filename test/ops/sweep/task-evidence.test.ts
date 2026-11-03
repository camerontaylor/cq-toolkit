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

// M6a share sweep commit trailers: verified and failed commit messages share
// the same Cq-* key set via the shared formatCqTrailers helper, failed
// gate/outcome/ref-identity extras are preserved, and embedded newlines are
// rejected. The fake driver effects below capture the verified message.

test('M6a nominal evidence', async () => {
  const invocations: OpInvocation[] = [];
  const messages: string[] = [];
  const outcome = await runLadder(
    () =>
      runTaskLoop(
        loopBindings(invocations),
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        {
          ...EFFECTS,
          commit: async (message: string) => {
            messages.push(message);
            return 'c'.repeat(40);
          },
        },
      ),
    { wallClockMs: 5000 },
    {
      op: 'sweep.unit',
      jobKey: 'j-1',
      attempt: 1,
      correlation: { workId: 'run:j-1:1', runId: 'run', role: 'sweep.unit' },
    },
  );
  expect(outcome.outcome).toBe('completed');
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).toContain('Cq-Run: run/x');
    expect(message).toContain('Cq-Unit: fix/alpha');
    expect(message).toContain('Cq-Task: src/a.ts');
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: worker');
    expect(message).toContain('Cq-Model: fixture/scripted');
  }
});

test('M6a missing evidence', async () => {
  // Missing unit-segment evidence: with no resolved segments binding the
  // verified commit still emits the full shared key set through the real
  // commit-message path, falling back to the raw unit fixer/package for
  // Cq-Unit, and no governed correlation is forwarded.
  const invocations: OpInvocation[] = [];
  const messages: string[] = [];
  const bindings: Record<string, unknown> = { ...loopBindings(invocations) };
  delete bindings.segments;
  const outcome = await runLadder(
    () =>
      runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        {
          ...EFFECTS,
          commit: async (message: string) => {
            messages.push(message);
            return 'c'.repeat(40);
          },
        },
      ),
    { wallClockMs: 5000 },
    { op: 'sweep.unit', jobKey: 'j-2', attempt: 1 },
  );
  expect(outcome.outcome).toBe('completed');
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.correlation).toBeUndefined();
  }
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).toContain('Cq-Run: run/x');
    expect(message).toContain('Cq-Unit: fix/alpha');
    expect(message).toContain('Cq-Task: src/a.ts');
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: worker');
    expect(message).toContain('Cq-Model: fixture/scripted');
    for (const key of ['Cq-Run:', 'Cq-Unit:', 'Cq-Task:', 'Cq-Attempt:', 'Cq-Tier:', 'Cq-Model:']) {
      expect(message.split('\n').filter((line) => line.startsWith(key))).toHaveLength(1);
    }
  }
});

test('M6a failure evidence', async () => {
  // A failed attempt keeps the failed-surface extras while routing through
  // the shared helper: gate, outcome and ref identity remain on the message.
  const root = await mkdtemp(join(tmpdir(), 'cq-task-m6a-failure-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'base']);
    const parent = await git(['rev-parse', 'HEAD']);
    const attempt = await commitFailedAttempt(git, {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts',
      parent,
      firstAttempt: 1,
      tier: 'rescue',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'path-policy',
      outcome: 'escalated-to-human',
      reason: 'fixture',
      pushFailed: false,
    });
    const message = await git(['show', '-s', '--format=%B', attempt.sha]);
    expect(message).toContain('Cq-Run: run');
    expect(message).toContain('Cq-Unit: tests/pkg');
    expect(message).toContain('Cq-Task: file.ts');
    expect(message).toContain(
      `Cq-Ref-Identity: ${Buffer.from(JSON.stringify(['tests', 'pkg', 'file.ts'])).toString('base64url')}`,
    );
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: rescue');
    expect(message).toContain('Cq-Model: fixture/scripted');
    expect(message).toContain('Cq-Gate: path-policy');
    expect(message).toContain('Cq-Outcome: escalated-to-human');
    // A task string with an embedded newline stays sanitized onto one line
    // (existing behavior): the shared helper never sees a raw newline.
    const attempt2 = await commitFailedAttempt(git, {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts\nCq-Forged: x',
      parent,
      firstAttempt: 1,
      tier: 'worker',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related',
      outcome: 'unfixed',
      reason: 'fixture',
      pushFailed: false,
    });
    const sanitized = await git(['show', '-s', '--format=%B', attempt2.sha]);
    expect(sanitized).toContain('Cq-Task: file.ts Cq-Forged: x');
    expect(sanitized.split('\n').filter((line) => line.startsWith('Cq-Task:'))).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// M5b4 forward governed invocation correlation: every OpInvocation the task
// loop builds forwards the governed job's correlation (the shared
// correlationInvocation helper result); run/work/parent/task forward
// verbatim and the role is passed through, never re-derived.
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { runTaskLoop } from '../../../src/ops/sweep/taskLoop.js';
import { runLadder } from '../../../src/kernel/governor.js';

const UNIT = { package: 'alpha', fixer: 'fix', files: ['src/a.ts'] };
const PROBE = {
  verdict: 'failing' as const,
  attempts: 1,
  failureSet: {
    tool: 'vitest',
    exitCode: 1,
    failures: [
      {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: null,
        message: 'broken',
        severity: 'error' as const,
      },
    ],
  },
};
const EFFECTS = {
  broader: async () => ({
    final: {
      verdict: 'clean' as const,
      attempts: 1,
      failureSet: { tool: 'vitest', exitCode: 0, failures: [] },
    },
    treeSha: 'b'.repeat(40),
  }),
  commit: async () => 'c'.repeat(40),
  verify: async () => {},
  publish: async () => {},
};

function loopBindings(invocations: OpInvocation[]): Parameters<typeof runTaskLoop>[0] {
  return {
    driver: {
      run: async (invocation: OpInvocation): Promise<WorkerResult> => {
        invocations.push(invocation);
        return {
          structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      },
    },
    prompt: () => 'fix it',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    runCheck: async () => ({
      stdout: JSON.stringify({
        success: true,
        numTotalTests: 1,
        testResults: [
          {
            name: 's.test.js',
            status: 'passed',
            assertionResults: [{ fullName: 'p', status: 'passed' }],
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
    }),
    adapter: 'vitest-json' as const,
    checkCommand: () => ({ command: 'node', args: ['check'], cwd: '/tmp/unused' }),
    budget: { wallClockMs: 60_000 },
    runPrefix: 'run/x',
    scanPrompt: async () => {},
    modelSpec: { provider: 'fixture', model: 'scripted' },
  } as unknown as Parameters<typeof runTaskLoop>[0];
}

const runLoop = (invocations: OpInvocation[]) =>
  runTaskLoop(
    loopBindings(invocations),
    UNIT,
    { path: '/tmp/unused', branch: 'run/x' } as never,
    PROBE,
    'run/x',
    EFFECTS,
  );

test('M5b4 nominal evidence', async () => {
  const invocations: OpInvocation[] = [];
  const outcome = await runLadder(
    () => runLoop(invocations),
    { wallClockMs: 5000 },
    {
      op: 'sweep.unit',
      jobKey: 'j-1',
      attempt: 1,
      correlation: { workId: 'run:j-1:1', runId: 'run', role: 'sweep.unit' },
    },
  );
  expect(outcome.outcome).toBe('completed');
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.correlation).toEqual({
      workId: 'run:j-1:1',
      runId: 'run',
      role: 'sweep.unit',
    });
  }
});

test('M5b4 missing evidence', async () => {
  const invocations: OpInvocation[] = [];
  const outcome = await runLoop(invocations);
  expect(['ok', 'failed']).toContain(outcome.status);
  // Discriminating, not vacuous: the loop must actually have built driver
  // invocations to inspect, and every one of them must carry NO correlation
  // (a forwarded correlation key here would fail the loop below).
  expect(invocations.length).toBeGreaterThan(0);
  expect(invocations.some((invocation) => invocation.correlation !== undefined)).toBe(false);
  for (const invocation of invocations) {
    expect(invocation.correlation).toBeUndefined();
  }
});

// Table-driven over the correlation shapes the runner may hand the task
// loop: run/work/parent/task forward verbatim, the role passes through
// untouched, and an absent role falls back to the helper's 'fixer' default
// (never re-derived from the op id).
test('M5b4 failure evidence', async () => {
  const cases: Array<{
    name: string;
    correlation: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: 'run id forwards verbatim',
      correlation: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'orchestrator' },
      expected: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'orchestrator' },
    },
    {
      name: 'work/parent ids forward verbatim',
      correlation: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        parentWorkId: 'parent-1',
        role: 'orchestrator',
      },
      expected: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        parentWorkId: 'parent-1',
        role: 'orchestrator',
      },
    },
    {
      name: 'task label forwards verbatim and no role is re-derived',
      correlation: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        role: 'orchestrator',
        task: 'outer task',
      },
      expected: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        role: 'orchestrator',
        task: 'outer task',
      },
    },
    {
      name: 'absent role defaults to fixer',
      correlation: { workId: 'run:j-outer:7', runId: 'outer-run' },
      expected: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'fixer' },
    },
  ];
  for (const { name, correlation, expected } of cases) {
    const invocations: OpInvocation[] = [];
    // A governed correlation carrying the OUTER job's identity fields: the
    // invocation forwards them verbatim and invents NO new role.
    await runLadder(
      () => runLoop(invocations),
      { wallClockMs: 5000 },
      {
        op: 'sweep.unit',
        jobKey: 'j-outer',
        attempt: 7,
        correlation: correlation as never,
      },
    );
    expect(invocations.length, name).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.correlation, name).toEqual(expected);
    }
  }
});


test('retry prompt projection excludes large baselines without mutating durable evidence', () => {
  const final = { tool: 'vitest', exitCode: 1, failures: [{ file: 'other.test.ts', line: null, column: null, ruleId: null, message: 'LARGE_BASELINE'.repeat(1000), severity: 'error' as const }] };
  const round = { tier: 'worker' as const, attempt: 1, reason: 'regression', failedAttempt: { branch: 'failed', sha: 'a'.repeat(40) }, validation: { verdict: 'fail' as const, regression: true as const, gates: [{ gate: 'broader' as const, verdict: 'fail' as const, wallMs: 1, detail: 'new failure' }], final } };
  const before = JSON.stringify(round);
  const projection = promptRound(round);
  expect(JSON.stringify(projection)).not.toContain('LARGE_BASELINE');
  expect(projection).toMatchObject({ reason: 'regression', failedAttempt: round.failedAttempt, validation: { regression: true, verdict: 'fail', gates: round.validation.gates } });
  expect(JSON.stringify(round)).toBe(before);
  expect(promptRound(undefined)).toBeNull();
});

import { promptRound } from '../../../src/ops/sweep/taskLoop.js';
