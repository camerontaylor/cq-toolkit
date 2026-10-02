import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import type { FailureSet } from '../../../src/ops/gates/checkRunner.js';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { regressionGate } from '../../../src/ops/gates/regressionGate.js';
import { classifyStagePaths } from '../../../src/ops/sweep/unit.js';
import { isProtectedStagePath } from '../../../src/ops/gates/protectedPaths.js';
import { SWEEP_DIFF_FLAGS } from '../../../src/ops/sweep/internal/gitDiffFlags.js';

const execFileAsync = promisify(execFile);
const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

interface CorpusEntry {
  id: string;
  path: string;
  class: string;
  defaultDeny: string;
  baseOwned: string;
  modes: string[];
}
interface CorpusManifest {
  version: number;
  modes: string[];
  fixtures: CorpusEntry[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../../fixtures/tamper-corpus/manifest.json', import.meta.url), 'utf8'),
) as CorpusManifest;

/** Every path named by a fixture, including both sides of a rename. */
function pathsOf(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(
      /^(?:diff --git [aimw]\/(.+?) [aimw]\/(.+)|--- a\/(.+)|\+\+\+ b\/(.+)|rename from |rename to )(.+)?$/,
    );
    if (match) {
      for (const value of match.slice(1)) if (value !== undefined) paths.add(value);
    }
  }
  return [...paths];
}

function totalsFor(id: string): { base: FailureSet; final: FailureSet } {
  const base: FailureSet = {
    tool: 'vitest',
    failures: [],
    exitCode: 0,
    numTotalTests: 4,
    numPassedTests: 4,
    numSkippedTests: 0,
  };
  const final: FailureSet =
    id === 's29-count-drop'
      ? { ...base, numTotalTests: 3, numPassedTests: 3 }
      : { ...base, numPassedTests: 3, numSkippedTests: 1 };
  return { base, final };
}

describe('RS-10 tamper corpus contract', () => {
  test('computes every manifest verdict through the production stage/detector/regression gates', async () => {
    expect(manifest.version).toBe(1);
    expect(manifest.modes).toEqual(['default-deny', 'base-owned']);
    expect(manifest.fixtures).toHaveLength(39);
    expect(manifest.fixtures.filter((entry) => entry.id.startsWith('inherited-'))).toHaveLength(10);

    for (const entry of manifest.fixtures) {
      expect(entry.modes, entry.id).toEqual(manifest.modes);
      const fixturePath = new URL(`../../fixtures/tamper-corpus/${entry.path}`, import.meta.url);
      const diff = readFileSync(fixturePath, 'utf8');
      const paths = pathsOf(diff);
      expect(paths.length, entry.id).toBeGreaterThan(0);

      const stage = classifyStagePaths(paths);
      expect(stage.kind, entry.id).toBe('protected');
      expect('needs-human', entry.id).toBe(entry.defaultDeny);

      if (entry.class === 'totals') {
        const result = await regressionGate(totalsFor(entry.id));
        expect(result.status, entry.id).toBe('ok');
        expect(result.status === 'ok' && result.value.verdict, entry.id).toBe('regression');
        expect(entry.baseOwned, entry.id).toBe('regression');
        continue;
      }

      const detected = await hackDetector({ diff });
      expect(detected.status, entry.id).toBe('ok');
      const findings = detected.status === 'ok' ? detected.value : [];
      const computed = findings.some((finding) => finding.kind === 'protected-config')
        ? 'needs-human'
        : findings.length > 0
          ? 'tamper'
          : 'clean';
      expect(computed, entry.id).toBe(entry.baseOwned);
    }
  });

  test.each([
    '.husky/pre-commit',
    'vitest.workspace.ts',
    'vitest.workspace.json',
    'vitest.projects.ts',
  ])('protects Vitest workspace/project config: %s', (path) =>
    expect(isProtectedStagePath(path)).toBe(true),
  );

  test(
    'every manifest path is referenced exactly once and every diff is structurally valid',
    { timeout: 60_000 },
    () => {
      const referenced = new Set(manifest.fixtures.map((entry) => entry.path));
      const dir = new URL('../../fixtures/tamper-corpus/', import.meta.url);
      for (const entry of manifest.fixtures)
        expect(referenced.has(entry.path), entry.id).toBe(true);
      expect(referenced.size).toBe(manifest.fixtures.length);
      // git apply is deterministic and catches the malformed-line/count fixtures
      // that previously made corpus labels unfalsifiable.
      for (const path of referenced) {
        const url = new URL(path, dir);
        expect(() => readFileSync(url, 'utf8'), path).not.toThrow();
        expect(
          () =>
            execFileSync('git', ['apply', '--numstat', fileURLToPath(url)], {
              stdio: 'ignore',
            }),
          path,
        ).not.toThrow();
      }
    },
  );
});

