// Policy of the one permitted local test command (scripts/lib/test-narrow.mjs):
// argv refusals, the run plan (fallback, class gate, file cap), the stable
// summary line, and the build-freshness test it relies on (ratchet-lib's
// distIsFresh, over a copied fixture tree). Pure: no spawns, no git, no
// vitest invocation.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  MAX_WAIT_CEILING_S,
  classOf,
  missingManifestEntries,
  parseArgs,
  planRun,
  projectsOf,
  readReport,
  runVerdict,
  signalExit,
  summaryLine,
  spawnLocked,
} from '../../scripts/lib/test-narrow.mjs';

const options = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  return parsed.options;
};
const refusal = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.reason ?? '';
};

describe('parseArgs', () => {
  it('defaults to base mode with the full lock-wait ceiling', () => {
    expect(options([])).toEqual({
      files: [],
      base: null,
      range: null,
      dryRun: false,
      include: [],
      testNamePattern: null,
      maxWaitS: MAX_WAIT_CEILING_S,
    });
  });

  it('accepts files, a leading `--`, and both value spellings', () => {
    expect(options(['--', 'test/a.test.ts', 'src/b.ts']).files).toEqual([
      'test/a.test.ts',
      'src/b.ts',
    ]);
    expect(options(['--base', 'origin/main']).base).toBe('origin/main');
    expect(options(['--base=origin/main']).base).toBe('origin/main');
    expect(options(['--range', 'a..b', '--list']).dryRun).toBe(true);
    expect(options(['-t', 'name', 'x.test.ts']).testNamePattern).toBe('name');
    expect(options(['--max-wait=0']).maxWaitS).toBe(0);
    expect(options(['--include-integration', '--include-live']).include).toEqual([
      'integration',
      'live',
    ]);
  });

  it('refuses watch, coverage, ui and every unknown vitest flag', () => {
    for (const flag of ['--watch', '-w', '--watchAll', '--coverage', '--ui']) {
      expect(refusal([flag])).toContain('refused');
    }
    for (const flag of ['--project', '--maxWorkers=8', '--reporter', '-x']) {
      expect(refusal([flag])).toContain('unknown option');
    }
  });

  it('refuses malformed values instead of reading them as files', () => {
    expect(refusal(['--dry-run=1'])).toBe('--dry-run takes no value');
    expect(refusal(['--base'])).toBe('--base requires a value');
    expect(refusal(['--base', '--dry-run'])).toBe('--base requires a value, got --dry-run');
    expect(refusal(['--range=--output=x..y'])).toBe('--range requires a value, got --output=x..y');
    expect(refusal(['--base=--fork-point'])).toContain('requires a value');
    expect(refusal(['--max-wait', String(MAX_WAIT_CEILING_S + 1)])).toContain('0..');
    expect(refusal(['--max-wait', '1.5'])).toContain('whole seconds');
    expect(refusal(['--range', 'HEAD'])).toContain('<a>..<b>');
  });

  it('refuses mixing selection modes', () => {
    expect(refusal(['a.test.ts', '--base', 'x'])).toContain('choose one selection');
    expect(refusal(['--base', 'x', '--range', 'a..b'])).toContain('choose one selection');
  });

  it('reports help without a refusal reason', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: false, help: true });
  });
});

