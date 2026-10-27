// dev.check op tests over a REAL git repo (repo.ts): pnpm and node are
// scripted, git and tar run for real. Pinned: the gate set and its order,
// red → failed with the record still persisted, the resolved base handed to
// test:narrow, the range rules, the path-class knip rule, the denylist scan
// over the archived tree WITH the working patch applied, and the three
// diff-checks.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { knipTrigger, makeDevCheck, rangeFault } from '../../../src/ops/dev/check.js';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import { failResult, makeFakeEffects } from './fakes.js';
import { makeTestRepo, repoEffects, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

/** pnpm and node answer green unless `override` says otherwise. */
const tools =
  (override: CommandHandler = () => undefined): CommandHandler =>
  async (command, args) => {
    const scripted = await override(command, args);
    if (scripted !== undefined) return scripted;
    if (command === 'pnpm' || command === 'node') return 'ok\n';
    return undefined;
  };

const effectsFor = (override?: CommandHandler) => repoEffects(repo, tools(override), {}, ['tar']);
const gateNames = ['check:static', 'format:check', 'test:narrow', 'knip', 'denylist-scan'];
const pnpmArgs = (effects: ReturnType<typeof effectsFor>) =>
  effects.calls.filter((call) => call.command === 'pnpm').map((call) => call.args);

describe('rangeFault and knipTrigger', () => {
  test('rangeFault accepts two distinct refs; refuses empty halves, options, identical ends', () => {
    expect(rangeFault('a..b')).toBeNull();
    expect(rangeFault('a..')).not.toBeNull();
    expect(rangeFault('-x..b')).not.toBeNull();
    expect(rangeFault('a..a')).not.toBeNull();
    expect(rangeFault('a..b..c')).not.toBeNull();
  });

  test.each([
    ['M\0docs/x.md\0', [], null],
    ['M\0.github/workflows/ci.yml\0', [], null],
    ['M\0src/a.ts\0', [], 'modified src/a.ts'],
    ['M\0package.json\0', [], 'modified package.json'],
    ['M\0tsconfig.build.json\0', [], 'modified tsconfig.build.json'],
    ['A\0docs/new.md\0', [], 'A docs/new.md'],
    ['D\0docs/old.md\0', [], 'D docs/old.md'],
    ['M\0docs/x.md\0', ['scratch.ts'], 'untracked file scratch.ts'],
  ])('%j with untracked %j → %j', (listing, untracked, expected) => {
    expect(knipTrigger(listing, untracked)).toBe(expected);
  });
});

describe('dev.check', () => {
  test('runs cq.json checks for adopter repos without the cq-toolkit legacy set', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            adapter: 'tsc-lines',
            command: {
              command: 'fake-check',
              args: ['--strict'],
              cwd: 'packages/app',
              timeoutMs: 12_345,
            },
          },
        ],
      }),
    );
    repo.commitAll('configure portable check');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    const originalRunCommand = effects.runCommand;
    let configuredCwd: string | undefined;
    let configuredTimeout: number | undefined;
    effects.runCommand = async (command, args, options) => {
      if (command === 'fake-check') {
        configuredCwd = options.cwd;
        configuredTimeout = options.timeoutMs;
      }
      return originalRunCommand(command, args, options);
    };
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.gates.map((gate) => gate.name)).toContain('cq.json:1:tsc-lines');
    expect(result.value.gates.map((gate) => gate.name)).not.toContain('check:static');
    expect(effects.calls).toContainEqual({ command: 'fake-check', args: ['--strict'] });
    expect(configuredCwd).toBe(join(repo.root, 'packages/app'));
    expect(configuredTimeout).toBe(12_345);
  });

  test.each([
    ['malformed JSON', 'not json'],
    [
      'a failing assertion behind exit zero',
      JSON.stringify({
        success: false,
        numTotalTests: 1,
        testResults: [
          {
            name: 'src/a.test.ts',
            assertionResults: [{ status: 'failed', fullName: 'fails', failureMessages: ['bad'] }],
          },
        ],
      }),
    ],
  ])(
    'rejects %s from an adopter JSON check even when the process exits zero',
    async (_label, stdout) => {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'vitest-json', command: { command: 'fake-check', args: [] } }],
        }),
      );
      repo.commitAll('configure JSON check');
      const effects = effectsFor((command) =>
        command === 'fake-check' ? { exitCode: 0, stdout, stderr: '', timedOut: false } : undefined,
      );
      const result = await makeDevCheck(effects)({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      const record = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'check');
      expect(record?.kind === 'check' && record.gates[0]).toMatchObject({
        name: 'cq.json:1:vitest-json',
        status: 'fail',
      });
    },
  );

  test('fresh adopter scans the archived tree portably without a toolkit denylist script', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'fake-check', args: [] } }],
      }),
    );
    await repo.write('src/checked.ts', 'export const checked = true;\n');
    repo.commitAll('configure fresh adopter');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    const seen: string[] = [];
    const result = await makeDevCheck(effects, async (components) => {
      seen.push(...components.map(({ path, text }) => `${path}:${text}`));
      return components.map(({ component }) => ({ component, hits: [] }));
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(seen).toContain('src/checked.ts:export const checked = true;\n');
    expect(effects.calls.some((call) => call.command === 'node')).toBe(false);
    expect(effects.calls.some((call) => call.command === 'gitleaks')).toBe(false);
  });

  test('portable scan excludes its configured denylist corpus and still scans source files', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'fake-check', args: [] } }],
        review: { denylistPatternsFile: 'policy/denylist/patterns.yml' },
      }),
    );
    await repo.write(
      'policy/denylist/patterns.yml',
      'rules:\n  - id: synthetic\n    regex: example\n',
    );
    await repo.write('src/checked.ts', 'export const checked = true;\n');
    repo.commitAll('configure portable scan corpus');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    let scanned: string[] = [];
    const result = await makeDevCheck(effects, async (components) => {
      scanned = components.map(({ path }) => path);
      return components.map(({ component }) => ({ component, hits: [] }));
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(scanned).not.toContain('policy/denylist/patterns.yml');
    expect(scanned).toContain('src/checked.ts');
  });

  test('preserves absolute configured check working directories', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            adapter: 'tsc-lines',
            command: { command: 'fake-check', args: [], cwd: '/external/check' },
          },
        ],
      }),
    );
    repo.commitAll('configure absolute check directory');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    let configuredCwd: string | undefined;
    const originalRunCommand = effects.runCommand;
    effects.runCommand = async (command, args, options) => {
      if (command === 'fake-check') configuredCwd = options.cwd;
      return originalRunCommand(command, args, options);
    };
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(configuredCwd).toBe('/external/check');
  });

  test('refuses malformed adopter cq.json instead of falling back to legacy gates', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write('cq.json', JSON.stringify({ schemaVersion: 1, checks: [] }));
    repo.commitAll('add malformed cq config');
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('cq.json');
    expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  test('refuses malformed cq.json for cq-toolkit too', async () => {
    await repo.write('package.json', JSON.stringify({ name: '@camerontaylor/cq-toolkit' }));
    await repo.write('cq.json', JSON.stringify({ schemaVersion: 1, checks: [] }));
    repo.commitAll('malformed toolkit config');
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  test('a green run: ok report, gates in order, the record persisted at the identity', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(effects.openLedger('feature/x').load().records[0])).toBe(
      'ok',
    );
    if (result.status !== 'ok') return;
    const base = repo.git('rev-parse', 'origin/merge-queue').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(result.value).toMatchObject({
      checkId: `k001-${head.slice(0, 8)}`,
      target: 'merge-queue',
      base,
      head,
      dirtySha256: 'clean-tree',
      passed: true,
    });
    expect(result.value.gates.map((gate) => gate.name)).toEqual([
      ...gateNames,
      'diff-check:committed',
      'diff-check:staged',
      'diff-check:unstaged',
    ]);
    expect(result.value.gates.every((gate) => gate.status === 'pass')).toBe(true);
    // test:narrow gets the RESOLVED base sha, never a moving ref.
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--base', base]);
    const records = effects.openLedger('feature/x').load().records;
    expect(records.map((r) => r.kind)).toEqual(['check']);
  });

  test('includeIntegration=false (default) keeps the argv bare and the record silent', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const base = repo.git('rev-parse', 'origin/merge-queue').trim();
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--base', base]);
    // No gated run happened, so no gate row or record field may claim one.
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.includeIntegration).toBeUndefined();
    expect(pnpmArgs(effects).every((args) => !args.includes('--include-integration'))).toBe(true);
  });

  test('testFiles names the exact files: flags first, then the files; the record says named', async () => {
    const effects = effectsFor();
    const files = ['test/ops/dev/check.test.ts', 'test/scripts/test-narrow.test.ts'];
    const result = await makeDevCheck(effects)({ repoRoot: repo.root, testFiles: files });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', ...files]);
    // The named files REPLACE the automatic selection: toContainEqual alone
    // would pass even if a '--base' argv were ALSO emitted, so no pnpm argv
    // may carry '--base' or '--range' alongside the named files.
    expect(
      pnpmArgs(effects).every((args) => !args.includes('--base') && !args.includes('--range')),
    ).toBe(true);
    // The record must DISCLOSE the narrowed selection, never let a reader
    // mistake it for the automatic diff selection.
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.testSelection).toEqual({
      mode: 'named',
      files,
    });
  });

  test('testFiles composes with includeIntegration; a range alongside is refused', async () => {
    const effects = effectsFor();
    const files = ['test/ops/dev/check.test.ts'];
    const result = await makeDevCheck(effects)({
      repoRoot: repo.root,
      testFiles: files,
      includeIntegration: true,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--include-integration', ...files]);
    // Same negative contract: the composed named run must not emit a
    // '--base'/'--range' argv in addition to the named files.
    expect(
      pnpmArgs(effects).every((args) => !args.includes('--base') && !args.includes('--range')),
    ).toBe(true);
    // A named selection replaces the range form ENTIRELY — supplying both is
    // a conflicting selection, refused before any gate runs.
    const argvBefore = pnpmArgs(effects);
    const ranged = await makeDevCheck(effects)({
      repoRoot: repo.root,
      range: 'HEAD~1..HEAD',
      testFiles: files,
    });
    expect(ranged.status, JSON.stringify(ranged)).toBe('failed');
    if (ranged.status === 'failed') expect(ranged.error).toContain('conflicting selections');
    // The refusal precedes every gate: no test:narrow argv — range or named —
    // may be emitted for the combined selection.
    expect(pnpmArgs(effects)).toEqual(argvBefore);
    const records = effects.openLedger('feature/x').load().records;
    // .every on an empty array is vacuously true, so a silently failed ledger
    // save would slip through: pin the records as non-empty first.
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every((r) => r.kind === 'check' && r.testSelection?.mode === 'named')).toBe(
      true,
    );
  });

  test('a dash-prefixed test file is refused before any gate runs', async () => {
    // BOTH shapes of the option-injection contract: a dash segment AFTER a
    // '/' (path-shaped) AND a BARE dash-leading segment with no '/' at all —
    // a validator that only rejects the path-shaped form must fail here.
    for (const file of ['test/-evil.test.ts', '-x']) {
      const effects = effectsFor();
      const result = await makeDevCheck(effects)({
        repoRoot: repo.root,
        testFiles: [file],
      });
      expect(result.status, `dash-prefixed ${file} must be refused`).toBe('failed');
      if (result.status === 'failed') {
        // Bare options fail at the shared schema; path-shaped dash segments
        // fail at the check leg. Both must identify the rejected test input.
        expect(result.error).toContain('testFiles');
        expect(result.error).toContain(file.startsWith('-') ? 'must not begin with' : file);
      }
      expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
    }
  });

  test('the automatic forms record their selection mode honestly', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.testSelection).toEqual({ mode: 'base' });
    // The other automatic (non-named) selection: the --range form's record
    // must disclose { mode: 'range' } just as honestly.
    const ranged = await makeDevCheck(effects)({ repoRoot: repo.root, range: 'HEAD~1..HEAD' });
    expect(ranged.status, JSON.stringify(ranged)).toBe('ok');
    // The ledger is a disk file shared by every effects over one repoRoot,
    // so the second run APPENDS record #2: the range disclosure is the LAST
    // record — destructuring [first] here would re-read the base record.
    const records = effects.openLedger('feature/x').load().records;
    expect(records).toHaveLength(2);
    const rangeRecord = records.at(-1);
    expect(rangeRecord?.kind === 'check' && rangeRecord.testSelection).toEqual({ mode: 'range' });
  });

  test('a ledger written before testSelection existed still loads (field evolution)', async () => {
    // Attempt C: making the new field REQUIRED re-validated pre-existing
    // records on every load and the whole store refused — schema fields the
    // code stops writing must stay optional on read.
    const effects = effectsFor();
    const first = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(first.status, JSON.stringify(first)).toBe('ok');
    const [legacy] = effects.openLedger('feature/x').load().records;
    if (legacy?.kind !== 'check') throw new Error('fixture: expected a check record');
    const { testSelection: _dropped, ...withoutSelection } = legacy;
    void _dropped;
    effects.openLedger('feature/x').save({
      version: 2,
      branch: 'feature/x',
      records: [withoutSelection],
    });
    const reloaded = effects.openLedger('feature/x').load().records;
    expect(reloaded[0]?.kind === 'check' && reloaded[0].testSelection).toBeUndefined();
    // And a new run still WRITES the field on top of the legacy ledger.
    const next = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(next.status, JSON.stringify(next)).toBe('ok');
    const records = effects.openLedger('feature/x').load().records;
    expect(records).toHaveLength(2);
    expect(records[1]?.kind === 'check' && records[1].testSelection).toEqual({ mode: 'base' });
  });

  test('includeIntegration=true adds --include-integration to the --base argv and records it', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root, includeIntegration: true });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const base = repo.git('rev-parse', 'origin/merge-queue').trim();
    expect(pnpmArgs(effects)).toContainEqual([
      'test:narrow',
      '--include-integration',
      '--base',
      base,
    ]);
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.includeIntegration).toBe(true);
  });

  test('includeIntegration=true also reaches the --range argv form', async () => {
    const start = repo.git('rev-parse', 'HEAD~1').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({
      repoRoot: repo.root,
      range: 'HEAD~1..HEAD',
      includeIntegration: true,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(pnpmArgs(effects)).toContainEqual([
      'test:narrow',
      '--include-integration',
      '--range',
      `${start}..${head}`,
    ]);
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.includeIntegration).toBe(true);
  });

  test('a refused test:narrow keeps the refusal reason in the gate row evidence', async () => {
    const effects = effectsFor((command, args) =>
      command === 'pnpm' && args[0] === 'test:narrow'
        ? failResult(
            2,
            '',
            'gated test files cover the change: test/e2e/review/live.test.ts (integration); pass --include-integration to run them (an opt-in gate, not a refusal — re-run with --include-integration)',
          )
        : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    const [record] = effects.openLedger('feature/x').load().records;
    const row =
      record?.kind === 'check' ? record.gates.find((g) => g.name === 'test:narrow') : undefined;
    expect(row?.evidence).toContain('pass --include-integration to run them');
  });

  test('a red gate maps to failed, names the gate, and STILL persists the record', async () => {
    const effects = effectsFor((command, args) =>
      command === 'pnpm' && args[1] === 'check:static' ? failResult(1, '', 'TS2322') : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('check:static');
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.passed).toBe(false);
  });

  test('a spawn-faulted gate is a failed row; the record still lands', async () => {
    const effects = effectsFor((command, args) => {
      if (command === 'pnpm' && args[1] === 'format:check') throw new Error('pnpm ENOENT');
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.gates[1]?.evidence).toContain('pnpm ENOENT');
  });

  test('git diff --check catches committed whitespace damage against the pinned base', async () => {
    await repo.write('src/a.ts', 'export const a = 1; \n');
    repo.commitAll('trailing space');
    const result = await makeDevCheck(effectsFor())({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('diff-check:committed');
  });

  test('an explicit range pins its start and passes --range; its end must be HEAD', async () => {
    const start = repo.git('rev-parse', 'HEAD~1').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root, range: 'HEAD~1..HEAD' });
    expect(result.status === 'ok' && result.value.base).toBe(start);
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--range', `${start}..${head}`]);
    // The record names its selection mode: the automatic range form.
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.testSelection).toEqual({ mode: 'range' });

    const behind = await makeDevCheck(effectsFor())({
      repoRoot: repo.root,
      range: 'HEAD~1..origin/merge-queue',
    });
    expect(behind.status).toBe('needs-human');
    const missing = await makeDevCheck(effectsFor())({ repoRoot: repo.root, range: 'nope..HEAD' });
    expect(missing.status).toBe('needs-human');
  });

  test('a malformed range or schema-bypassing input fails before any command runs', async () => {
    for (const input of [
      { repoRoot: '/repo', range: '--output=x..HEAD' },
      { repoRoot: '/repo', range: 7 },
      { repoRoot: 3 },
      { repoRoot: '/repo', knip: 'force' },
    ]) {
      const effects = makeFakeEffects();
      const result = await makeDevCheck(effects)(input as never);
      expect(result.status).toBe('failed');
      expect(effects.commands).toEqual([]);
    }
  });

  test('knip is skipped (and recorded) for a docs-only diff, and runs for a code change', async () => {
    repo.git('reset', '-q', '--hard', 'origin/merge-queue');
    await repo.write('README.md', '# docs only\n');
    repo.commitAll('docs');
    const docs = effectsFor();
    const skipped = await makeDevCheck(docs)({ repoRoot: repo.root });
    expect(skipped.status === 'ok' && skipped.value.gates[3]).toMatchObject({
      name: 'knip',
      status: 'skipped',
    });
    expect(pnpmArgs(docs)).not.toContainEqual(['run', 'knip']);

    await repo.write('src/b.ts', 'export {};\n');
    const withUntracked = effectsFor();
    await makeDevCheck(withUntracked)({ repoRoot: repo.root });
    expect(pnpmArgs(withUntracked)).toContainEqual(['run', 'knip']);
  });

  test('the denylist scan sees the archived tree WITH the staged and unstaged patch applied', async () => {
    await repo.write('src/staged.ts', 'export const staged = true;\n');
    repo.git('add', 'src/staged.ts');
    await repo.write('README.md', '# unstaged edit\n');
    const seen: string[] = [];
    const effects = effectsFor(async (command, args) => {
      if (command !== 'node') return undefined;
      const tree = (args[0] ?? '').replace(/\/scripts\/denylist-scan$/, '');
      seen.push(await readFile(`${tree}/src/staged.ts`, 'utf8'));
      seen.push(await readFile(`${tree}/README.md`, 'utf8'));
      return 'clean\n';
    });
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(seen).toEqual(['export const staged = true;\n', '# unstaged edit\n']);
  });

  test('a failed patch apply faults the denylist gate (never silently green)', async () => {
    await repo.write('README.md', '# unstaged edit\n');
    const effects = effectsFor((command, args) =>
      command === 'git' && args.includes('apply')
        ? ({
            exitCode: 1,
            stdout: '',
            stderr: 'patch does not apply',
            timedOut: false,
          } as CommandResult)
        : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('denylist-scan');
  });

  test('a detached head or a missing target is needs-human before any gate runs', async () => {
    const missing = effectsFor();
    expect((await makeDevCheck(missing)({ repoRoot: repo.root, target: 'nope' })).status).toBe(
      'needs-human',
    );
    expect(pnpmArgs(missing)).toEqual([]);
    repo.git('checkout', '-q', '--detach');
    expect((await makeDevCheck(effectsFor())({ repoRoot: repo.root })).status).toBe('needs-human');
  });

  test('check ids mint monotonically on one branch', async () => {
    const effects = effectsFor();
    await makeDevCheck(effects)({ repoRoot: repo.root });
    const second = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(second.status === 'ok' && second.value.checkId.startsWith('k002-')).toBe(true);
  });
});
