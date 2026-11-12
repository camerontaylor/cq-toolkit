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
import { env } from 'node:process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { realMergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import { addedLineComponents, scanComponents } from '../../../src/ops/dev/denylist.js';

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

// ---------------------------------------------------------------------------
// pushRef --no-follow-tags (review P1 p522, PR #1641)
// ---------------------------------------------------------------------------

describe('pushRef is hardened against push.followTags (review P1 p522)', () => {
  test('an annotated tag stays LOCAL: the publication push uploads only the branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pushref-follotags-'));
    try {
      const origin = join(dir, 'origin.git');
      await run('git', ['init', '--bare', '--initial-branch=main', origin]);
      const clone = join(dir, 'repo');
      await run('git', ['clone', '--quiet', origin, clone]);
      await run('git', ['-C', clone, 'config', 'user.email', 'test@localhost']);
      await run('git', ['-C', clone, 'config', 'user.name', 'test']);
      await writeFile(join(clone, 'base.txt'), 'base\n');
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'base']);
      const sha = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
      // The hazard: an annotated tag the branch push would carry under
      // push.followTags.
      await run('git', ['-C', clone, 'tag', '-a', 'v1', '-m', 'annotated tag', sha]);
      await run('git', ['-C', clone, 'config', 'push.followTags', 'true']);
      // CONTROL (the hazard is real): a --follow-tags push uploads the tag.
      await run('git', ['-C', clone, 'push', '--follow-tags', 'origin', `${sha}:refs/heads/feat`]);
      expect(
        (await run('git', ['-C', origin, 'rev-parse', 'refs/tags/v1'])).stdout.trim(),
      ).not.toBe('');
      // Reset the remote for the hardened run.
      await run('git', ['-C', origin, 'update-ref', '-d', 'refs/tags/v1']);
      await run('git', ['-C', origin, 'update-ref', '-d', 'refs/heads/feat']);
      // HARDENED: the family's pushRef.
      const effects = realMergeEffects({ repoRoot: clone });
      const pushed = await effects.pushRef(`${sha}:refs/heads/feat`, clone);
      expect(pushed.code).toBe(0);
      // The branch landed; the annotated tag did NOT.
      expect((await run('git', ['-C', origin, 'rev-parse', 'refs/heads/feat'])).stdout.trim()).toBe(
        sha,
      );
      let tagMissing = false;
      try {
        await run('git', ['-C', origin, 'rev-parse', 'refs/tags/v1']);
      } catch {
        tagMissing = true;
      }
      expect(tagMissing).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GIT_NO_REPLACE_OBJECTS (review P1 p528, PR #1641)
// ---------------------------------------------------------------------------

describe('the gate reads TRUE objects, never refs/replace substitutions (review P1 p528)', () => {
  test('diffPatch and readCommitMessage see the ORIGINAL commit while a replacement ref maps it to a clean twin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffpatch-replace-'));
    try {
      const origin = join(dir, 'origin.git');
      await run('git', ['init', '--bare', '--initial-branch=main', origin]);
      const clone = join(dir, 'repo');
      await run('git', ['clone', '--quiet', origin, clone]);
      await run('git', ['-C', clone, 'config', 'user.email', 'test@localhost']);
      await run('git', ['-C', clone, 'config', 'user.name', 'test']);
      await writeFile(join(clone, 'base.txt'), 'base\n');
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'base']);
      const base = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
      // The TRUE resolution: carries distinguishable original content.
      await writeFile(join(clone, 'base.txt'), 'base\noriginal bytes\n');
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'the original resolution message']);
      const resolution = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
      // The ATTACK: a clean twin commit, swapped in behind refs/replace
      // (base tree + twin.txt via a TEMP index — the clone's own index
      // carries the original content and would leak it into the twin).
      const twinCopy = join(clone, 'twin.txt');
      await writeFile(twinCopy, 'base\nreplaced bytes\n');
      const baseTree = (
        await run('git', ['-C', clone, 'rev-parse', `${base}^{tree}`])
      ).stdout.trim();
      const twinIndex = join(dir, 'twin-index');
      const twinEnv = { env: { ...env, GIT_INDEX_FILE: twinIndex } };
      await run('git', ['-C', clone, 'read-tree', baseTree], twinEnv);
      await run('git', ['-C', clone, 'update-index', '--add', twinCopy], twinEnv);
      const twinTreeSha = (await run('git', ['-C', clone, 'write-tree'], twinEnv)).stdout.trim();
      const twin = (
        await run('git', [
          '-C',
          clone,
          'commit-tree',
          twinTreeSha,
          '-p',
          base,
          '-m',
          'an innocent twin message',
        ])
      ).stdout.trim();
      await run('git', ['-C', clone, 'replace', resolution, twin]);
      // CONTROL (the hazard is real): an UNHARDENED git diff sees the twin.
      const plain = await run('git', ['-C', clone, 'diff', '--unified=0', base, resolution]);
      expect(plain.stdout).toContain('replaced bytes');
      expect(plain.stdout).not.toContain('original bytes');
      // HARDENED: the effects read the TRUE objects.
      const effects = realMergeEffects({ repoRoot: clone });
      const patch = await effects.diffPatch(base, resolution);
      expect(patch.stdout).toContain('original bytes');
      expect(patch.stdout).not.toContain('replaced bytes');
      const message = await effects.readCommitMessage(resolution);
      expect(message.stdout).toContain('the original resolution message');
      expect(message.stdout).not.toContain('an innocent twin message');
      const parents = await effects.commitParents(resolution);
      expect(parents).toEqual({ ok: true, parents: [base] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// core.quotePath is PINNED on for the patch read (review P2 p52p, PR #1641)
// ---------------------------------------------------------------------------

describe('diffPatch pins core.quotePath=true over hostile repo config (review P2 p52p)', () => {
  test('a repo with quotePath=false still emits the C-quoted form; the path decodes and scans', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffpatch-quotepath-'));
    try {
      const origin = join(dir, 'origin.git');
      await run('git', ['init', '--bare', '--initial-branch=main', origin]);
      const clone = join(dir, 'repo');
      await run('git', ['clone', '--quiet', origin, clone]);
      await run('git', ['-C', clone, 'config', 'user.email', 'test@localhost']);
      await run('git', ['-C', clone, 'config', 'user.name', 'test']);
      // THE HOSTILE CONFIG: quotePath off (literal UTF-8 would otherwise
      // ride raw inside quoted paths).
      await run('git', ['-C', clone, 'config', 'core.quotePath', 'false']);
      await writeFile(join(clone, 'base.txt'), 'base\n');
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'base']);
      const base = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
      // The path: non-ASCII AND an escaped quote — quoting is forced
      // either way, and the pin decides the FORM.
      const tricky = join(clone, 'config');
      await mkdir(tricky, { recursive: true });
      const token = ['ghp', 'notarealtoken123456'].join('_');
      await writeFile(join(tricky, `café"note.txt`), `const token = "${token}";\n`);
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'add tricky path']);
      const resolution = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();

      const effects = realMergeEffects({ repoRoot: clone });
      const patch = await effects.diffPatch(base, resolution);
      expect(patch.code).toBe(0);
      // The PIN took effect: the header carries the octal-escaped é
      // (C-quoting), not the raw literal the repo config asked for.
      expect(patch.stdout).toContain('\\303\\251');
      expect(patch.stdout).not.toContain('café');
      // And the scan pipeline decodes it: the component path is the TRUE
      // path, so a path-scoped rule fires.
      const components = addedLineComponents(patch.stdout, 'probe');
      // One content component + one path component per added path (tOU-/sULl).
      expect(components).toHaveLength(2);
      expect(components[0]?.path).toBe('config/café"note.txt');
      const scans = scanComponents(components, [
        { id: 'config-token', description: 'd', regex: 'ghp_', path: '^config/' },
      ]);
      expect(scans[0]?.hits).toEqual([{ ruleId: 'config-token', lines: [1] }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('diffPatch pins --submodule=short over repo config (review P2 uVsr)', () => {
  test('diff.submodule=log cannot replace the unified header and hide an added gitlink pathname', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffpatch-submodule-'));
    try {
      const origin = join(dir, 'origin.git');
      await run('git', ['init', '--bare', '--initial-branch=main', origin]);
      const clone = join(dir, 'repo');
      await run('git', ['clone', '--quiet', origin, clone]);
      await run('git', ['-C', clone, 'config', 'user.email', 'test@localhost']);
      await run('git', ['-C', clone, 'config', 'user.name', 'test']);
      // THE HOSTILE CONFIG: `log` summaries in place of unified headers, and
      // submodule differences suppressed unless the flag overrides them.
      await run('git', ['-C', clone, 'config', 'diff.submodule', 'log']);
      await run('git', ['-C', clone, 'config', 'diff.ignoreSubmodules', 'all']);
      await writeFile(join(clone, 'base.txt'), 'base\n');
      await run('git', ['-C', clone, 'add', '-A']);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'base']);
      const base = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
      // An ADDED gitlink whose pathname is credential-shaped: with `log`
      // the whole diff is `Submodule GH_FOR_FA ...` and the scan sees no path.
      await run('git', [
        '-C',
        clone,
        'update-index',
        '--add',
        '--cacheinfo',
        '160000',
        base,
        'GH_FOR_FA',
      ]);
      await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'add gitlink']);
      const resolution = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();

      const effects = realMergeEffects({ repoRoot: clone });
      const patch = await effects.diffPatch(base, resolution);
      expect(patch.code).toBe(0);
      expect(patch.stdout).not.toContain('(new submodule)');
      expect(patch.stdout).toContain('+++ b/GH_FOR_FA');
      const components = addedLineComponents(patch.stdout, 'probe');
      expect(components.map((component) => component.component)).toContain('path GH_FOR_FA');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