describe('planRun', () => {
  const manifest = {
    'test/p.test.ts': 'pure',
    'test/q.test.ts': 'process',
    'test/i.test.ts': 'integration',
    'test/l.test.ts': 'live',
  };
  const selection = (files: string[], fallback = false) => ({
    files,
    fallback,
    reason: fallback ? 'no mapping for x' : 'mapped',
  });

  it('classifies like vitest.config.ts: manifest, else e2e by location, else process', () => {
    expect(classOf('test/p.test.ts', manifest)).toBe('pure');
    expect(classOf('test/e2e/new.test.ts', manifest)).toBe('integration');
    expect(classOf('lint/rules/new.test.ts', manifest)).toBe('process');
  });

  it('refuses a fallback selection instead of running every test', () => {
    const plan = planRun({
      selection: selection(['test/p.test.ts'], true),
      manifest,
      include: [],
    });
    expect(plan).toMatchObject({ ok: false, candidates: [] });
    expect(!plan.ok && plan.reason).toContain('unbounded (no mapping for x)');
  });

  it('refuses gated integration/live files, naming them and their flags', () => {
    const files = ['test/i.test.ts', 'test/l.test.ts', 'test/p.test.ts'];
    const plan = planRun({ selection: selection(files), manifest, include: [] });
    expect(plan).toEqual({
      ok: false,
      reason:
        'gated test files cover the change: test/i.test.ts (integration), ' +
        'test/l.test.ts (live); pass --include-integration --include-live to run them',
      candidates: [],
    });
    // Only gated files selected (a change covered by integration tests alone)
    // is a refusal too, never an empty `result=nothing` success.
    const only = planRun({ selection: selection(['test/i.test.ts']), manifest, include: [] });
    expect(!only.ok && only.reason).toContain('pass --include-integration to run them');
    // One opted-in class still refuses the other.
    const half = planRun({ selection: selection(files), manifest, include: ['integration'] });
    expect(!half.ok && half.reason).toBe(
      'gated test files cover the change: test/l.test.ts (live); pass --include-live to run them',
    );
  });

  it('runs gated classes the caller opted into', () => {
    expect(
      planRun({
        selection: selection(['test/i.test.ts', 'test/p.test.ts']),
        manifest,
        include: ['integration'],
      }),
    ).toEqual({
      ok: true,
      run: [
        { file: 'test/i.test.ts', project: 'integration' },
        { file: 'test/p.test.ts', project: 'pure' },
      ],
    });
  });

  it('caps the file count and lists the candidates', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => `test/f${i}.test.ts`);
    const plan = planRun({ selection: selection(files), manifest, include: [] });
    expect(plan).toMatchObject({ ok: false, candidates: files });
    const atCap = planRun({
      selection: selection(files.slice(0, MAX_FILES)),
      manifest,
      include: [],
    });
    expect(atCap.ok).toBe(true);
  });

  it('plans an empty run for an empty selection (the caller then runs nothing)', () => {
    expect(planRun({ selection: selection([]), manifest, include: [] })).toEqual({
      ok: true,
      run: [],
    });
  });

  it('finds manifest entries whose test file no longer exists', () => {
    const onDisk = new Set(['test/p.test.ts', 'test/i.test.ts', 'test/l.test.ts']);
    expect(missingManifestEntries(manifest, (f) => onDisk.has(f))).toEqual(['test/q.test.ts']);
    expect(missingManifestEntries(manifest, () => true)).toEqual([]);
  });

  it('orders projects as vitest.config.ts groups them', () => {
    expect(
      projectsOf([
        { file: 'a', project: 'integration' },
        { file: 'b', project: 'process' },
        { file: 'c', project: 'pure' },
        { file: 'd', project: 'process' },
      ]),
    ).toEqual(['pure', 'process', 'integration']);
  });
});

describe('summaryLine', () => {
  it('prints every key in a fixed order with dashes for absent values', () => {
    expect(summaryLine({ result: 'refused', exit: 2, reason: 'say "no"' })).toBe(
      'test:narrow result=refused exit=2 files=- projects=- tests=- failed=- skipped=- ' +
        'wait=- duration=- nice=- load=- uptime=- source=- ran=- reason="say \\"no\\""',
    );
  });

  it('prints a full run on one line', () => {
    expect(
      summaryLine({
        result: 'pass',
        exit: 0,
        files: ['test/a.test.ts', 'test/b.test.ts'],
        projects: ['pure', 'process'],
        tests: { total: 7, passed: 6, failed: 0, skipped: 1 },
        waitMs: 1234,
        durationMs: 5000,
        nice: 5,
        load: '3.2',
        uptimeS: 86_400.7,
        source: 'base:origin/merge-queue@0123456789',
        ran: ['test/a.test.ts', 'test/b.test.ts'],
      }),
    ).toBe(
      'test:narrow result=pass exit=0 files=2 projects=pure,process tests=6/7 failed=0 ' +
        'skipped=1 wait=1.2s duration=5.0s nice=5 load=3.2 uptime=86400s ' +
        'source=base:origin/merge-queue@0123456789 ran=test/a.test.ts,test/b.test.ts',
    );
  });
});

describe('readReport', () => {
  it('reads counts, executed files and per-file executed tests from the JSON report', () => {
    const report = {
      numTotalTests: 6,
      numPassedTests: 3,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 1,
      testResults: [
        {
          name: '/repo/test/b.test.ts',
          assertionResults: [{ status: 'skipped' }, { status: 'todo' }],
        },
        {
          name: '/repo/test/a.test.ts',
          assertionResults: [
            { status: 'passed' },
            { status: 'passed' },
            { status: 'failed' },
            { status: 'pending' },
          ],
        },
        { name: '/repo/test/c.test.ts' }, // no assertionResults: nothing executed
      ],
    };
    expect(readReport(report, (p) => p.replace('/repo/', ''))).toEqual({
      tests: { total: 6, passed: 3, failed: 1, skipped: 2 },
      ran: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
      executed: { 'test/a.test.ts': 3, 'test/b.test.ts': 0, 'test/c.test.ts': 0 },
    });
  });

  it('returns null for a missing or malformed report', () => {
    expect(readReport(null, String)).toBeNull();
    expect(readReport({ numTotalTests: 1 }, String)).toBeNull();
  });
});

