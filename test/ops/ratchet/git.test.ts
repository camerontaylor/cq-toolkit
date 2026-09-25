// W1.7 slice 3 — hermetic tests for src/ops/ratchet/git.ts.
//
// Real tmp git repos (no network). Pinned:
//   (a) tree extraction honours NO attributes: export-ignore, export-subst
//       and a smudge filter configured to run a marker-writing script are all
//       inert — every extracted file is byte-identical to its committed blob;
//   (b) a symlink (and a gitlink) is skipped and recorded, never written;
//   (c) repository-configured programs never run: diff.external,
//       core.fsmonitor; diff.mnemonicPrefix cannot change the a/ b/ prefixes;
//   (d) an option-shaped revision is rejected before any spawn;
//   (e) an absent path reads as null (a bad revision still throws);
//   (f) a rename is reported as delete + add.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  GIT_HARDEN,
  HARDENED_DIFF_FLAGS,
  assertRepoRelPath,
  extractTreeAttributeFree,
  gitChangedPaths,
  gitDiffText,
  gitMergeBase,
  gitReadBlob,
  gitRevParse,
} from '../../../src/ops/ratchet/git.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** Setup/assertion git (the module under test spawns its own). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, env: GIT_ENV });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** A script that records it ran by touching `marker`, then passes stdin through. */
function markerScript(dir: string, name: string, marker: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\ncat\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

let tmp: string;
let repo: string;
let marker: string;
let first: string;
let second: string;

const missingOid = '0123456789abcdef0123456789abcdef01234567';

const BINARY = Buffer.from([0, 1, 2, 0x0a, 0xff, 0xfe, 0x0a, 0x0a]);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-git-'));
  repo = join(tmp, 'repo');
  marker = join(tmp, 'MARKER');
  initRepo(repo);
  writeFileSync(
    join(repo, '.gitattributes'),
    'secret.ts export-ignore\nsub.ts export-subst\n*.ts filter=evil\n',
    'utf8',
  );
  writeFileSync(join(repo, 'secret.ts'), 'export const secret = 1;\n', 'utf8');
  writeFileSync(join(repo, 'sub.ts'), 'export const sha = "$Format:%H$";\n', 'utf8');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  writeFileSync(join(repo, 'src', 'deep', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(repo, 'src', 'old.ts'), 'export const old = 1;\n', 'utf8');
  writeFileSync(join(repo, 'bin.dat'), BINARY);
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n', 'utf8');
  chmodSync(join(repo, 'run.sh'), 0o755);
  symlinkSync('/etc/passwd', join(repo, 'link'));
  first = commitAll(repo, 'first');
  git(repo, ['mv', 'src/old.ts', 'src/new.ts']);
  writeFileSync(join(repo, 'src', 'deep', 'a.ts'), 'export const a = 2;\n', 'utf8');
  git(repo, ['add', '-A']);
  // A gitlink entry (mode 160000) without a real submodule, staged last so
  // `add -A` cannot drop it for its missing worktree directory.
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${first},vendor/sub`]);
  git(repo, ['commit', '-q', '-m', 'second']);
  second = git(repo, ['rev-parse', 'HEAD']).trim();

  // Hostile repository config, set AFTER the commits: every configured
  // program writes the marker if git ever runs it.
  git(repo, ['config', 'filter.evil.smudge', markerScript(tmp, 'smudge.sh', marker)]);
  git(repo, ['config', 'filter.evil.clean', markerScript(tmp, 'clean.sh', marker)]);
  git(repo, ['config', 'filter.evil.required', 'true']);
  git(repo, ['config', 'diff.external', markerScript(tmp, 'extdiff.sh', marker)]);
  git(repo, ['config', 'diff.mnemonicPrefix', 'true']);
  git(repo, ['config', 'diff.noprefix', 'true']);
  git(repo, ['config', 'color.diff', 'always']);
  git(repo, ['config', 'core.fsmonitor', markerScript(tmp, 'fsmonitor.sh', marker)]);
  git(repo, ['config', 'core.pager', markerScript(tmp, 'pager.sh', marker)]);
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('constants', { timeout: 30_000 }, () => {
  test('GIT_HARDEN and HARDENED_DIFF_FLAGS carry the closed-form hardening', () => {
    expect(GIT_HARDEN).toEqual([
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.quotePath=true',
    ]);
    for (const flag of [
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ]) {
      expect(HARDENED_DIFF_FLAGS).toContain(flag);
    }
  });
});

describe('extractTreeAttributeFree', { timeout: 30_000 }, () => {
  test('(a)(b) extracts every regular blob byte-identical, honouring no attributes', async () => {
    const dest = join(tmp, 'extract-first');
    const result = await extractTreeAttributeFree(repo, first, dest);
    const paths = git(repo, ['ls-tree', '-r', '--name-only', '-z', first])
      .split('\0')
      .filter((p) => p !== '' && p !== 'link');
    expect(result.files).toBe(paths.length);
    for (const path of paths) {
      const committed = gitBuffer(repo, ['cat-file', 'blob', `${first}:${path}`]);
      expect(readFileSync(join(dest, path)).equals(committed), path).toBe(true);
    }
    // export-ignore and export-subst are inert; the smudge filter never ran.
    expect(readFileSync(join(dest, 'secret.ts'), 'utf8')).toBe('export const secret = 1;\n');
    expect(readFileSync(join(dest, 'sub.ts'), 'utf8')).toContain('$Format:%H$');
    expect(readFileSync(join(dest, 'bin.dat')).equals(BINARY)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The symlink is recorded and never materialized.
    expect(result.skipped).toEqual([{ path: 'link', mode: '120000' }]);
    expect(existsSync(join(dest, 'link'))).toBe(false);
  });

  test('(b) a gitlink is skipped and recorded', async () => {
    const dest = join(tmp, 'extract-second');
    const result = await extractTreeAttributeFree(repo, second, dest);
    expect(result.skipped).toEqual([
      { path: 'link', mode: '120000' },
      { path: 'vendor/sub', mode: '160000' },
    ]);
    expect(existsSync(join(dest, 'vendor', 'sub'))).toBe(false);
    expect(readFileSync(join(dest, 'src', 'new.ts'), 'utf8')).toBe('export const old = 1;\n');
    expect(existsSync(marker)).toBe(false);
  });

  test('refuses a non-empty destination', async () => {
    const dest = join(tmp, 'extract-nonempty');
    mkdirSync(dest);
    writeFileSync(join(dest, 'x'), 'x', 'utf8');
    await expect(extractTreeAttributeFree(repo, first, dest)).rejects.toThrow(/not empty/);
  });

  test('accepts an existing empty destination', async () => {
    const dest = join(tmp, 'extract-empty');
    mkdirSync(dest);
    const result = await extractTreeAttributeFree(repo, first, dest);
    expect(result.files).toBeGreaterThan(0);
    expect(readdirSync(dest)).toContain('src');
  });

  test('refuses tracked node_modules at any depth before extracting files', async () => {
    const dependencyRepo = join(tmp, 'tracked-dependency-repo');
    initRepo(dependencyRepo);
    mkdirSync(join(dependencyRepo, 'src', 'node_modules', '@types', 'fake'), {
      recursive: true,
    });
    writeFileSync(
      join(dependencyRepo, 'src', 'node_modules', '@types', 'fake', 'index.d.ts'),
      'declare const trusted: never;\n',
    );
    const head = commitAll(dependencyRepo, 'head-controlled types');
    const dest = join(tmp, 'extract-tracked-dependency');
    await expect(extractTreeAttributeFree(dependencyRepo, head, dest)).rejects.toThrow(
      /refusing head-controlled node_modules path/,
    );
    expect(existsSync(dest)).toBe(false);
  });
});

describe('path validation', { timeout: 30_000 }, () => {
  test.each([
    ['/etc/passwd'],
    ['a/../b'],
    ['../x'],
    ['a//b'],
    ['./a'],
    ['.git/config'],
    ['sub/.GIT/hooks'],
    ['sub/.git. /x'],
    [':(glob)*'],
    ['a\\b'],
    ['a\nb'],
    [''],
  ])('refuses %j', (path) => {
    expect(() => assertRepoRelPath(path)).toThrow(/^ratchet git: refusing/);
  });

  test.each([['src/a.ts'], ['.github/workflows/ci.yml'], ['.gitattributes'], ['a/.gitkeep']])(
    'accepts %j',
    (path) => {
      expect(() => assertRepoRelPath(path)).not.toThrow();
    },
  );

  test('gitReadBlob rejects a traversal path before spawning', async () => {
    await expect(gitReadBlob(repo, first, '../outside')).rejects.toThrow(/dot segment/);
  });
});

describe('revision validation (d)', { timeout: 30_000 }, () => {
  const out = () => join(tmp, 'OPTION-OUTPUT');

  test.each([
    ['gitRevParse', () => gitRevParse(repo, `--output=${out()}`)],
    ['gitMergeBase', () => gitMergeBase(repo, first, `--output=${out()}`)],
    ['gitReadBlob', () => gitReadBlob(repo, `--output=${out()}`, 'secret.ts')],
    ['gitChangedPaths', () => gitChangedPaths(repo, `--output=${out()}`, second)],
    ['gitDiffText', () => gitDiffText(repo, first, `--output=${out()}`, [])],
    ['extract', () => extractTreeAttributeFree(repo, `--output=${out()}`, join(tmp, 'never'))],
  ])('%s rejects an option-shaped revision', async (_name, call) => {
    await expect(call()).rejects.toThrow(/refusing unsafe .* revision/);
    expect(existsSync(out())).toBe(false);
    expect(existsSync(join(tmp, 'never'))).toBe(false);
  });

  test.each([['main..HEAD'], ['HEAD@{1}'], ['HEAD^'], ['HEAD~1'], ['a b'], ['x.lock'], ['']])(
    'rejects revision syntax %j',
    async (rev) => {
      await expect(gitRevParse(repo, rev)).rejects.toThrow(/refusing unsafe/);
    },
  );
});

describe('reads', { timeout: 30_000 }, () => {
  test('gitRevParse resolves refs and oids to a 40-hex commit', async () => {
    expect(await gitRevParse(repo, 'main')).toBe(second);
    expect(await gitRevParse(repo, first)).toBe(first);
    await expect(gitRevParse(repo, 'no-such-branch')).rejects.toThrow(/^ratchet git: rev-parse/);
  });

  test('gitMergeBase', async () => {
    expect(await gitMergeBase(repo, first, second)).toBe(first);
  });

  test('(e) gitReadBlob: committed bytes, null when absent, throws on non-files', async () => {
    expect(await gitReadBlob(repo, first, 'sub.ts')).toBe('export const sha = "$Format:%H$";\n');
    expect(await gitReadBlob(repo, first, 'src/deep/a.ts')).toBe('export const a = 1;\n');
    expect(await gitReadBlob(repo, first, 'absent.ts')).toBeNull();
    expect(await gitReadBlob(repo, first, 'src/deep/absent.ts')).toBeNull();
    expect(await gitReadBlob(repo, second, 'src/old.ts')).toBeNull();
    await expect(gitReadBlob(repo, first, 'link')).rejects.toThrow(/not a regular file/);
    await expect(gitReadBlob(repo, first, 'src')).rejects.toThrow(/not a regular file/);
    await expect(gitReadBlob(repo, 'no-such-branch', 'sub.ts')).rejects.toThrow(
      /^ratchet git: ls-tree failed/,
    );
    await expect(gitReadBlob(repo, missingOid, 'sub.ts')).rejects.toThrow(/^ratchet git:/);
    expect(existsSync(marker)).toBe(false);
  });

  test('(c)(f) gitChangedPaths: rename as delete + add, no configured program runs', async () => {
    const paths = await gitChangedPaths(repo, first, second);
    expect(paths.sort()).toEqual(['src/deep/a.ts', 'src/new.ts', 'src/old.ts', 'vendor/sub']);
    expect(existsSync(marker)).toBe(false);
  });

  test('(c) gitDiffText: a/ b/ prefixes despite mnemonicPrefix/noprefix, no colour, no ext diff', async () => {
    const patch = await gitDiffText(repo, first, second, ['src/deep/a.ts']);
    expect(patch).toContain('--- a/src/deep/a.ts\n+++ b/src/deep/a.ts\n');
    expect(patch).toContain('-export const a = 1;\n+export const a = 2;\n');
    expect(patch).not.toContain('\u001b[');
    expect(patch).not.toContain('src/old.ts');
    expect(existsSync(marker)).toBe(false);
  });

  test('gitDiffText pathspecs are literal (no glob magic)', async () => {
    expect(await gitDiffText(repo, first, second, ['src/*'])).toBe('');
    expect(await gitDiffText(repo, first, second, [':(glob)src/**'])).toBe('');
    const all = await gitDiffText(repo, first, second, []);
    expect(all).toContain('b/src/new.ts');
  });
});
