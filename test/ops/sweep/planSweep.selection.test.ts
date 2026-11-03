// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the
// selection contract (workspace-all, changed-vs-base, explicit).
import { describe, expect, test } from 'vitest';
import { makePlanSweep } from '../../../src/ops/sweep/planSweep.js';
import {
  baseInput,
  changed,
  deleted,
  failedPlan,
  makePlanner,
  okPlan,
} from './planSweep.helpers.js';

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

describe('planSweep selection', () => {
  test('workspace-all selects every manifest package × every requested fixer', async () => {
    const report = await okPlan(makePlanner(), baseInput({ fixers: ['lint', 'format'] }));
    expect(report.units.map((u) => [u.package, u.fixer])).toEqual([
      ['core', 'lint'],
      ['core', 'format'],
      ['core-tests', 'lint'],
      ['core-tests', 'format'],
      ['cli', 'lint'],
      ['cli', 'format'],
      ['web', 'lint'],
      ['web', 'format'],
    ]);
    expect(report.jobs).toHaveLength(report.units.length);
    expect(report.suppressed).toEqual([]);
    expect(report.needsHuman).toEqual([]);
    expect(report.orphans).toBeUndefined();
  });

  test('fixers are a set: duplicate labels do not duplicate units', async () => {
    const report = await okPlan(makePlanner(), baseInput({ fixers: ['lint', 'lint'] }));
    // One lint unit PER PACKAGE — the set semantics deduplicate the labels,
    // not the packages.
    expect(report.units.map((u) => u.fixer)).toEqual(['lint', 'lint', 'lint', 'lint']);
  });

  test('workspace-all units carry the known file-set, empty when packageFiles is absent', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        packageFiles: { core: ['packages/core/src/a.ts'], web: [] },
      }),
    );
    expect(report.units.find((u) => u.package === 'core')?.files).toEqual([
      'packages/core/src/a.ts',
    ]);
    expect(report.units.find((u) => u.package === 'web')?.files).toEqual([]);
    expect(report.units.find((u) => u.package === 'cli')?.files).toEqual([]);
  });

  test("a package named 'constructor' inherits NO prototype member — file-set [] and JSON-lossless (jFLC3)", async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        packages: [{ name: 'constructor', path: 'packages/ctor' }],
        packageFiles: {},
      }),
    );
    expect(report.units).toEqual([{ package: 'constructor', fixer: 'lint', files: [] }]);
    // A function-valued file-set would break the report's JSON round trip.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test('an empty manifest plans an honest empty sweep (ok, zero jobs)', async () => {
    const report = await okPlan(makePlanner(), baseInput({ packages: [] }));
    expect(report.units).toEqual([]);
    expect(report.jobs).toEqual([]);
  });

  test('changed-vs-base maps by LONGEST path-prefix, boundary-aware, and reports orphans', async () => {
    const changedPaths = [
      'packages/core/src/a.ts', // → core (core-tests' prefix does not reach)
      'packages/core/test/a.test.ts', // → core-tests (longer prefix beats core)
      'packages/cli/main.ts', // → cli
      'packages/corex/y.ts', // string prefix but NOT a path prefix → orphan
      'docs/readme.md', // no package → orphan
    ];
    let askedBase: string | undefined;
    const planner = makePlanSweep({
      changedFiles: async (base) => {
        askedBase = base;
        return changed(...changedPaths);
      },
    });
    const report = await okPlan(
      planner,
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(askedBase).toBe('origin/main');
    // Manifest order; packages with no mapped file are not selected.
    expect(report.units.map((u) => u.package)).toEqual(['core', 'core-tests', 'cli']);
    expect(report.units.find((u) => u.package === 'core')?.files).toEqual([
      'packages/core/src/a.ts',
    ]);
    expect(report.units.find((u) => u.package === 'core-tests')?.files).toEqual([
      'packages/core/test/a.test.ts',
    ]);
    // Orphans are reported, never silently dropped — sorted, boundary orphan included.
    expect(report.orphans).toEqual(['docs/readme.md', 'packages/corex/y.ts']);
  });

  test('changed-vs-base units carry the mapped changed files as their file-set', async () => {
    const report = await okPlan(
      makePlanner({ changedFiles: async () => changed('packages/cli/main.ts') }),
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'HEAD~1' },
        packageFiles: { cli: ['packages/cli/stale.ts'] },
      }),
    );
    // The diff is this mode's file-set; it supersedes packageFiles.
    expect(report.units).toEqual([
      { package: 'cli', fixer: 'lint', files: ['packages/cli/main.ts'] },
    ]);
  });

  test("a '.' package path names the repo ROOT: it owns everything no nested prefix claims", async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => changed('packages/core/src/a.ts', 'README.md', 'docs/guide.md'),
      }),
      baseInput({
        packages: [
          { name: 'monorepo', path: '.' },
          { name: 'core', path: 'packages/core' },
        ],
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
      }),
    );
    // The nested prefix beats the root package under `packages/core`; the
    // root package sweeps the rest — and nothing is an orphan.
    expect(report.units).toEqual([
      {
        package: 'monorepo',
        fixer: 'lint',
        files: ['README.md', 'docs/guide.md'],
      },
      { package: 'core', fixer: 'lint', files: ['packages/core/src/a.ts'] },
    ]);
    expect(report.orphans).toBeUndefined();
  });

  test("a './'-prefixed manifest path is normalized and matches git's repo-relative paths", async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => changed('packages/core/x.ts'),
      }),
      baseInput({
        packages: [{ name: 'core', path: './packages/core' }],
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
      }),
    );
    expect(report.units).toEqual([
      { package: 'core', fixer: 'lint', files: ['packages/core/x.ts'] },
    ]);
    expect(report.orphans).toBeUndefined();
  });

  test("a trailing-slash or '..'-carrying manifest path is a failed result", async () => {
    const trailing = await failedPlan(
      makePlanner(),
      baseInput({ packages: [{ name: 'core', path: 'packages/core/' }] }),
    );
    expect(trailing).toMatch(/packages\[0\] path/);
    expect(trailing).toMatch(/normalized repo-root-relative posix path/);
    const escaping = await failedPlan(
      makePlanner(),
      baseInput({ packages: [{ name: 'esc', path: '../esc' }] }),
    );
    expect(escaping).toMatch(/packages\[0\] path/);
  });

  test('a DELETED path selects its package but is filtered from the file-set (#150)', async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => [
          deleted('packages/cli/old.ts'),
          ...changed('packages/cli/main.ts'),
        ],
      }),
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(report.units).toEqual([
      { package: 'cli', fixer: 'lint', files: ['packages/cli/main.ts'] },
    ]);
    expect(report.orphans).toBeUndefined();
    // The deleted path survives as SELECTION evidence (r1 major).
    expect(report.selectionEvidence).toEqual({ cli: ['packages/cli/old.ts'] });
  });

  test('a deletion-only package is still SELECTED with an empty file-set (#150)', async () => {
    const report = await okPlan(
      makePlanner({ changedFiles: async () => [deleted('packages/cli/old.ts')] }),
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(report.units).toEqual([{ package: 'cli', fixer: 'lint', files: [] }]);
  });

  test('a rename selects BOTH packages; the source side is never a fixer target (#150)', async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => [
          { path: 'packages/cli/old.ts', status: 'R100', deleted: true, fixerTarget: false },
          { path: 'apps/web/new.ts', status: 'R100', deleted: false, fixerTarget: true },
        ],
      }),
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(report.units).toEqual([
      { package: 'cli', fixer: 'lint', files: [] },
      { package: 'web', fixer: 'lint', files: ['apps/web/new.ts'] },
    ]);
  });

  test('a COPY source is selection evidence but NOT a fixer target (r1 finding 2)', async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => [
          { path: 'packages/cli/src.ts', status: 'C75', deleted: false, fixerTarget: false },
          { path: 'packages/cli/copy.ts', status: 'C75', deleted: false, fixerTarget: true },
        ],
      }),
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(report.units).toEqual([
      { package: 'cli', fixer: 'lint', files: ['packages/cli/copy.ts'] },
    ]);
    expect(report.selectionEvidence).toEqual({ cli: ['packages/cli/src.ts'] });
  });

  test('a backslash-containing manifest path is refused at the op boundary (#150)', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ packages: [{ name: 'core', path: 'packages\\core' }] }),
    );
    expect(error).toMatch(/packages\[0\] path/);
    expect(error).toMatch(/backslash/);
    expect(error).toMatch(/posix separators/);
  });

  test('explicit selects exactly the named manifest packages (deduplicated)', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        selector: { mode: 'explicit', packages: ['web', 'core', 'web'] },
        packageFiles: { web: ['apps/web/index.ts'] },
      }),
    );
    expect(report.units.map((u) => [u.package, u.files])).toEqual([
      ['web', ['apps/web/index.ts']],
      ['core', []],
    ]);
  });

  test('an explicit selector naming an unknown package is a failed result naming it', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ selector: { mode: 'explicit', packages: ['core', 'nope'] } }),
    );
    expect(error).toMatch(/unknown package\(s\): nope/);
  });

  test('empty fixers is a failed result — zero units must never be silent', async () => {
    await expect(failedPlan(makePlanner(), baseInput({ fixers: [] }))).resolves.toMatch(
      /non-empty set/,
    );
  });

  test('a failing changed-files dep is a failed result, never a fabricated plan', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => {
        throw new Error('git died');
      },
    });
    const error = await failedPlan(
      planner,
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(error).toMatch(/could not list files changed/);
    expect(error).toMatch(/git died/);
  });
});