describe('runVerdict', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts'];
  const report = (executed: Record<string, number>) => {
    const passed = Object.values(executed).reduce((n, k) => n + k, 0);
    return {
      tests: { total: passed + 1, passed, failed: 0, skipped: 1 },
      ran: Object.keys(executed).sort(),
      executed,
    };
  };
  const base = { exit: 0, files, timedOut: false, interruptedBy: null };

  it('passes a run that executed a test in every selected file', () => {
    const r = report({ 'test/a.test.ts': 2, 'test/b.test.ts': 1 });
    expect(runVerdict({ ...base, report: r })).toEqual({ result: 'pass', exit: 0 });
  });

  it('fails when any selected file executed no test, naming those files', () => {
    // `-t` matching tests in one file only: the aggregate has a pass, the
    // other file was entirely skipped.
    const partial = report({ 'test/a.test.ts': 2, 'test/b.test.ts': 0 });
    expect(runVerdict({ ...base, report: partial })).toEqual({
      result: 'fail',
      exit: 1,
      reason: 'no tests executed in: test/b.test.ts',
    });
    const none = report({ 'test/a.test.ts': 0, 'test/b.test.ts': 0 });
    expect(runVerdict({ ...base, report: none }).reason).toBe(
      'no tests executed in: test/a.test.ts,test/b.test.ts',
    );
  });

  it('fails a run without a report, with a missing file, or with an extra one', () => {
    expect(runVerdict({ ...base, report: null })).toMatchObject({ result: 'fail', exit: 1 });
    const missing = report({ 'test/a.test.ts': 1 });
    expect(runVerdict({ ...base, report: missing }).reason).toBe(
      'selected files did not run: test/b.test.ts',
    );
    const extra = report({ 'test/a.test.ts': 1, 'test/b.test.ts': 1, 'test/z.test.ts': 1 });
    expect(runVerdict({ ...base, report: extra }).reason).toBe(
      'ran unselected files: test/z.test.ts',
    );
  });

  it('reports timeouts, interrupts and vitest failures before the pass proof', () => {
    expect(runVerdict({ ...base, report: null, exit: 143, timedOut: true })).toMatchObject({
      result: 'timeout',
      exit: 143,
    });
    expect(runVerdict({ ...base, report: null, exit: 130, interruptedBy: 'SIGINT' })).toEqual({
      result: 'interrupted',
      exit: 130,
      reason: 'SIGINT',
    });
    expect(runVerdict({ ...base, report: null, exit: 1 })).toEqual({ result: 'fail', exit: 1 });
  });

  it('never exits 0 on a timeout or interrupt that vitest raced to a clean exit', () => {
    const r = report({ 'test/a.test.ts': 1, 'test/b.test.ts': 1 });
    expect(runVerdict({ ...base, report: r, timedOut: true })).toMatchObject({
      result: 'timeout',
      exit: 124,
    });
    expect(runVerdict({ ...base, report: r, interruptedBy: 'SIGTERM' })).toMatchObject({
      result: 'interrupted',
      exit: signalExit('SIGTERM'),
    });
    expect(signalExit('SIGINT')).toBe(130);
  });
});

