import { watch } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { describe, expect, test, vi } from 'vitest';
import { finding, fixture } from './addressWorker.helpers.js';

// Observe a complete atomic child receipt; worker completion bounds missing readiness.
function observeRunningCheck(directory: string) {
  let resolveReady!: (pid: number) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const watcher = watch(directory, (_event, name) => {
    if (name?.toString() !== 'ready') return;
    void readFile(join(directory, 'ready'), 'utf8')
      .then((text) => {
        const pid = Number(text);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid child readiness PID');
        resolveReady(pid);
      })
      .catch(rejectReady);
  });
  watcher.on('error', rejectReady);
  return {
    wait: (running: Promise<{ reason: string }>) =>
      Promise.race([
        ready,
        running.then((result) => {
          throw new Error(`worker ended before check readiness: ${result.reason}`);
        }),
      ]),
    close: () => watcher.close(),
  };
}

test('missing child readiness fails on the actual completed worker result', async () => {
  const directory = await realTmpDir('cq-no-check-readiness-');
  const f = await fixture(undefined, 'process.exitCode=1;');
  const observer = observeRunningCheck(directory);
  let running: ReturnType<typeof f.engine.fix> | undefined;
  try {
    running = f.engine.fix(finding(), 1);
    await expect(observer.wait(running)).rejects.toThrow(/worker ended before check readiness:/);
    expect((await running).commit).toBeUndefined();
    await expect(readFile(join(directory, 'ready'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    observer.close();
    await running;
    await f.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['baseline', 'related', 'broader'] as const)(
  'parent cancellation terminates the actual running %s check before restore and FIFO release',
  async (phase) => {
    const parent = new AbortController();
    const external = await realTmpDir('cq-running-check-');
    const marker = join(external, 'ready');
    // Count across the cached clean-parent preflight and the candidate checks.
    const wanted = { baseline: 1, related: 2, broader: 3 }[phase];
    const check = `
const fs = require('node:fs');
const countFile = ${JSON.stringify(join(external, 'check-count'))};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(n));
if (n === ${wanted}) {
  fs.writeFileSync(${JSON.stringify(marker + '.tmp')}, String(process.pid));
  fs.renameSync(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)});
  setInterval(() => {}, 1000);
}
`;
    const f = await fixture(undefined, check, { parentSignal: parent.signal });
    const observer = observeRunningCheck(external);
    let running: ReturnType<typeof f.engine.fix> | undefined;
    let pid: number | undefined;
    try {
      running = f.engine.fix(finding(), 1);
      pid = await observer.wait(running);
      let settled = false;
      void running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      parent.abort();
      // Independent of the five-second configured check timeout.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
      const result = await running;
      expect(result.commit).toBeUndefined();
      expect(result.reason).toContain('parent cancelled');
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      expect(f.repo.git('diff', '--cached', '--name-only', '-z')).toBe('');
      expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
      const calls = f.calls();
      expect((await f.engine.fix(finding('src/b.ts'), 1)).reason).toContain('parent cancelled');
      expect(f.calls()).toBe(calls);
    } finally {
      observer.close();
      parent.abort();
      await running;
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  },
);

describe('verification gate regressions', () => {
  test.each([
    ['oxlint-json', false],
    ['oxlint-json', true],
    ['test-narrow', false],
    ['test-narrow', true],
  ] as const)(
    'a fix using %s preserves baseline comparison (pre-existing=%s)',
    async (adapter, preExisting) => {
      const script = `const changed = ${preExisting} || require('node:fs').readFileSync('src/a.ts', 'utf8').includes('GOOD');
      if (${JSON.stringify(adapter)} === 'oxlint-json') console.log(JSON.stringify({number_of_files: 1, diagnostics: changed ? [{filename:'src/a.ts', message:'bad await', code:'typescript(await-thenable)', severity:'error', labels:[{span:{line:1,column:1}}]}] : []}));
      else { const report = {success:!changed,numTotalTests:1,numPassedTests:changed?0:1,numFailedTests:changed?1:0,testResults:[{name:'test/a.test.ts',status:changed?'failed':'passed',assertionResults:[{status:changed?'failed':'passed',fullName:'related regression'}]}]}; console.log('test:narrow report='+JSON.stringify(report)); console.log('test:narrow result='+JSON.stringify(changed?'fail':'pass')+' exit='+(changed?1:0)+' files=1 tests='+JSON.stringify(changed?'0/1':'1/1')+' failed='+(changed?1:0)); }
      process.exitCode=changed?1:0;`;
      const f = await fixture(undefined, script, {
        configure: (config) => {
          config.checks[0]!.adapter = adapter;
          config.checks[0]!.kind = adapter === 'test-narrow' ? 'tests' : 'static';
          config.checks[0]!.relatedArgs = ['scripts/check.cjs', '{files}'];
        },
      });
      try {
        const result = await f.engine.fix(finding(), 0);
        if (preExisting) {
          expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
        } else {
          expect(result.commit).toBeUndefined();
          expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        }
      } finally {
        await f.cleanup();
      }
    },
  );
});
