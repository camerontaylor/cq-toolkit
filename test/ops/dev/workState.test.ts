// The shared work-state read (real git): the base pin, the dirty identity
// over staged + unstaged + untracked, and drift detection.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  CLEAN_TREE,
  dirtyIdentity,
  driftSince,
  readWorkState,
  type WorkState,
} from '../../../src/ops/dev/internal/workState.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

async function state(): Promise<WorkState> {
  const read = await readWorkState(repoEffects(repo), { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  return read.state;
}

describe('readWorkState', () => {
  test('a clean tree: branch, HEAD, the merge-base pin, clean-tree identity', async () => {
    const s = await state();
    expect(s.branch).toBe('feature/x');
    expect(s.head).toBe(repo.git('rev-parse', 'HEAD').trim());
    expect(s.base).toBe(repo.git('rev-parse', 'origin/main').trim());
    expect(s.dirtySha256).toBe(CLEAN_TREE);
    expect(s.untracked).toEqual([]);
  });

  test('an explicit base resolves to the full commit sha', async () => {
    const base = repo.git('rev-parse', 'HEAD~1').trim();
    const read = await readWorkState(repoEffects(repo), {
      target: 'unused',
      base: base.slice(0, 12),
    });
    expect(read.ok && read.state.base).toBe(base);
  });

  test('an index/worktree split whose worktree equals HEAD is NOT clean', async () => {
    await repo.write('src/a.ts', 'export const a = 2;\n');
    repo.git('add', 'src/a.ts');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    expect(repo.git('diff', 'HEAD')).toBe('');
    const s = await state();
    expect(s.staged).not.toBe('');
    expect(s.unstaged).not.toBe('');
    expect(s.dirtySha256).not.toBe(CLEAN_TREE);
  });

  test('untracked paths enter the identity; the toolkit .cq/ state never does', async () => {
    await repo.write('.cq/dev/ledger.json', '{}\n');
    expect((await state()).dirtySha256).toBe(CLEAN_TREE);
    await repo.write('src/new.ts', 'export {};\n');
    const s = await state();
    expect(s.untracked).toEqual(['src/new.ts']);
    expect(s.dirtySha256).not.toBe(CLEAN_TREE);
  });

  test('a detached HEAD and a missing target are reasons, never guessed values', async () => {
    repo.git('checkout', '-q', '--detach');
    const detached = await readWorkState(repoEffects(repo), { target: 'main' });
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.reason).toContain('detached');
    repo.git('checkout', '-q', 'feature/x');
    const missing = await readWorkState(repoEffects(repo), { target: 'nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("'origin/nope' did not resolve");
  });

  test('a failed read is a reason (never a clean tree)', async () => {
    const effects = repoEffects(repo, (command, args) =>
      command === 'git' && args[0] === 'diff'
        ? { exitCode: 128, stdout: '', stderr: 'boom', timedOut: false }
        : undefined,
    );
    const read = await readWorkState(effects, { target: 'main' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('boom');
  });
});

describe('dirtyIdentity', () => {
  test('exact bytes: trailing whitespace and the staged/unstaged split both change it', () => {
    const a = dirtyIdentity('x\n', '', []);
    expect(dirtyIdentity('x \n', '', [])).not.toBe(a);
    expect(dirtyIdentity('', 'x\n', [])).not.toBe(a);
    expect(dirtyIdentity('x', '\n', [])).not.toBe(dirtyIdentity('x\n', '', []));
    expect(dirtyIdentity('', '', ['a'])).not.toBe(CLEAN_TREE);
    expect(dirtyIdentity('', '', [])).toBe(CLEAN_TREE);
  });
});

describe('driftSince', () => {
  test('empty when nothing moved; names HEAD and content drift', async () => {
    const s = await state();
    const effects = repoEffects(repo);
    expect(await driftSince(effects, s)).toEqual([]);
    await repo.write('README.md', '# changed\n');
    expect(await driftSince(effects, s)).toEqual([
      'the staged, unstaged, or untracked state changed',
    ]);
    repo.commitAll('move');
    expect(await driftSince(effects, s)).toContain('HEAD moved');
  });
});
