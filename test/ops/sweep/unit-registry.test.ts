// Sweep lane (goal D4) — the registered 'sweep.unit' entry (jSKJF): schema,
// importer binding, and the shipped push leg. Pinned here:
//   1. THE REGISTRY SURFACE (the D2-era pin, updated): the sweep family
//      registers exactly five ops — planSweep, worktreeFor, unit, salvage,
//      cleanup — with 'sweep.unit' dispatchable by name.
//   2. SCHEMA ACCEPT/REJECT: a fully-wired dispatch input parses; unknown
//      keys, a model-less driver section, AND the removed S4b-B2 plan-JSON
//      driver keys (binary/routingTable/sessionsDir — plan data never names
//      an executable, ADR-0002 §2.5/§2.3) are rejected at the boundary.
//   3. THE IMPORTER RESOLVES and the binding refuses the two honest
//      misconfigurations (no driver / no check config) with `failed` naming
//      the field — never a silent no-op. bindingsFromDispatch binds a
//      FACTORY (ADR-0002 §2.5): it resolves role 'fixer' once and the
//      bindings carry resolved.driver + the RESOLVED modelSpec.
//   4. THE PUSH LEG (jSKJL): the shipped makePushBranch publishes a local
//      branch to a real LOCAL BARE origin (offline), with the args-array
//      `push -u origin <branch>` argv.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { DriverFactory, ResolvedDriver } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import {
  registry as sweepRegistry,
  SweepUnitDispatchInputSchema,
} from '../../../src/ops/sweep/registry.js';
import {
  bindingsFromDispatch,
  classifyStagePaths,
  compileStagePathPatterns,
  DEFAULT_UNIT_PROMPT_TEMPLATE,
  makePushBranch,
  makeSweepUnitOp,
  mutexWaiterRetries,
  sweepRunStateDir,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDispatchInput } from '../../../src/ops/sweep/unit.js';

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

/**
 * A FAKE factory (ADR-0002 §2.5): bindingsFromDispatch resolves role 'fixer'
 * through it ONCE — the fake records nothing (the dispatch-shape assertions
 * live in test/plans/sweep.test.ts's capturing driver) but hands back a
 * distinguished driver + RESOLVED spec, so the tests can pin that the
 * bindings carry the RESOLVED form (never the input's raw spec).
 */
const FAKE_RESOLVED: ResolvedDriver = {
  driver: {
    run: async (_invocation: OpInvocation): Promise<WorkerResult> => {
      throw new Error('fake factory driver: not dispatched in this suite');
    },
  } satisfies Driver,
  lane: 'ai-sdk',
  modelSpec: { provider: 'resolved-zai', model: 'resolved-model' },
};
const fakeFactory: DriverFactory = { resolve: () => FAKE_RESOLVED };

/** A fully-wired dispatch input (the shape an enriched plan job carries). */
const VALID: SweepUnitDispatchInput = {
  repoRoot: '/repo',
  worktreesDir: 'worktrees',
  runPrefix: 'cq/09-16a',
  base: 'main',
  package: 'alpha',
  fixer: 'fix',
  files: ['packages/alpha/test/suite.test.js'],
  driver: {
    provider: 'cq-e2e',
    model: 'sweep-fake',
    budget: { maxUsd: 1 },
  },
  check: {
    adapter: 'tsc-lines',
    command: 'node',
    args: ['scripts/check.js', '{package}'],
    timeoutMs: 30_000,
  },
};

