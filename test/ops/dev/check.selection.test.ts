// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { devEffectsFor, pnpmArgs } from './check.helpers.js';
import { makeTestRepo, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effectsFor = (override?: CommandHandler) => devEffectsFor(repo, override);

describe('dev.check', () => {
  test('uncommitted selects HEAD changes and records a limited scope', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root, uncommitted: true });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.scope).toBe('uncommitted');
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--base', result.value.head]);
    expect(result.value.gates.map((gate) => gate.name)).not.toContain('diff-check:committed');
    expect(result.value.gates.map((gate) => gate.name)).toContain('diff-check:staged');
    expect(result.value.gates.map((gate) => gate.name)).toContain('diff-check:unstaged');
  });
  test.each([{ range: 'a..b' }, { testFiles: ['test/a.test.ts'] }])(
    'uncommitted refuses competing selection %j',
    async (selection) => {
      const result = await makeDevCheck(effectsFor())({
        repoRoot: repo.root,
        uncommitted: true,
        ...selection,
      });
      expect(result).toMatchObject({
        status: 'failed',
        error: 'dev.check: uncommitted cannot be combined with range or testFiles',
      });
    },
  );

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
      version: DEV_LEDGER_VERSION,
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
    const base = repo.git('rev-parse', 'origin/main').trim();
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
      range: 'HEAD~1..origin/main',
    });
    expect(behind.status).toBe('needs-human');
    const missing = await makeDevCheck(effectsFor())({ repoRoot: repo.root, range: 'nope..HEAD' });
    expect(missing.status).toBe('needs-human');
  });
});