describe('RS-10 detector and totals regressions', () => {
  test.each([
    "test.todo('later', () => {});",
    "test.fails('known failure', () => {});",
    "test.concurrent('parallel', () => {});",
    "test.skipIf(process.env.WIP)('conditional', () => {});",
    "test.runIf(process.env.CI)('conditional', () => {});",
    "xit('alias', () => {});",
    "fit('focus alias', () => {});",
    "test('node option', { skip: true }, () => {});",
    "test('node option', { skip: 'wip' }, () => {});",
  ])('flags a skip/only/focus idiom in test-land: %s', async (line) => {
    const result = await hackDetector({
      diff: [
        'diff --git a/test/attack.test.ts b/test/attack.test.ts',
        '--- a/test/attack.test.ts',
        '+++ b/test/attack.test.ts',
        '@@ -1 +1,2 @@',
        ' context();',
        `+${line}`,
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.some((f) => f.kind === 'new-skip-only')).toBe(
      true,
    );
  });

  test.each([
    'const skip = offset;',
    'todo: item,',
    "fit: 'cover',",
    'const result = layout.fit();',
  ])('does not treat production option-object/property text as a test marker: %s', async (line) => {
    const result = await hackDetector({
      diff: [
        'diff --git a/src/production.ts b/src/production.ts',
        '--- a/src/production.ts',
        '+++ b/src/production.ts',
        '@@ -1 +1,2 @@',
        ' context();',
        `+${line}`,
      ].join('\n'),
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('flags removed failing test declarations from a test hunk', async () => {
    const result = await hackDetector({
      diff: [
        'diff --git a/test/attack.test.ts b/test/attack.test.ts',
        '--- a/test/attack.test.ts',
        '+++ b/test/attack.test.ts',
        '@@ -1,1 +0,0 @@',
        "-it('fails today', () => {});",
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.some((f) => f.kind === 'removed-test')).toBe(
      true,
    );
  });

  test('a missing final total fails closed', async () => {
    const result = await regressionGate({
      base: { tool: 'vitest', failures: [], exitCode: 0, numTotalTests: 4 },
      final: { tool: 'vitest', failures: [], exitCode: 0 },
    });
    expect(result.status === 'ok' && result.value.totalsRegression).toMatch(/uncomputed/);
  });

  test(
    'real git: hostile binary/diff/textconv/external/noprefix config cannot hide staged test bytes',
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cq-tamper-git-'));
      CLEANUP.push(root);
      const git = async (args: string[]): Promise<string> => {
        const result = await execFileAsync('git', args, { cwd: root, timeout: 10_000 });
        return result.stdout;
      };
      await git(['init', '-q', '-b', 'main']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'diff.noprefix', 'true']);
      await git(['config', 'diff.mnemonicPrefix', 'true']);
      await git(['config', 'diff.external', 'false']);
      await git(['config', 'diff.hostile.textconv', 'false']);
      writeFileSync(
        join(root, 'victim.test.ts'),
        [
          "import { describe, expect, it } from 'vitest';",
          '',
          "describe('payment', () => {",
          "  it('never fails to charge the card once', () => {",
          '    expect(false).toBe(true);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      writeFileSync(join(root, '.gitattributes'), 'victim.test.ts -diff\n');
      await git(['add', '.']);
      await git(['commit', '-q', '-m', 'base']);
      writeFileSync(
        join(root, '.gitattributes'),
        // Last match wins per attribute, so the victim line comes after the
        // glob and `diff=hostile` after `binary`'s implied `-diff`.
        ['*.ts -diff', 'victim.test.ts binary diff=hostile', ''].join('\n'),
      );
      // The worker's actual target: remove the failing test declaration while
      // the hostile attributes would hide the edit. The verdict must identify
      // THIS path and its removed bytes, not merely the attributes file.
      writeFileSync(
        join(root, 'victim.test.ts'),
        [
          "import { describe, expect, it } from 'vitest';",
          '',
          "describe('payment', () => {",
          '});',
          '',
        ].join('\n'),
      );
      await git(['add', '.']);
      expect(await git(['check-attr', 'diff', '--', 'victim.test.ts'])).toBe(
        'victim.test.ts: diff: hostile\n',
      );
      // Negative control: without --no-textconv the hostile driver hides the
      // removed bytes, so the shared flags below are what expose them.
      const withTextconv = await git([
        'diff',
        '--cached',
        ...SWEEP_DIFF_FLAGS.filter((flag) => flag !== '--no-textconv'),
        '--',
      ]).catch(() => '');
      expect(withTextconv).not.toContain("-  it('never fails to charge the card once', () => {");

      const diff = await git(['diff', '--cached', ...SWEEP_DIFF_FLAGS, '--']);
      expect(diff).toContain('--- a/victim.test.ts');
      expect(diff).toContain('+++ b/victim.test.ts');
      expect(diff).toContain("-  it('never fails to charge the card once', () => {");
      expect(diff).not.toContain('Binary files');
      const paths = pathsOf(diff);
      expect(isProtectedStagePath('victim.test.ts')).toBe(true);
      const stage = classifyStagePaths(paths);
      expect(stage.kind).toBe('protected');
      expect(stage.paths).toContain('victim.test.ts');
      expect(stage.paths).toContain('.gitattributes');
      const detected = await hackDetector({ diff });
      expect(detected.status).toBe('ok');
      const findings = detected.status === 'ok' ? detected.value : [];
      expect(findings.some((finding) => finding.kind === 'protected-config')).toBe(true);
      expect(
        findings.some(
          (finding) => finding.kind === 'removed-test' && finding.file === 'victim.test.ts',
        ),
      ).toBe(true);
    },
  );

  test(
    'real git: a rename hiding a deleted test is split by the shared flags and refused by test identity',
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cq-tamper-git-rename-'));
      CLEANUP.push(root);
      const git = async (args: string[]): Promise<string> => {
        const result = await execFileAsync('git', args, { cwd: root, timeout: 10_000 });
        return result.stdout;
      };
      await git(['init', '-q', '-b', 'main']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await git(['config', 'user.name', 'Test']);
      // The worker wants rename detection ON so the deleted test hides inside
      // a "rename"; the shared production flags force --no-renames over any
      // repo config and explicit prefixes over noprefix.
      await git(['config', 'diff.renames', 'true']);
      await git(['config', 'diff.noprefix', 'true']);
      writeFileSync(join(root, 'auth.ts'), 'export const check = (): boolean => true;\n');
      writeFileSync(
        join(root, 'auth.test.ts'),
        [
          "import { expect, it } from 'vitest';",
          '',
          "it('rejects an expired token', () => {",
          '  expect(false).toBe(true);',
          '});',
          '',
        ].join('\n'),
      );
      await git(['add', '.']);
      await git(['commit', '-q', '-m', 'base']);
      await git(['mv', 'auth.test.ts', 'auth-utils.ts']);

      const diff = await git(['diff', '--cached', ...SWEEP_DIFF_FLAGS, '--']);
      expect(diff).toContain('--- a/auth.test.ts');
      expect(diff).toContain('+++ /dev/null');
      expect(diff).toContain('+++ b/auth-utils.ts');
      expect(diff).toContain("-it('rejects an expired token', () => {");
      expect(diff).not.toContain('rename ');

      const paths = pathsOf(diff);
      expect(paths).toContain('auth.test.ts');
      expect(paths).toContain('auth-utils.ts');
      const stage = classifyStagePaths(paths);
      expect(stage.kind).toBe('protected');
      expect(stage.paths).toContain('auth.test.ts');

      const detected = await hackDetector({ diff });
      expect(detected.status).toBe('ok');
      const findings = detected.status === 'ok' ? detected.value : [];
      expect(
        findings.some(
          (finding) => finding.kind === 'deleted-test-file' && finding.file === 'auth.test.ts',
        ),
      ).toBe(true);
      // Non-vacuous: no protected config path is staged here — the refusal
      // names the removed test itself, purely by test identity.
      expect(findings.some((finding) => finding.kind === 'protected-config')).toBe(false);
    },
  );
});