describe('sweep.unit registry entry (jSKJF)', () => {
  test('the sweep registry surface: five ops, sweep.unit dispatchable by name', () => {
    expect(sweepRegistry.map((entry) => entry.name)).toEqual([
      'sweep.planSweep',
      'sweep.worktreeFor',
      'sweep.unit',
      'sweep.salvage',
      'sweep.cleanup',
    ]);
  });

  test('schema accepts a fully-wired input and rejects shape violations', () => {
    expect(SweepUnitDispatchInputSchema.safeParse(VALID).success).toBe(true);
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { ...VALID.driver!, budget: undefined },
      }).success,
    ).toBe(false);
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { ...VALID.driver!, budget: {} },
      }).success,
    ).toBe(false);
    // A context-only input (the builder's enrichment before knobs are layered) parses.
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        repoRoot: '/repo',
        worktreesDir: 'worktrees',
        runPrefix: 'cq/09-16a',
        base: 'main',
        package: 'alpha',
        fixer: 'fix',
        files: [],
      }).success,
    ).toBe(true);
    // Unknown keys are refused (strict).
    expect(SweepUnitDispatchInputSchema.safeParse({ ...VALID, evil: true }).success).toBe(false);
    // The S4b-B2 keys are GONE from the plan-JSON driver config (ADR-0002
    // §2.3/§2.5 — plan data never names an executable or a lane): the strict
    // schema REJECTS each of binary/routingTable/sessionsDir; those knobs
    // moved into DriverFactoryConfig.lanes.subprocess.
    const baseDriver = { provider: 'cq-e2e', model: 'sweep-fake' };
    const bannedDrivers: Record<string, unknown>[] = [
      { ...baseDriver, binary: ['node', '/opt/agent.mjs'] },
      {
        ...baseDriver,
        routingTable: {
          endpoints: { 'cq-e2e': { baseUrlEnv: 'X', models: ['sweep-fake'] } },
        },
      },
      { ...baseDriver, sessionsDir: '/tmp/sweep-sessions' },
    ];
    for (const driver of bannedDrivers) {
      const key = Object.keys(driver).filter((candidate) => !(candidate in baseDriver));
      expect(
        SweepUnitDispatchInputSchema.safeParse({ ...VALID, driver }).success,
        `driver.${key.join(',')} must be rejected`,
      ).toBe(false);
    }
    // A driver section without a model is refused.
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { provider: 'cq-e2e' },
      } as unknown).success,
    ).toBe(false);
  });

  test('the importer resolves and refuses dispatch inputs without driver/check config', async () => {
    const entry = sweepRegistry.find((candidate) => candidate.name === 'sweep.unit');
    expect(entry).toBeDefined();
    const op = await entry?.importer();
    expect(typeof op).toBe('function');
    // No driver config: the binding refuses, the dispatch seam folds it into
    // an honest `failed` naming the field.
    const driverless = await op?.({
      repoRoot: '/repo',
      worktreesDir: 'worktrees',
      runPrefix: 'cq/x',
      base: 'main',
      package: 'alpha',
      fixer: 'fix',
      files: [],
      check: VALID.check,
    });
    expect(driverless?.status).toBe('failed');
    expect(driverless?.status === 'failed' && driverless.error).toMatch(/no driver config/);
    // No check config: the same refusal, naming check.
    const checkless = await op?.({
      repoRoot: '/repo',
      worktreesDir: 'worktrees',
      runPrefix: 'cq/x',
      base: 'main',
      package: 'alpha',
      fixer: 'fix',
      files: [],
      driver: VALID.driver,
    });
    expect(checkless?.status).toBe('failed');
    expect(checkless?.status === 'failed' && checkless.error).toMatch(/no check config/);
    // bindingsFromDispatch itself throws (the op wraps the throw).
    const { driver: _omitted, ...driverlessInput } = VALID;
    expect(() => bindingsFromDispatch(driverlessInput, fakeFactory)).toThrow(/no driver config/);
  });

  test('bindingsFromDispatch resolves through the factory ONCE and carries the RESOLVED form', () => {
    let resolves = 0;
    const countingFactory: DriverFactory = {
      resolve: () => {
        resolves += 1;
        return FAKE_RESOLVED;
      },
    };
    const bindings = bindingsFromDispatch(VALID, countingFactory);
    // ONE resolve per dispatch (the binder's preferred shape, ADR-0002
    // checklist §2.3), role 'fixer'.
    expect(resolves).toBe(1);
    // The RESOLVED form: the factory's driver and the factory's NORMALISED
    // spec — never the input's raw spec.
    expect(bindings.driver).toBe(FAKE_RESOLVED.driver);
    expect(bindings.modelSpec).toEqual(FAKE_RESOLVED.modelSpec);
    expect(bindings.modelSpec).not.toEqual(VALID.driver);
    // No sessionsDir binding survived the migration: the workspace-bound run
    // creates its fresh record inside the worktree (factory retention).
    expect('sessionsDir' in bindings).toBe(false);
  });

  test('bindingsFromDispatch defaults the push leg ON (push:false opts out)', () => {
    expect(bindingsFromDispatch(VALID, fakeFactory).pushBranch).toBeDefined();
    expect(bindingsFromDispatch({ ...VALID, push: false }, fakeFactory).pushBranch).toBeUndefined();
    // The prompt template: the shipped default, placeholders substituted.
    const bindings = bindingsFromDispatch(VALID, fakeFactory);
    expect(bindings.sandboxPolicy).toEqual({ level: 'workspace-write' });
    expect(() =>
      bindingsFromDispatch({ ...VALID, driver: { ...VALID.driver!, budget: {} } }, fakeFactory),
    ).toThrow(/driver.budget is required/);
    const expected = DEFAULT_UNIT_PROMPT_TEMPLATE.replaceAll('{package}', 'alpha')
      .replaceAll('{fixer}', 'fix')
      .replaceAll('{worktree}', '/worktrees/fix/alpha');
    expect(
      bindings.prompt({ package: 'alpha', fixer: 'fix', files: [] }, {
        path: '/worktrees/fix/alpha',
      } as never),
    ).toBe(expected);
  });

  test(
    'dispatch defaults worktrees outside the repo and binds an argv install hook',
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sweep-install-'));
      CLEANUP.push(dir);
      const { worktreesDir: _ignored, ...withoutDir } = VALID;
      const bindings = bindingsFromDispatch(
        {
          ...withoutDir,
          repoRoot: join(dir, 'repo'),
          install: {
            command: process.execPath,
            args: ['-e', "require('node:fs').writeFileSync('installed', 'yes')"],
          },
        },
        fakeFactory,
      );
      expect(bindings.worktreesDir).toBe(join(dir, 'worktrees', 'cq'));
      expect(SweepUnitDispatchInputSchema.safeParse(withoutDir).success).toBe(true);
      await bindings.installDeps?.(dir);
      expect(readFileSync(join(dir, 'installed'), 'utf8')).toBe('yes');
    },
  );

  test(
    'new worktree installs before baseline, reuse skips install, and linked trees share the mutex',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'sweep-hook-order-'));
      CLEANUP.push(root);
      const repoRoot = join(root, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'main', repoRoot], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@example.invalid'], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T'], {
        timeout: 10_000,
      });
      writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
      execFileSync('git', ['-C', repoRoot, 'add', 'seed.txt'], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'seed'], {
        timeout: 10_000,
      });
      const timeline: string[] = [];
      const bindings = bindingsFromDispatch(
        {
          ...VALID,
          repoRoot,
          worktreesDir: join(root, 'trees'),
          runPrefix: 'cq/hook-order',
          mode: 'prep',
          push: false,
        },
        fakeFactory,
      );
      const op = makeSweepUnitOp({
        ...bindings,
        installDeps: async () => {
          timeline.push('install');
        },
        runCheck: async () => {
          timeline.push('probe');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      const unit = {
        package: VALID.package,
        fixer: VALID.fixer,
        files: VALID.files,
      };
      const first = await op(unit);
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      expect(first.value.worktree.reused).toBe(false);
      expect(timeline).toEqual(['install', 'probe']);
      const linked = bindingsFromDispatch(
        { ...VALID, repoRoot: first.value.worktree.path },
        fakeFactory,
      );
      expect(linked.mutex?.lockPath).toBe(bindings.mutex?.lockPath);

      timeline.length = 0;
      const second = await op(unit);
      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.value.worktree.reused).toBe(true);
      expect(timeline).toEqual(['probe']);
    },
  );

  test('placeholder substitution is literal — `$&`/`` $` `` never become replacement tokens (#175 item 7)', () => {
    const bindings = bindingsFromDispatch(
      {
        ...VALID,
        promptTemplate: 'pkg={package} fixer={fixer} wt={worktree}',
      },
      fakeFactory,
    );
    const unit = { package: 'a$&b', fixer: 'f$`g', files: [] };
    // The OLD string-replacer form would turn `$&` into the matched
    // placeholder and `` $` `` into the pre-match text — corrupting the prompt.
    expect(bindings.prompt(unit, { path: '/wt/$&x`y' } as never)).toBe(
      'pkg=a$&b fixer=f$`g wt=/wt/$&x`y',
    );
    // The check-command args use the same literal substitution.
    expect(bindings.checkCommand(unit, '/wt').args).toEqual(['scripts/check.js', 'a$&b']);
  });

  test('the shared default-deny taxonomy protects whole evidence/config roots', () => {
    for (const path of [
      'packages/a/test/helpers/setup.ts',
      'packages/a/__mocks__/fs.ts',
      'vitest.setup.ts',
      '.oxlintrc.json',
      '.mocharc.json',
      '.gitignore',
      'package-lock.json',
      '.github/workflows/ci.yml',
    ]) {
      expect(classifyStagePaths([path]).kind, path).toBe('protected');
    }
  });

  test('propose-only routes every non-empty staged set to human review', () => {
    expect(classifyStagePaths(['src/production.ts'], undefined, true).kind).toBe('propose-only');
    expect(classifyStagePaths([], undefined, true).kind).toBe('clean');
  });

  test('the staged-path allowlist compiles CASE-SENSITIVELY (#175 item 3)', () => {
    const compiled = compileStagePathPatterns(['^packages/alpha/']);
    expect(compiled.some((regex) => regex.test('packages/alpha/test/suite.test.js'))).toBe(true);
    // A case-differing sibling package must NOT match on a case-sensitive
    // checkout (the old `i` flag admitted it).
    expect(compiled.some((regex) => regex.test('packages/Alpha/test/suite.test.js'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The push leg on a real (local, offline) origin
// ---------------------------------------------------------------------------

describe('makePushBranch (the shipped push binding, real git smoke)', () => {
  test(
    'publishes a local branch to a local bare origin; refuses an unknown remote',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'd4-push-'));
      CLEANUP.push(root);
      const repo = join(root, 'repo');
      const origin = join(root, 'origin.git');
      const git = (args: string[], cwd: string): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile(
            'git',
            ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
            { cwd, timeout: 10_000, killSignal: 'SIGKILL' },
            (error, stdout, stderr) => {
              if (error !== null) {
                reject(new Error(stderr.trim() || error.message));
                return;
              }
              resolve(stdout);
            },
          );
        });
      await git(['init', '-q', '-b', 'main', repo], root);
      await git(['-C', repo, 'config', 'user.email', 't@example.invalid'], repo);
      await git(['-C', repo, 'config', 'user.name', 'T'], repo);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      await git(['-C', repo, 'add', '-A'], repo);
      await git(['-C', repo, 'commit', '-q', '-m', 'seed'], repo);
      await git(['init', '-q', '--bare', origin], root);
      await git(['-C', repo, 'remote', 'add', 'origin', origin], repo);
      await git(['-C', repo, 'checkout', '-q', '-b', 'cq/x/fix/alpha'], repo);

      const push = makePushBranch();
      await push(repo, 'cq/x/fix/alpha');
      const heads = await git(['-C', repo, 'ls-remote', '--heads', 'origin'], repo);
      expect(heads).toContain('cq/x/fix/alpha');

      // A repo with no origin rejects (the op folds the rejection into `failed`
      // naming the push failure).
      const orphan = mkdtempSync(join(tmpdir(), 'd4-push-orphan-'));
      CLEANUP.push(orphan);
      await git(['init', '-q', '-b', 'main', orphan], orphan);
      await expect(makePushBranch({})(orphan, 'cq/x/fix/alpha')).rejects.toThrow(/origin/);
    },
  );
});

