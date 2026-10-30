// Lane C S3 — the ATTENDED approval authority over a REAL git repository:
// the caller's confirm(subject) is the only approval source; the ADR-0003
// properties hold (exact subject, state re-check at exercise, single-use
// grant, lock through the write); the `.cq/` exemption ignores the report
// area and NOTHING else.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApprovalSubject } from '../../../src/ops/analyze/approval.js';
import {
  approvalInputDigest,
  makeGitApprovalStateReader,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import {
  ATTENDED_DEFAULT_EXEMPT,
  makeAttendedApprovalAuthority,
} from '../../../src/ops/analyze/attended.js';

const repos: string[] = [];
function repo(): { dir: string; git: (args: string[]) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-attended-')));
  repos.push(dir);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'attended@example.invalid']);
  git(['config', 'user.name', 'attended test']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  return { dir, git };
}
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function subjectFor(dir: string, overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    op: 'test.write',
    workspace: dir,
    targets: ['src/a.ts'],
    inputDigest: approvalInputDigest({ change: 'a=2' }),
    ...overrides,
  };
}

const write = (dir: string) => async () => {
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
  return 'written';
};

describe('makeAttendedApprovalAuthority', () => {
  test('separate authorities serialize their state recheck and write for one workspace', async () => {
    const { dir } = repo();
    let clean = true;
    // Immediate reads keep the interleaving independent of git subprocess timing.
    const readState = { read: async () => ({ workspace: dir, headSha: 'head', treeClean: clean }) };
    const first = makeAttendedApprovalAuthority({ confirm: () => true, readState });
    const second = makeAttendedApprovalAuthority({ confirm: () => true, readState });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstResult = withApprovedMutation(first, subjectFor(dir), async () => {
      enteredFirst();
      await holdFirst;
      clean = false;
      return write(dir)();
    });
    await firstEntered;
    let admittedSecond!: () => void;
    const secondAdmitted = new Promise<void>((resolve) => {
      admittedSecond = resolve;
    });
    const admit = second.admit.bind(second);
    second.admit = async (subject) => {
      const result = await admit(subject);
      admittedSecond();
      return result;
    };
    let secondWrote = false;
    const secondResult = withApprovedMutation(second, subjectFor(dir), async () => {
      secondWrote = true;
      return 'unexpected';
    });
    await secondAdmitted;
    // Let any unqueued critical section finish while the first write is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    expect((await firstResult).status).toBe('ok');
    expect((await secondResult).status).toBe('needs-human');
    expect(secondWrote).toBe(false);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });
  test('confirm true on a clean tree → the write happens; confirm saw the exact subject', async () => {
    const { dir } = repo();
    const seen: ApprovalSubject[] = [];
    const authority = makeAttendedApprovalAuthority({
      confirm: (subject) => {
        seen.push(subject);
        return true;
      },
    });
    const subject = subjectFor(dir);
    const result = await withApprovedMutation(authority, subject, write(dir));
    expect(result).toEqual({ status: 'ok', value: 'written' });
    expect(seen).toEqual([subject]);
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  test('confirm false (or throwing) → needs-human, nothing written', async () => {
    const { dir } = repo();
    for (const confirm of [() => false, () => Promise.reject(new Error('no tty'))]) {
      const authority = makeAttendedApprovalAuthority({ confirm });
      const result = await withApprovedMutation(authority, subjectFor(dir), write(dir));
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('no verified approval');
    }
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  test('untracked or modified files under .cq/ do not dirty the tree', async () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, '.cq', 'analysis'), { recursive: true });
    writeFileSync(join(dir, '.cq', 'analysis', 'report.md'), 'untracked report');
    writeFileSync(join(dir, '.cq', 'tracked.txt'), 'v1');
    git(['add', '.cq/tracked.txt']);
    git(['commit', '-q', '-m', 'tracked report-area file']);
    writeFileSync(join(dir, '.cq', 'tracked.txt'), 'v2');
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    const result = await withApprovedMutation(authority, subjectFor(dir), write(dir));
    expect(result.status).toBe('ok');
  });

  test.each([
    ['an untracked file elsewhere', 'notes.txt', false],
    ['a modified tracked file', 'src/a.ts', true],
  ])('%s still refuses, naming the dirty path', async (_label, path, tracked) => {
    const { dir } = repo();
    writeFileSync(join(dir, path), tracked ? 'export const a = 9;\n' : 'stray');
    let asked = false;
    const authority = makeAttendedApprovalAuthority({
      confirm: () => {
        asked = true;
        return true;
      },
    });
    const result = await withApprovedMutation(
      authority,
      subjectFor(dir, { targets: ['src/b.ts'] }),
      async () => 'never',
    );
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('workspace dirty');
      expect(result.reason).toContain(`'${path}'`);
    }
    // Dirt is refused BEFORE the human is asked.
    expect(asked).toBe(false);
  });

  test('a custom exempt list replaces the default', async () => {
    const { dir } = repo();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'x.json'), '{}');
    const exemptOut = makeAttendedApprovalAuthority({ confirm: () => true, exempt: ['out/'] });
    expect((await withApprovedMutation(exemptOut, subjectFor(dir), write(dir))).status).toBe('ok');
    expect(ATTENDED_DEFAULT_EXEMPT).toEqual(['.cq/']);
  });

  test('a target under an exempt prefix is refused outright', async () => {
    const { dir } = repo();
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    const result = await withApprovedMutation(
      authority,
      subjectFor(dir, { targets: ['.cq/analysis/x.json'] }),
      async () => 'never',
    );
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('exempt prefix');
  });

  test('state drift between admission and exercise refuses; nothing written (TOCTOU)', async () => {
    const { dir, git } = repo();
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    let wrote = false;
    const result = await withApprovedMutation(
      authority,
      subjectFor(dir),
      async () => {
        wrote = true;
        return 'never';
      },
      // The preflight runs after admission and before the exercise: move
      // HEAD here to simulate a concurrent commit.
      () => {
        writeFileSync(join(dir, 'src', 'c.ts'), 'export {};\n');
        git(['add', 'src/c.ts']);
        git(['commit', '-q', '-m', 'concurrent']);
        return { ok: true };
      },
    );
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('state changed');
    expect(wrote).toBe(false);
  });

  test('a grant is single-use: a second exercise of the same grant throws', async () => {
    const { dir } = repo();
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    const subject = subjectFor(dir);
    const admitted = await authority.admit(subject);
    expect(admitted.granted).toBe(true);
    if (!admitted.granted) return;
    expect((await authority.exercise(admitted.grant, subject)).granted).toBe(true);
    await expect(authority.exercise(admitted.grant, subject)).rejects.toThrow(/single-use/);
  });

  test('a grant does not cover a different subject at exercise', async () => {
    const { dir } = repo();
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    const admitted = await authority.admit(subjectFor(dir));
    if (!admitted.granted) throw new Error('expected a grant');
    const other = subjectFor(dir, { inputDigest: approvalInputDigest({ change: 'a=3' }) });
    const exercised = await authority.exercise(admitted.grant, other);
    expect(exercised.granted).toBe(false);
  });

  test('a repository without a commit is refused as unreadable state', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-attended-empty-')));
    repos.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    const authority = makeAttendedApprovalAuthority({ confirm: () => true });
    const result = await withApprovedMutation(authority, subjectFor(dir), async () => 'never');
    expect(result.status).toBe('needs-human');
  });
});

describe('makeGitApprovalStateReader exempt option', () => {
  test('escaping or absolute prefixes are refused at construction', () => {
    for (const bad of ['../x', '/abs', '', '.', 'a/../../b']) {
      expect(() => makeGitApprovalStateReader({ exempt: [bad] }), bad).toThrow(/exempt prefix/);
    }
  });

  test('dirtyPaths are workspace-relative for a subdirectory workspace; default stays strict', async () => {
    const { dir } = repo();
    mkdirSync(join(dir, 'pkg', '.cq'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'stray.txt'), 'x');
    writeFileSync(join(dir, 'pkg', '.cq', 'r.json'), '{}');
    const strict = await makeGitApprovalStateReader().read(join(dir, 'pkg'));
    expect(strict.treeClean).toBe(false);
    expect([...(strict.dirtyPaths ?? [])].sort()).toEqual(['.cq/r.json', 'stray.txt']);
    const exempting = await makeGitApprovalStateReader({ exempt: ['.cq/'] }).read(join(dir, 'pkg'));
    expect(exempting.dirtyPaths).toEqual(['stray.txt']);
  });
});
