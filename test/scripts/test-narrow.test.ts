// Policy of the one permitted local test command (scripts/lib/test-narrow.mjs):
// argv refusals, the run plan (fallback, class gate, file cap) and the stable
// summary line. Pure: no spawns, no git, no vitest invocation.
import { describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  MAX_WAIT_CEILING_S,
  classOf,
  parseArgs,
  planRun,
  projectsOf,
  readReport,
  summaryLine,
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
      named: [],
      manifest,
      include: [],
    });
    expect(plan).toMatchObject({ ok: false, candidates: [] });
    expect(!plan.ok && plan.reason).toContain('unbounded (no mapping for x)');
  });

  it('drops derived integration/live files, refuses named ones, runs opted-in classes', () => {
    const files = ['test/i.test.ts', 'test/l.test.ts', 'test/p.test.ts'];
    expect(planRun({ selection: selection(files), named: [], manifest, include: [] })).toEqual({
      ok: true,
      run: [{ file: 'test/p.test.ts', project: 'pure' }],
      dropped: [
        { file: 'test/i.test.ts', project: 'integration' },
        { file: 'test/l.test.ts', project: 'live' },
      ],
    });
    const named = planRun({
      selection: selection(['test/i.test.ts']),
      named: ['test/i.test.ts'],
      manifest,
      include: [],
    });
    expect(!named.ok && named.reason).toContain('--include-integration');
    expect(
      planRun({
        selection: selection(['test/i.test.ts']),
        named: ['test/i.test.ts'],
        manifest,
        include: ['integration'],
      }),
    ).toEqual({ ok: true, run: [{ file: 'test/i.test.ts', project: 'integration' }], dropped: [] });
  });

  it('caps the file count and lists the candidates', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => `test/f${i}.test.ts`);
    const plan = planRun({ selection: selection(files), named: [], manifest, include: [] });
    expect(plan).toMatchObject({ ok: false, candidates: files });
    const atCap = planRun({
      selection: selection(files.slice(0, MAX_FILES)),
      named: [],
      manifest,
      include: [],
    });
    expect(atCap.ok).toBe(true);
  });

  it('plans an empty run for an empty selection (the caller then runs nothing)', () => {
    expect(planRun({ selection: selection([]), named: [], manifest, include: [] })).toEqual({
      ok: true,
      run: [],
      dropped: [],
    });
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
        'wait=- duration=- nice=- load=- source=- ran=- reason="say \\"no\\""',
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
        source: 'base:origin/merge-queue@0123456789',
        ran: ['test/a.test.ts', 'test/b.test.ts'],
      }),
    ).toBe(
      'test:narrow result=pass exit=0 files=2 projects=pure,process tests=6/7 failed=0 ' +
        'skipped=1 wait=1.2s duration=5.0s nice=5 load=3.2 ' +
        'source=base:origin/merge-queue@0123456789 ran=test/a.test.ts,test/b.test.ts',
    );
  });
});

describe('readReport', () => {
  it('reads counts and executed files from the vitest JSON report', () => {
    const report = {
      numTotalTests: 5,
      numPassedTests: 3,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [{ name: '/repo/test/b.test.ts' }, { name: '/repo/test/a.test.ts' }],
    };
    expect(readReport(report, (p) => p.replace('/repo/', ''))).toEqual({
      tests: { total: 5, passed: 3, failed: 1, skipped: 1 },
      ran: ['test/a.test.ts', 'test/b.test.ts'],
    });
  });

  it('returns null for a missing or malformed report', () => {
    expect(readReport(null, String)).toBeNull();
    expect(readReport({ numTotalTests: 1 }, String)).toBeNull();
  });
});
