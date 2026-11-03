// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus task-evidence.helpers.ts (shared fixtures). This file carries failed
// ref identity: flattened component bounds, raw identities, digest extension
// for conflicting recorded identities, resolved unit segments, and ambiguous
// recorded trailers.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitFailedAttempt } from '../../../src/ops/sweep/taskLoop.js';
import { exec } from './task-evidence.helpers.js';

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
