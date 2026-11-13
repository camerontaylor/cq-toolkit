import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address candidate isolation', () => {
  test.each(['caller', 'worker'] as const)(
    'candidate refuses workspace links into %s source before check execution',
    async (workspaceDependency) => {
      const f = await fixture(undefined, '', {
        installedDependencies: 'matching',
        workspaceDependency,
      });
      try {
        const result = await f.engine.fix(finding(), 1);
        expect(result.commit).toBeUndefined();
        expect(result.finding.status).toBe('deferred');
        expect(result.reason).toMatch(/dependency.*checkout source/);
        await expect(readFile(f.dependencyCheckMarker)).rejects.toThrow(/ENOENT/);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      } finally {
        await f.cleanup();
      }
    },
  );

  test.each(['mismatched', 'missing'] as const)(
    'explicit prepared root refusal: %s',
    async (mode) => {
      const f = await fixture(undefined, '', {
        installedDependencies: mode === 'mismatched' ? 'mismatched' : 'matching',
        preferDependencyRoot: true,
      });
      try {
        if (mode === 'missing')
          await rm(join(f.dependencyRoot, 'node_modules'), { recursive: true });
        const result = await f.engine.fix(finding(), 1);
        const reason =
          mode === 'missing'
            ? 'prepared dependency root has no node_modules'
            : 'prepared dependency root manifests/locks differ';
        expect(result.commit).toBeUndefined();
        expect(result.reason).toContain(reason);
        expect(result.reason).not.toContain('install dependencies in the PR worktree');
        expect(f.engine.preconditions?.()[0]).toMatchObject({
          kind: 'deterministic',
          scope: 'leg',
          stage: 'dependencies',
        });
        expect(f.engine.preconditions?.()[0]?.reason).toContain(reason);
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('prepared dependencies retain dev yaml for a PR predating its runtime move', async () => {
    const f = await fixture(undefined, '', {
      installedDependencies: 'matching',
      preferDependencyRoot: true,
    });
    try {
      await f.repo.write('.gitignore', 'node_modules/\n');
      // An inherited clone-local tree must not shadow the explicit prepared root.
      await mkdir(join(f.repo.root, 'node_modules'), { recursive: true });
      await writeFile(join(f.repo.root, 'node_modules/check.cjs'), 'process.exitCode = 1;\n');
      const old = JSON.stringify({ devDependencies: { yaml: '2.9.1' } });
      await f.repo.write('package.json', old);
      f.repo.commitAll('older PR metadata');
      await writeFile(join(f.dependencyRoot, 'package.json'), old);
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
      expect(await readFile(join(f.dependencyRoot, 'package.json'), 'utf8')).toBe(old);
      expect(await readFile(join(f.dependencyRoot, 'node_modules/check.cjs'), 'utf8')).toBe(
        'process.exitCode = 0;\n',
      );
    } finally {
      await f.cleanup();
    }
  });
  test.each(['matching', 'mismatched'] as const)(
    'fresh worker tree reuses installed caller dependencies only with matching metadata: %s',
    async (installedDependencies) => {
      const f = await fixture(undefined, '', { installedDependencies });
      try {
        const result = await f.engine.fix(finding(), 1);
        if (installedDependencies === 'matching') {
          expect(result.commit, result.reason).toBeTruthy();
          expect(result.validation.every((gate) => gate.verdict === 'pass')).toBe(true);
        } else {
          expect(result.commit).toBeUndefined();
          expect(result.reason).toContain('manifests/locks differ');
          expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  test('script and descriptive metadata differences reuse equivalent dependencies', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'caller', version: '2.0.0', scripts: { build: 'another build' } }),
      );
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });
  test.each(['preinstall', 'install', 'postinstall', 'prepare', 'pnpm:devPreinstall'])(
    'changed %s lifecycle refuses dependency reuse before model dispatch',
    async (hook) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { [hook]: 'modify-installed-files' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.reason).toContain('manifests/locks differ');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([true, false])(
    'install hooks compare indirectly invoked scripts (changed=%s)',
    async (changed) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const manifest = {
          scripts: { postinstall: 'pnpm run build', build: 'prepare installed files' },
        };
        await f.repo.write('package.json', JSON.stringify(manifest));
        f.repo.commitAll('install lifecycle metadata');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({
            scripts: {
              ...manifest.scripts,
              build: changed ? 'different installed files' : manifest.scripts.build,
            },
          }),
        );
        const result = await f.engine.fix(finding(), 1);
        if (changed) {
          expect(result.reason).toContain('manifests/locks differ');
          expect(f.calls()).toBe(0);
        } else expect(result.commit, result.reason).toBeTruthy();
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    ['transitive', 'npm run compile', 'compile'],
    ['npm run-script', 'npm run-script compile', 'compile'],
    ['quoted npm script', 'npm run "compile"', 'compile'],
    ['pnpm run', 'pnpm run compile', 'compile'],
    ['pnpm shorthand', 'pnpm compile', 'compile'],
    ['yarn run', 'yarn run compile', 'compile'],
    ['yarn shorthand', 'yarn compile', 'compile'],
    ['bun run', 'bun run compile', 'compile'],
    ['bun shorthand', 'bun compile', 'compile'],
    ['path-qualified run-s', './node_modules/.bin/run-s compile', 'compile'],
    ['npm argument', 'concurrently "npm:compile"', 'compile'],
    ['runner options', 'pnpm --silent run compile', 'compile'],
    ['workspace runner', 'yarn workspace pkg compile', 'compile'],
    ['quoted shell command', "sh -c 'npm run compile'", 'compile'],
    ['hook', 'node build.mjs', 'prebuild'],
    ['hook dependency', 'node build.mjs', 'compile'],
    ['cycle', 'npm run compile', 'compile'],
    ['shell indirection', 'script=compile; npm run "$script"', 'compile'],
  ])(
    'install hooks compare reachable scripts through %s before dispatch',
    async (mode, build, changed) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const scripts = {
          postinstall: 'pnpm run build',
          build,
          prebuild: mode === 'hook dependency' ? 'pnpm compile' : 'node prebuild.mjs',
          compile: mode === 'cycle' ? 'pnpm run build' : 'node compile.mjs',
        };
        await f.repo.write('package.json', JSON.stringify({ scripts }));
        f.repo.commitAll('transitive install lifecycle metadata');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, [changed]: 'different installed files' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.commit).toBeUndefined();
        expect(result.reason).toContain('manifests/locks differ');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a --check argument is not an invocation of the check script', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        postinstall: 'pnpm run build',
        build: 'node scripts/build.mjs --check',
        check: 'node check.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('install command with unrelated check argument');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, check: 'node different-check.mjs' } }),
      );
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });
  test('unchanged cyclic install script graph terminates and reuses dependencies', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const manifest = JSON.stringify({
        scripts: { postinstall: 'pnpm run build', build: 'pnpm compile', compile: 'npm run build' },
      });
      await f.repo.write('package.json', manifest);
      f.repo.commitAll('cyclic install lifecycle metadata');
      await writeFile(join(f.dependencyRoot, 'package.json'), manifest);
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });
  test.each([
    ['dependencies', { dep: '1' }],
    ['devDependencies', { dep: '1' }],
    ['optionalDependencies', { dep: '1' }],
    ['peerDependencies', { dep: '1' }],
    ['pnpm', { overrides: { dep: '1' } }],
    ['packageManager', 'pnpm@10.0.0'],
    ['installConfig', { hoistingLimits: 'workspaces' }],
    ['dependencies', null],
    ['pnpm', []],
  ])(
    'changed or ambiguous dependency metadata refuses before dispatch: %s=%j',
    async (key, value) => {
      const f = await fixture(undefined, '', {
        installedDependencies: 'matching',
        workerAttempts: 10,
        rescueBase: 10,
      });
      try {
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ [key as string]: value }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.reason).toContain('baseline precondition failed');
        expect(result.commit).toBeUndefined();
        expect(f.calls()).toBe(0);
        expect(f.attempts).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
  );

  test.each(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])(
    'changed %s refuses dependency reuse',
    async (path) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        await writeFile(join(f.dependencyRoot, path), 'changed: true\n');
        const result = await f.engine.fix(finding(), 1);
        expect(result.reason).toContain('manifests/locks differ');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
});
