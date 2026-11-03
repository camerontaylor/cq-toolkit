import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as checkRunner from '../../../src/ops/gates/checkRunner.js';
import { makeRepoDiffScanner } from '../../../src/ops/dev/denylist.js';
import { finding, fixture } from './addressWorker.helpers.js';

describe('baseline failure scope and reuse', () => {
  test.each([75, null])(
    'transient baseline exit %s retries checks once, leaves siblings usable',
    async (exit) => {
      const external = await mkdtemp(join(tmpdir(), 'cq-transient-baseline-'));
      const count = join(external, 'count');
      const recovered = join(external, 'recovered');
      const timeoutCapture =
        exit === null
          ? vi
              .spyOn(checkRunner, 'subprocessRunCheck')
              .mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: null })
              .mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: null })
          : undefined;
      const f = await fixture(
        undefined,
        `
const fs = require('node:fs'); const p = ${JSON.stringify(count)};
fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 0) + 1));
if (!fs.existsSync(${JSON.stringify(recovered)})) {
  ${exit === null ? 'setInterval(() => {}, 1000);' : 'console.log(\'test:narrow result="refused" exit=75 reason="low memory"\'); process.exitCode = 75;'}
}
`,
        {
          workerAttempts: 10,
          rescueBase: 10,
        },
      );
      try {
        const a = await f.engine.fix(finding(), 1);
        expect(a.reason).toContain('transient baseline failed');
        if (timeoutCapture) {
          expect(timeoutCapture).toHaveBeenCalledTimes(2);
          timeoutCapture.mockRestore();
        } else expect(await readFile(count, 'utf8')).toBe('2');
        expect(f.calls()).toBe(0);
        expect(f.engine.preconditionFailure?.()).toBeUndefined();
        expect(f.engine.preconditions?.()).toMatchObject([{ kind: 'transient', scope: 'leg' }]);
        await writeFile(recovered, 'yes');
        const b = await f.engine.fix(finding('src/b.ts'), 1);
        expect(b.commit, b.reason).toBeTruthy();
        expect(f.attempts.filter((a) => a.invocation === 'edit')).toHaveLength(1);
      } finally {
        timeoutCapture?.mockRestore();
        await f.cleanup();
        await rm(external, { recursive: true, force: true });
      }
    },
  );
  test('a transient baseline can recover on its single check retry before model dispatch', async () => {
    const external = await mkdtemp(join(tmpdir(), 'cq-recover-baseline-'));
    const count = join(external, 'count');
    const f = await fixture(
      undefined,
      `const fs = require('node:fs'); const p = ${JSON.stringify(count)};
const n = Number(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 0) + 1; fs.writeFileSync(p, String(n));
if(n === 1) process.exitCode=75;`,
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
      expect(await readFile(count, 'utf8')).toBe('4');
      expect(f.attempts.filter((a) => a.invocation === 'edit')).toHaveLength(1);
      expect(f.engine.preconditions?.()).toEqual([]);
    } finally {
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  });
  const narrowPass = `console.log('test:narrow report='+JSON.stringify({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,testResults:[{name:'test/a.test.ts',status:'passed',assertionResults:[{status:'passed'}]}]}));
console.log('test:narrow result="pass" exit=0 files=1 tests="1/1" failed=0');`;
  test.each([2, 75])(
    'finding-scoped narrow refusal exit %s does not stop a healthy sibling',
    async (exit) => {
      const f = await fixture(
        undefined,
        `if(process.argv.at(-1)==='src/a.ts') {
console.log('test:narrow result="refused" exit=${exit} reason="${exit === 75 ? 'low memory' : 'unmapped module'}"'); process.exitCode=${exit};
} else { ${narrowPass} }`,
        {
          workerAttempts: 10,
          rescueBase: 10,
          configure: (c) => {
            c.checks[0]!.adapter = 'test-narrow';
            c.checks[0]!.kind = 'tests';
            c.checks[0]!.relatedArgs = ['scripts/check.cjs', '{files}'];
          },
        },
      );
      try {
        const a = await f.engine.fix(finding(), 1);
        expect(a.commit).toBeUndefined();
        expect(f.engine.preconditionFailure?.()).toBeUndefined();
        expect(f.engine.preconditions?.()).toMatchObject([
          {
            kind: exit === 75 ? 'transient' : 'deterministic',
            scope: 'finding',
            stage: 'check',
            finding: 'src/a.ts',
          },
        ]);
        const b = await f.engine.fix(finding('src/b.ts'), 1);
        expect(b.commit, b.reason).toBeTruthy();
        expect(f.attempts.filter((a) => a.finding === 'src/a.ts')).toHaveLength(1);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a rejected finding needs no finding-scoped baseline or mapping', async () => {
    const f = await fixture(
      async (input) =>
        input.outputSchema?.name === 'review.address.closure/v1'
          ? { closed: true, reason: 'false positive confirmed' }
          : {
              disposition: 'rejected',
              reason: 'false positive',
              evidence: [{ path: 'src/a.ts', line: 1 }],
            },
      'throw new Error("scoped checks must not execute for rejection");',
      {
        configure: (c) => {
          c.checks[0]!.addressOnly = true;
        },
      },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status, result.reason).toBe('rejected');
      expect(f.calls()).toBe(2);
      expect(f.engine.preconditions?.()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('baseline results are reused across retries at the same parent', async () => {
    const external = await mkdtemp(join(tmpdir(), 'cq-cache-baseline-'));
    const count = join(external, 'count');
    let closures = 0;
    const f = await fixture(
      async (input) => {
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: ++closures > 1, reason: 'closure check' };
        if (input.prompt.includes('initial task') || input.prompt.includes('worker retry'))
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        return { disposition: 'fixed', reason: 'fixed', evidence: [] };
      },
      `const fs = require('node:fs'); const p=${JSON.stringify(count)};
fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 0)+1));`,
      { workerAttempts: 2 },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit, result.reason).toBeTruthy();
      expect(await readFile(count, 'utf8')).toBe('5');
      expect(f.attempts.filter((a) => a.invocation === 'edit')).toHaveLength(2);
    } finally {
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  });
  test('baseline cache is invalidated by an engine sibling commit', async () => {
    const external = await mkdtemp(join(tmpdir(), 'cq-parent-baseline-'));
    const count = join(external, 'count');
    const f = await fixture(
      undefined,
      `const fs=require('node:fs');const p=${JSON.stringify(count)};
fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));`,
    );
    try {
      expect((await f.engine.fix(finding(), 1)).commit).toBeTruthy();
      expect((await f.engine.fix(finding('src/b.ts'), 1)).commit).toBeTruthy();
      expect(await readFile(count, 'utf8')).toBe('6');
    } finally {
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  });
  test('indeterminate baseline retains bounded child diagnostics', async () => {
    const f = await fixture(
      undefined,
      `console.log('x'.repeat(5000)); console.error('refused selection'); process.exitCode=2;`,
    );
    try {
      await f.engine.fix(finding(), 1);
      expect(f.engine.preconditions?.()[0]?.checkDiagnostics).toEqual({
        exitCode: 2,
        signal: null,
        stdoutTail: 'x'.repeat(4095) + '\n',
        stderrTail: 'refused selection\n',
      });
      expect(f.calls()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test('indeterminate baseline with unavailable secret scan withholds output', async () => {
    const f = await fixture(undefined, `console.log('private output'); process.exitCode=2;`, {
      scanner: async () => {
        throw new Error('scanner unavailable');
      },
    });
    try {
      await f.engine.fix(finding(), 1);
      expect(f.engine.preconditions?.()[0]?.checkDiagnostics).toEqual({
        exitCode: 2,
        signal: null,
        stdoutTail: '[withheld: scanner unavailable/failed]',
        stderrTail: '[withheld: scanner unavailable/failed]',
      });
    } finally {
      await f.cleanup();
    }
  });
  test.each([false, true])(
    'real repository rules retain benign output and withhold secrets (%s)',
    async (secret) => {
      const text = secret
        ? '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'
        : 'related test selection exceeds cap 10: 22 files';
      const f = await fixture(
        undefined,
        `console.log(${JSON.stringify(text)});process.exitCode=2;`,
        {
          scanner: makeRepoDiffScanner(process.cwd()),
        },
      );
      try {
        await f.engine.fix(finding(), 1);
        expect(f.engine.preconditions?.()[0]?.checkDiagnostics?.stdoutTail).toBe(
          secret ? '[withheld: secret matched]' : text + '\n',
        );
      } finally {
        await f.cleanup();
      }
    },
  );
  test('candidate check failures do not scan discarded diagnostics', async () => {
    let scans = 0;
    const f = await fixture(
      undefined,
      `if(require('node:fs').readFileSync('src/a.ts','utf8').includes('GOOD'))process.exitCode=2;`,
      {
        scanner: async (components) => {
          if (components.some((c) => c.component === 'check-stdout')) scans++;
          return components.map((c) => ({ component: c.component, hits: [] }));
        },
      },
    );
    try {
      await f.engine.fix(finding(), 1);
      expect(f.calls()).toBeGreaterThan(0);
      expect(scans).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test('diagnostic scan observes cancellation', async () => {
    const controller = new AbortController();
    const f = await fixture(undefined, `process.exitCode=2;`, {
      parentSignal: controller.signal,
      scanner: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.commit).toBeUndefined();
      expect(f.engine.preconditions?.()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test.each([
    { remaining: 12_000, step: 20_000, expected: 12_000 },
    { remaining: 20_000, step: 7000, expected: 7000 },
    { remaining: 60_000, step: 60_000, expected: 30_000 },
  ])(
    'diagnostic scan timeout follows budgets with a 30s ceiling (%j)',
    async ({ remaining, step, expected }) => {
      let timeout: number | undefined;
      const f = await fixture(undefined, `process.exitCode=2;`, {
        remainingWallMs: () => remaining,
        unitWallMs: 120_000,
        configure: (config) => {
          config.budgets!.step!.wallMs = step;
        },
        scanner: async (components, options) => {
          timeout = options?.timeoutMs;
          return components.map((c) => ({ component: c.component, hits: [] }));
        },
      });
      try {
        await f.engine.fix(finding(), 1);
        expect(timeout).toBe(expected);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('unresponsive diagnostic scan is bounded', async () => {
    const f = await fixture(undefined, `process.exitCode=2;`, {
      configure: (config) => {
        config.budgets!.step!.wallMs = 1000;
      },
      scanner: () => new Promise(() => {}),
    });
    try {
      await f.engine.fix(finding(), 1);
      expect(f.engine.preconditions?.()[0]?.checkDiagnostics?.stdoutTail).toBe(
        '[withheld: scanner unavailable/failed]',
      );
    } finally {
      await f.cleanup();
    }
  });
  test('indeterminate baseline retains signal after transient retry', async () => {
    const f = await fixture(undefined, `process.kill(process.pid, 'SIGTERM');`);
    try {
      await f.engine.fix(finding(), 1);
      expect(f.engine.preconditions?.()[0]?.checkDiagnostics).toMatchObject({
        exitCode: null,
        signal: 'SIGTERM',
        stdoutTail: '',
        stderrTail: '',
      });
    } finally {
      await f.cleanup();
    }
  });
  test('positive secret scan withholds indeterminate child output', async () => {
    const f = await fixture(undefined, `console.log('sensitive output'); process.exitCode=2;`, {
      scanner: async (components) =>
        components.map((c) => ({
          component: c.component,
          hits: [{ ruleId: 'test', lines: [1] }],
        })),
    });
    try {
      await f.engine.fix(finding(), 1);
      expect(f.engine.preconditions?.()[0]?.checkDiagnostics?.stdoutTail).toBe(
        '[withheld: secret matched]',
      );
    } finally {
      await f.cleanup();
    }
  });
  test('baseline cleanup failure preserves the original typed cause', async () => {
    const f = await fixture(undefined, 'process.exitCode=1;', {
      gitHook: (args, run) =>
        args.includes('worktree') &&
        args.includes('remove') &&
        args.some((a) => a.includes('baseline-'))
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'cleanup unavailable' })
          : run(args),
    });
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.reason).toContain('configured check was indeterminate');
      expect(result.reason).toContain('cleanup unavailable');
      const cause = f.engine.preconditions?.()[0];
      expect(cause?.stage).toBe('check');
      expect(cause?.reason).toContain('configured check was indeterminate');
      expect(cause?.cleanupError).toContain('cleanup unavailable');
      expect(f.calls()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test.each(['.npmrc', '.yarnrc.yml', 'bunfig.toml'])(
    'dependency reuse compares %s without exposing its contents',
    async (path) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        await writeFile(
          join(f.dependencyRoot, path),
          'registry=https://different.example.invalid/',
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.reason).toContain('manifests/locks differ');
        expect(result.reason).not.toContain('different.example.invalid');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each(['pnpm', 'npm'])(
    'dependency reuse checks %s workspace member lifecycle scripts',
    async (manager) => {
      const f = await fixture(undefined, '', { installedDependencies: 'matching' });
      try {
        if (manager === 'pnpm') {
          await f.repo.write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
          await writeFile(
            join(f.dependencyRoot, 'pnpm-workspace.yaml'),
            'packages:\n  - "packages/*"\n',
          );
        } else {
          await f.repo.write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
          await writeFile(
            join(f.dependencyRoot, 'package.json'),
            JSON.stringify({ workspaces: ['packages/*'] }),
          );
        }
        await f.repo.write(
          'packages/lib/package.json',
          JSON.stringify({ name: 'lib', scripts: { postinstall: 'original install' } }),
        );
        f.repo.commitAll('workspace metadata');
        await mkdir(join(f.dependencyRoot, 'packages/lib'), { recursive: true });
        await writeFile(
          join(f.dependencyRoot, 'packages/lib/package.json'),
          JSON.stringify({ name: 'lib', scripts: { postinstall: 'different install' } }),
        );
        const result = await f.engine.fix(finding(), 1);
        expect(result.reason).toContain('manifests/locks differ');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
});