describe('distIsFresh (the runner skips the build only when this holds)', () => {
  const lib = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/ratchet-lib.mjs');
  const inputs = [
    'src/a.ts',
    'tsconfig.json',
    'tsconfig.build.json',
    'package.json',
    'scripts/copy-prompt-assets.mjs',
  ];
  const marker = '.cq/build-complete';
  const outputs = ['dist/index.js', 'dist/ops/ratchet/checkRatchet.js', marker];
  /** A fixture tree with ratchet-lib copied in (its ROOT is its own parent). */
  const fixture = async () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'));
    const put = (file: string, seconds: number) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '');
      utimesSync(join(root, file), seconds, seconds);
    };
    for (const file of inputs) put(file, 1_000);
    for (const file of outputs) put(file, 2_000);
    copyFileSync(lib, join(root, 'scripts/ratchet-lib.mjs'));
    const mod = (await import(pathToFileURL(join(root, 'scripts/ratchet-lib.mjs')).href)) as {
      distIsFresh: () => boolean;
      invalidateBuild: () => void;
      markBuildComplete: () => void;
    };
    mod.markBuildComplete();
    utimesSync(join(root, marker), 2_000, 2_000);
    return { root, put, ...mod };
  };

  it('is fresh only while dist is newer than src/ and every root build input', async () => {
    for (const input of inputs) {
      const { root, put, distIsFresh } = await fixture();
      try {
        expect(distIsFresh()).toBe(true);
        put(input, 3_000); // a newer input than dist
        expect(distIsFresh()).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it.each(inputs.filter((file) => !file.startsWith('src/')))(
    'requires build input %s when src/ exists',
    async (input) => {
      const { root, distIsFresh } = await fixture();
      try {
        expect(distIsFresh()).toBe(true);
        rmSync(join(root, input));
        expect(distIsFresh()).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('stays stale after an interrupted build refreshes the compiled outputs', async () => {
    const { root, put, distIsFresh, invalidateBuild, markBuildComplete } = await fixture();
    try {
      expect(distIsFresh()).toBe(true);
      invalidateBuild();
      invalidateBuild(); // a cold or previously interrupted build is safe to start
      put('dist/index.js', 4_000);
      put('dist/ops/ratchet/checkRatchet.js', 4_000);
      expect(distIsFresh()).toBe(false); // asset step has not completed
      markBuildComplete();
      expect(distIsFresh()).toBe(true);
      utimesSync(join(root, marker), 500, 500); // an old success cannot certify newer inputs
      expect(distIsFresh()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires every dist output and the external completion marker', async () => {
    for (const output of outputs) {
      const { root, distIsFresh } = await fixture();
      try {
        rmSync(join(root, output));
        expect(distIsFresh()).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps completion metadata outside dist and removes the legacy packed marker', async () => {
    const { root, put, invalidateBuild, markBuildComplete, distIsFresh } = await fixture();
    try {
      const packedFiles = readdirSync(join(root, 'dist'));
      expect(existsSync(join(root, marker))).toBe(true);
      expect(packedFiles).not.toContain('.build-complete');
      put('dist/.build-complete', 2_000); // an existing checkout from the old build protocol
      invalidateBuild();
      expect(existsSync(join(root, 'dist/.build-complete'))).toBe(false);
      expect(existsSync(join(root, marker))).toBe(false);
      markBuildComplete();
      expect(distIsFresh()).toBe(true);
      expect(readdirSync(join(root, 'dist'))).toEqual(packedFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a marker copied from another dist tree', async () => {
    const first = await fixture();
    const second = await fixture();
    try {
      copyFileSync(join(first.root, marker), join(second.root, marker));
      expect(second.distIsFresh()).toBe(false);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  it.each(outputs.filter((file) => file.startsWith('dist/')))(
    'requires a new completion marker after %s changes',
    async (output) => {
      const { root, put, distIsFresh, markBuildComplete } = await fixture();
      try {
        put(output, 3_000);
        expect(distIsFresh()).toBe(false);
        markBuildComplete();
        expect(distIsFresh()).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('reuses prebuilt dist without sources or root configs; absent inputs impose nothing', async () => {
    const { root, distIsFresh } = await fixture();
    try {
      // Fixture trees (ratchet-propose's) carry a prebuilt dist and no
      // sources or root configs: nothing there can be newer than dist.
      rmSync(join(root, 'src'), { recursive: true });
      for (const input of inputs.filter((file) => !file.startsWith('src/'))) {
        rmSync(join(root, input));
      }
      expect(distIsFresh()).toBe(true);
      rmSync(join(root, 'dist/index.js'));
      expect(distIsFresh()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('spawnLocked', () => {
  it.each(['build', 'vitest'])('refuses a %s spawn after ownership was lost', () => {
    const events: string[] = [];
    const lock = {
      annotate: (record: { childPending?: boolean }) => {
        expect(record).toEqual({ childPending: true });
        events.push('pending');
      },
      stillHeld: () => {
        events.push('fence');
        return false;
      },
    };
    try {
      spawnLocked(lock, () => {
        events.push('spawn');
        return { pid: 9 };
      });
      throw new Error('expected lock-lost refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 75 });
    }
    expect(events).toEqual(['pending', 'fence']);
  });

  it('records pending before spawning and replaces it with the group identity immediately after', () => {
    const events: string[] = [];
    const identity = { childPgid: 9, childStartedAt: '2026-10-08T01:02:03.000Z' };
    const lock = {
      annotate: (record: { childPending?: boolean; childPgid?: number | null }) => {
        events.push(record.childPending ? 'pending' : 'identity');
        return identity;
      },
      stillHeld: () => {
        events.push('fence');
        return true;
      },
    };
    const child = { pid: 9 };
    expect(
      spawnLocked(lock, () => {
        events.push('spawn');
        return child;
      }),
    ).toEqual({ child, identity });
    expect(events).toEqual(['pending', 'fence', 'spawn', 'identity']);
  });
});
