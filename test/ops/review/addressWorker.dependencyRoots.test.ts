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
  test('binary lockfiles with different bytes refuse dependency reuse', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      // 0x80 and 0x81 both decode to U+FFFD as UTF-8; they must still differ.
      await writeFile(join(f.repo.root, 'bun.lockb'), Buffer.from([0x80]));
      f.repo.commitAll('binary lockfile');
      await writeFile(join(f.dependencyRoot, 'bun.lockb'), Buffer.from([0x81]));
      const result = await f.engine.fix(finding(), 1);
      expect(result.reason).toContain('manifests/locks differ');
      expect(f.calls()).toBe(0);
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
  test.each([
    'run-s build:*',
    'run-s build:dep?',
    'npm-run-all -p "build:*"',
    'run-s build:**:deps',
    'run-s "build:* --mode=production"',
    'run-s "build":deps',
    'run-s bu"ild:d"eps',
    'run-s build::deps',
    'run-s --max-parallel 2 build:deps',
  ])(
    'run-s pattern selection (%s) compares every script it names before dispatch',
    async (build) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const scripts = { postinstall: 'pnpm run build', build, 'build:deps': 'node deps.mjs' };
        await f.repo.write('package.json', JSON.stringify({ scripts }));
        f.repo.commitAll('pattern-selected install lifecycle metadata');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, 'build:deps': 'different installed files' } }),
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
  test.each([
    [
      'a shell boundary ends the task list',
      "run-s build:deps && printf '%s' 'docs:*'",
      'docs:lint',
    ],
    ['-- ends the task list', "run-s build:deps -- 'docs:*'", 'docs:lint'],
    ['a quoted -- ends the task list', "run-s build:deps '--' 'docs:*'", 'docs:lint'],
    ['printf operands are not a runner', "printf '%s' run-s 'docs:*'", 'docs:lint'],
    ['a redirection operand is not a task', "run-s build:deps > 'docs:*'", 'docs:lint'],
    ['an attached redirection operand is not a task', "run-s build:deps>'docs:*'", 'docs:lint'],
    ['fd redirections are not tasks', "run-s build:deps 2>&1 2> 'docs:*'", 'docs:lint'],
    ['* stays inside one segment', "run-s 'build:*'", 'build:docs:html'],
  ])(
    'runner selection: %s reuses dependencies when an unselected script changes',
    async (_name, postinstall, changed) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const scripts = {
          postinstall,
          'build:deps': 'node deps.mjs',
          'build:docs:html': 'node html.mjs',
          'docs:lint': 'node lint.mjs',
        };
        await f.repo.write('package.json', JSON.stringify({ scripts }));
        f.repo.commitAll('runner selection');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, [changed]: 'node different.mjs' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.commit, result.reason).toBeTruthy();
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    ['run-s build:deps', 'build::deps'],
    ["sh -c 'run-s build:*'", 'build:deps'],
    ["echo x\nrun-s 'build:*'", 'build:deps'],
    ["sh -c 'echo x;run-s build:*'", 'build:deps'],
    ["sh -c 'false || run-s build:*'", 'build:deps'],
    ["sh -c 'true||run-s build:*'", 'build:deps'],
    ["sh -c '(run-s build:*)'", 'build:deps'],
    ["run-s 'build:*'>/dev/null", 'build:deps'],
    ['run-s build:*>/dev/null', 'build:deps'],
    ['run-s build:* 2>/dev/null', 'build:deps'],
    ['run-s build:*&>/dev/null', 'build:deps'],
    ['run-s build:*>&2', 'build:deps'],
    ['sh -c \'"run-s" "build:*"\'', 'build:deps'],
    ["sh -c 'echo `run-s build:*`'", 'build:deps'],
    ['echo `run-s build:*`', 'build:deps'],
    ['sh -c \'bash -c "run-s build:*"\'', 'build:deps'],
    ['sh -c "sh -c \'run-s build:*\'"', 'build:deps'],
    ["sh -c './node_modules/.bin/run-s build:*'", 'build:deps'],
    ["run-s 'build:*'", 'build:other'],
    ['run-s "build:*"', 'build:other'],
    ['run-s build:**:other', 'build:other'],
    // Fail closed: anything outside the understood grammar compares every script.
    ['run\\-s build:deps', 'build:other'],
    ["run\\-s 'build:*'", 'build:deps'],
    ["x=run-s; $x 'build:*'", 'build:deps'],
    ["r=run-s; ${r} 'build:*'", 'build:deps'],
    ['x="run-s"; $x build:deps', 'build:other'],
    ["sh -c 'x=run-s; $x build:*'", 'build:deps'],
    ['A=1 run-s build:deps', 'build:other'],
    ['run-s build:deps # build:*', 'build:other'],
    ["env run-s 'build:*'", 'build:deps'],
    ["npx run-s 'build:*'", 'build:deps'],
    ['pnpm exec run-s build:deps', 'build:other'],
    ['sh -c run-s', 'build:deps'],
    ['pnpm run /build/', 'build:deps'],
    ['npm run build:deps -- extra', 'build:other'],
    ["concurrently 'npm:build:*'", 'build:deps'],
    ["if true; then run-s 'build:*'; fi", 'build:deps'],
    ['cd sub && run-s build:deps', 'build:other'],
    ['run-s --unknown build:deps', 'build:other'],
    ['run-s build:deps &', 'build:other'],
    ['run-s build:{deps,other}', 'build:other'],
    ['run-s build:deps <<EOF', 'build:other'],
    // Unknown programs: a script, runner or package manager named in an option value.
    ['node --run=build:deps', 'build:deps'],
    ['node --run build:deps', 'build:deps'],
    ['deno task build:deps', 'build:deps'],
    ['wireit --tasks=build:other,build:deps', 'build:deps'],
    ['node --run=npm:build:deps', 'build:deps'],
    ['tool --exec=run-s build:deps', 'build:other'],
    ['tool --exec=./node_modules/.bin/pnpm', 'build:deps'],
  ])('runner selection %s refuses reuse when only %s changes', async (postinstall, changed) => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        postinstall,
        'build:deps': 'node deps.mjs',
        'build::deps': 'node deps2.mjs',
        'build:other': 'node other.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('runner selection changed script');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, [changed]: 'node different.mjs' } }),
      );
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit).toBeUndefined();
      expect(result.reason).toContain('manifests/locks differ');
    } finally {
      await f.cleanup();
    }
  });
  test.each([
    ['node --run=a=b', 'a=b'],
    ['node --run=a,b', 'a,b'],
    ['node --run a=b', 'a=b'],
    ['wireit --tasks=x,a=b', 'a=b'],
    ['node --run=a::b=c', 'a:b=c'],
  ])(
    'script named in %s refuses reuse when %s, whose name has = or , changes',
    async (postinstall, changed) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const scripts = {
          postinstall,
          a: 'node a.mjs',
          b: 'node b.mjs',
          [changed]: 'node selected.mjs',
        };
        await f.repo.write('package.json', JSON.stringify({ scripts }));
        f.repo.commitAll('script name with = or ,');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, [changed]: 'node different.mjs' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.commit).toBeUndefined();
        expect(result.reason).toContain('manifests/locks differ');
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    ["run-s 'build:[ab]'", 'build:a'],
    ["run-s 'build:**'", 'build:docs:html'],
  ])(
    'runner pattern %s refuses reuse when a script it selects changes',
    async (postinstall, changed) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        const scripts = {
          postinstall,
          'build:a': 'node a.mjs',
          'build:docs:html': 'node html.mjs',
        };
        await f.repo.write('package.json', JSON.stringify({ scripts }));
        f.repo.commitAll('runner pattern selection');
        await writeFile(
          join(f.dependencyRoot, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, [changed]: 'node different.mjs' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.commit).toBeUndefined();
        expect(result.reason).toContain('manifests/locks differ');
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a catastrophic-backtracking runner pattern still resolves and compares scripts', async () => {
    // The changed script is selected only by the wildcard pattern (no literal task names
    // it), so the mismatch exists only if wildcard matching resolves; the all-`a` name
    // is the nonmatching input that makes backtracking matchers blow up.
    const selected = `${'a'.repeat(64)}b`;
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        postinstall: `run-s *a*a*a*a*a*a*a*a*a*a*a*a*b`,
        ['a'.repeat(64)]: 'node long.mjs',
        [selected]: 'node selected.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('pathological runner pattern');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, [selected]: 'different installed files' } }),
      );
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit).toBeUndefined();
      expect(result.reason).toContain('manifests/locks differ');
    } finally {
      await f.cleanup();
    }
  }, 10_000);
  test('adversarial quoting and redirection in a long command lexes in linear time', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        // Thousands of quoted words and redirections, then a real runner invocation.
        postinstall: `echo ${'"a" \'b\' 2>&1 >x '.repeat(4000)}; run-s build:*`,
        'build:deps': 'node deps.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('adversarial lexer input');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, 'build:deps': 'different deps' } }),
      );
      const started = Date.now();
      const result = await f.engine.fix(finding(), 1);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.commit).toBeUndefined();
      expect(result.reason).toContain('manifests/locks differ');
    } finally {
      await f.cleanup();
    }
  }, 10_000);
  test('a long simple command lexes in linear time and still narrows the selection', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        // Every fragment is inside the grammar, so the whole command is scanned and
        // resolved: the runner selects build:*, and the unselected docs:lint may change.
        postinstall: `echo ${'"a" \'b\' 2>&1 >x '.repeat(20000)}; run-s 'build:*'`,
        'build:deps': 'node deps.mjs',
        'docs:lint': 'node lint.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('long simple lexer input');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, 'docs:lint': 'node different.mjs' } }),
      );
      const started = Date.now();
      const result = await f.engine.fix(finding(), 1);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.commit, result.reason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  }, 10_000);
  test('shell-expanded run-s tasks stay unresolved so every script is compared', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const scripts = {
        postinstall: 'pnpm run build',
        build: 'run-s build:$TASK*',
        'build:deps': 'node deps.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('shell-expanded install task');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, 'build:deps': 'different deps' } }),
      );
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit).toBeUndefined();
      expect(result.reason).toContain('manifests/locks differ');
      expect(f.calls()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test('many globstars against a long nonmatching script name finish promptly', async () => {
    const f = await fixture(undefined, '', { installedDependencies: 'matching' });
    try {
      const longName = `${'a:'.repeat(60)}x`;
      const scripts = {
        postinstall: 'pnpm run build',
        build: 'run-s "**:**:**:**:**:**:b"',
        [longName]: 'node long.mjs',
      };
      await f.repo.write('package.json', JSON.stringify({ scripts }));
      f.repo.commitAll('many globstars');
      await writeFile(
        join(f.dependencyRoot, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, [longName]: 'different long' } }),
      );
      const started = Date.now();
      const result = await f.engine.fix(finding(), 1);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.commit, result.reason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });
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