describe('run-state namespacing and the dispatch mutex (jTPbC / jVgCc)', () => {
  test('run state is namespaced by the sanitized run prefix', () => {
    const one = sweepRunStateDir('/repo', 'worktrees', 'cq/one');
    const two = sweepRunStateDir('/repo', 'worktrees', 'cq/two');
    expect(one).not.toBe(two); // different prefixes → different state dirs
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/one')).toBe(one); // same prefix → same dir (reuse intact)
    // NESTED under worktreesDir as `.cq-state/<prefix>` (one gitignore rule
    // covers the trees AND the state; a dot-prefixed sibling of the kind
    // dirs cannot collide with a derived `<dir>/<kind>/<slug>` tree).
    expect(one).toBe('/repo/worktrees/.cq-state/cq/one');
  });

  test('distinct prefixes that used to fold together get DISTINCT state dirs (#175 item 4)', () => {
    const dot = sweepRunStateDir('/repo', 'worktrees', 'cq/run.one');
    const dash = sweepRunStateDir('/repo', 'worktrees', 'cq/run-one');
    // The old fold mapped both onto `cq/run-one`, so sequential runs
    // overwrote each other's baseline snapshots (fabricated evidence, I7).
    expect(dot).not.toBe(dash);
    expect(dot).toBe('/repo/worktrees/.cq-state/cq/run%2eone');
    // `..` cannot escape the state namespace either.
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/..')).toBe(
      '/repo/worktrees/.cq-state/cq/%2e%2e',
    );
    // An EMPTY segment is reserved: `cq//one` must not collapse onto
    // `cq/one`, and a leading empty segment must not make the namespace
    // ABSOLUTE (which would escape the state dir).
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq//one')).toBe(
      '/repo/worktrees/.cq-state/cq/%empty/one',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', '/one')).toBe(
      '/repo/worktrees/.cq-state/%empty/one',
    );
    // A LITERAL `%2E` segment must not alias the encoded `.`.
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/%2E')).toBe(
      '/repo/worktrees/.cq-state/cq/%252%45',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/%2E')).not.toBe(
      sweepRunStateDir('/repo', 'worktrees', 'cq/.'),
    );
    // Case-insensitive filesystems: UPPERCASE input is encoded, so `cq/Foo`
    // and `cq/foo` can never share a state dir (r2 minor).
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/Foo')).toBe(
      '/repo/worktrees/.cq-state/cq/%46oo',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/Foo')).not.toBe(
      sweepRunStateDir('/repo', 'worktrees', 'cq/foo'),
    );
  });

  test('the dispatch mutex defaults to a repo-level lock; the input overrides', () => {
    const bindings = bindingsFromDispatch(VALID, fakeFactory);
    expect(bindings.mutex).toEqual({
      lockPath: '/repo/.git/cq-git-mutex',
      retries: 13,
    });
    const overridden = bindingsFromDispatch(
      {
        ...VALID,
        mutex: { lockPath: '/locks/custom.lock', staleMs: 5000 },
      },
      fakeFactory,
    );
    expect(overridden.mutex).toEqual({
      lockPath: '/locks/custom.lock',
      staleMs: 5000,
    });
    expect(mutexWaiterRetries(600_000)).toBe(13);
    expect(100 * (2 ** mutexWaiterRetries(600_000) - 1)).toBeGreaterThan(600_000);
    // The resolved segments override rides the bindings (jTPa1).
    const renamed = bindingsFromDispatch({ ...VALID, kind: 'fix', slug: 'a-b-2' }, fakeFactory);
    expect(renamed.segments).toEqual({
      kind: 'fix',
      slug: 'a-b-2',
      branch: 'cq/09-16a/fix/a-b-2',
    });
  });
});
