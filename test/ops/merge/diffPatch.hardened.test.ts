// Review P1 on PR #1628 (issue #1193's publication gate): a repo-controlled
// .gitattributes diff driver or textconv is a PROGRAM git would run to
// produce the patch — without --no-ext-diff/--no-textconv it can substitute
// harmless text (or empty output) for the committed bytes, and the gate
// would clear a secret-bearing commit. Unlike every other resolveConflict
// fixture, THIS file spawns real git: the hazard lives in git's own
// attribute/config machinery, so only a real repository can prove the
// hardened diffPatch sees the committed bytes anyway. Temporary repos are
// created per test in mkdtemp dirs and removed in finally.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { realMergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';

const run = promisify(execFile);

/** One throwaway repo with hostile diff attributes: a textconv that redacts
 * the sk-live pattern from every secret.txt diff line (the realistic
 * attack — show the file, hide the secret), and an external command driver
 * that emits nothing for ext.txt — both would hide an added token from an
 * unhardened diff. Returns the pre/post commit shas. */
async function hostileRepo(): Promise<{ dir: string; before: string; after: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'diffpatch-hardened-'));
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@localhost');
  await git('config', 'user.name', 'test');
  // The hostile attributes + the diff PROGRAMS they select.
  await writeFile(join(dir, '.gitattributes'), 'secret.txt diff=hide\next.txt diff=void\n');
  await run('git', [
    '-C',
    dir,
    'config',
    '--local',
    'diff.hide.textconv',
    'sed s/sk-live/REDACTED/g',
  ]);
  // `true` (not `exit 0`): git appends its 7 diff parameters to the
  // command, and `exit` with extra arguments is a shell error.
  await run('git', ['-C', dir, 'config', '--local', 'diff.void.command', 'true']);
  await writeFile(join(dir, 'secret.txt'), 'harmless v1\n');
  await writeFile(join(dir, 'ext.txt'), 'harmless v1\n');
  await git('add', '.');
  await git('commit', '-m', 'before');
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  // The secrets the gate must see regardless of the attribute machinery.
  await writeFile(join(dir, 'secret.txt'), 'harmless v1\nconst token = "sk-live-textconv";\n');
  await writeFile(join(dir, 'ext.txt'), 'harmless v1\nconst token = "sk-live-extdriver";\n');
  await git('add', '.');
  await git('commit', '-m', 'after');
  const after = (await git('rev-parse', 'HEAD')).stdout.trim();
  return { dir, before, after };
}

describe('diffPatch is hardened against repo-controlled diff programs (review P1, PR #1628)', () => {
  test('an UNHARDENED git diff is blinded by the fixture (the hazard is real)', async () => {
    const { dir, before, after } = await hostileRepo();
    try {
      const plain = await run('git', ['-C', dir, 'diff', '--unified=0', before, after]);
      // The textconv shows the FILE but redacts the secret; the external
      // driver shows nothing at all. An unhardened gate would clear both.
      expect(plain.stdout).toContain('REDACTED');
      expect(plain.stdout).not.toContain('sk-live-textconv');
      expect(plain.stdout).not.toContain('sk-live-extdriver');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('diffPatch sees the committed bytes anyway — both secrets in the patch', async () => {
    const { dir, before, after } = await hostileRepo();
    try {
      const effects = realMergeEffects({ repoRoot: dir });
      const patch = await effects.diffPatch(before, after);
      expect(patch.code).toBe(0);
      // The textconv-hidden token: the real committed bytes, not `HIDDEN`.
      expect(patch.stdout).toContain('sk-live-textconv');
      expect(patch.stdout).not.toContain('REDACTED');
      // The external-driver-hidden token.
      expect(patch.stdout).toContain('sk-live-extdriver');
      // The pinned header shape the scanner's parser keys on.
      expect(patch.stdout).toContain('+++ b/secret.txt');
      expect(patch.stdout).toContain('+++ b/ext.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
