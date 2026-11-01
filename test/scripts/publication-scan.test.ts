import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const available = spawnSync('gitleaks', ['version']).status === 0;
describe.skipIf(!available)('publication scans of outgoing git objects', () => {
  function replay(
    action: (root: string, git: (...args: string[]) => string, scan: () => number | null) => void,
  ) {
    const root = mkdtempSync(join(tmpdir(), 'publication-replay-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'policy/denylist'), { recursive: true });
      copyFileSync(resolve('scripts/denylist-scan'), join(root, 'scripts/denylist-scan'));
      copyFileSync(
        resolve('policy/denylist/patterns.yml'),
        join(root, 'policy/denylist/patterns.yml'),
      );
      git('init', '-q');
      git('config', 'user.name', 'Replay');
      git('config', 'user.email', 'replay@example.invalid');
      git('commit', '--allow-empty', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(root, 'safe.txt'), 'safe content\n');
      git('add', 'safe.txt');
      git('commit', '-qm', 'safe change');
      action(
        root,
        git,
        () =>
          spawnSync(process.execPath, [join(root, 'scripts/denylist-scan'), '--base', base], {
            encoding: 'utf8',
          }).status,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test.each([254, 300, 324, 486])(
    '#%i: retained untracked and ignored evidence permits publication',
    () => {
      replay((root, git, scan) => {
        const dirty = ['port', 'key'].join('');
        writeFileSync(join(root, 'scratch.txt'), dirty);
        writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
        writeFileSync(join(root, 'ignored.txt'), dirty);
        writeFileSync(join(root, 'safe.txt'), dirty); // tracked working-tree edits also excluded
        git('config', 'core.autocrlf', 'true');
        git('config', 'include.path', join(root, 'absent-config'));
        expect(scan()).toBe(0);
      });
    },
  );

  test('a force-push whose previous tip is unavailable still publishes', () => {
    replay((root, git) => {
      git('update-ref', 'refs/remotes/origin/main', git('rev-list', '--max-parents=0', 'HEAD'));
      const template = readFileSync(resolve('policy/templates/denylist.yml'), 'utf8');
      const step = template.slice(template.indexOf('      - name: Denylist outgoing commit scan'));
      const script = step
        .split('        run: |\n')[1]
        ?.split('      - name:')[0]
        ?.replace(/^ {10}/gm, '');
      if (!script) throw new Error('outgoing scan workflow step missing');
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          SCAN_BASE: 'f'.repeat(40),
          DEFAULT_BRANCH: 'main',
          GITHUB_REF: 'refs/heads/feature',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('outgoing scan clean (1 commits; trees and messages)');
    });
  });

  test('an intermediate secret removed from the final tree still refuses publication', () => {
    replay((root, git, scan) => {
      writeFileSync(join(root, 'temporary.txt'), ['port', 'key'].join(''));
      git('add', 'temporary.txt');
      git('commit', '-qm', 'temporary content');
      git('rm', 'temporary.txt');
      git('commit', '-qm', 'remove temporary content');
      expect(scan()).toBe(1);
    });
  });

  test('a commit message is scanned even with an unchanged tree', () => {
    replay((_root, git, scan) => {
      git('commit', '--allow-empty', '-qm', ['port', 'key'].join(''));
      expect(scan()).toBe(1);
    });
  });
});
