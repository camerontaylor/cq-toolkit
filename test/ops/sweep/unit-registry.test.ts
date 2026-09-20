// Sweep lane (goal D4) — the registered 'sweep.unit' entry (jSKJF): schema,
// importer binding, and the shipped push leg. Pinned here:
//   1. THE REGISTRY SURFACE (the D2-era pin, updated): the sweep family
//      registers exactly five ops — planSweep, worktreeFor, unit, salvage,
//      cleanup — with 'sweep.unit' dispatchable by name.
//   2. SCHEMA ACCEPT/REJECT: a fully-wired dispatch input parses; unknown
//      keys, an empty binary template, and a model-less driver section are
//      rejected at the boundary.
//   3. THE IMPORTER RESOLVES and the binding refuses the two honest
//      misconfigurations (no driver / no check config) with `failed` naming
//      the field — never a silent no-op.
//   4. THE PUSH LEG (jSKJL): the shipped makePushBranch publishes a local
//      branch to a real LOCAL BARE origin (offline), with the args-array
//      `push -u origin <branch>` argv.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  registry as sweepRegistry,
  SweepUnitDispatchInputSchema,
} from '../../../src/ops/sweep/registry.js';
import {
  bindingsFromDispatch,
  compileStagePathPatterns,
  DEFAULT_UNIT_PROMPT_TEMPLATE,
  makePushBranch,
  pushLockOptions,
  sweepRunStateDir,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDispatchInput } from '../../../src/ops/sweep/unit.js';

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

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
    binary: ['node', '/opt/agent.mjs'],
    provider: 'cq-e2e',
    model: 'sweep-fake',
    sessionsDir: '/tmp/sweep-sessions',
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
    // An empty driver binary template is refused.
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { ...VALID.driver, binary: [] },
      }).success,
    ).toBe(false);
    // A driver section without a model is refused.
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { binary: 'agent', provider: 'cq-e2e' },
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
    expect(() => bindingsFromDispatch(driverlessInput)).toThrow(/no driver config/);
  });

  test('bindingsFromDispatch defaults the push leg ON (push:false opts out)', () => {
    expect(bindingsFromDispatch(VALID).pushBranch).toBeDefined();
    expect(bindingsFromDispatch({ ...VALID, push: false }).pushBranch).toBeUndefined();
    // The prompt template: the shipped default, placeholders substituted.
    const bindings = bindingsFromDispatch(VALID);
    const expected = DEFAULT_UNIT_PROMPT_TEMPLATE.replaceAll('{package}', 'alpha')
      .replaceAll('{fixer}', 'fix')
      .replaceAll('{worktree}', '/worktrees/fix/alpha');
    expect(
      bindings.prompt({ package: 'alpha', fixer: 'fix', files: [] }, {
        path: '/worktrees/fix/alpha',
      } as never),
    ).toBe(expected);
  });

  test('placeholder substitution is literal — `$&`/`` $` `` never become replacement tokens (#175 item 7)', () => {
    const bindings = bindingsFromDispatch({
      ...VALID,
      promptTemplate: 'pkg={package} fixer={fixer} wt={worktree}',
    });
    const unit = { package: 'a$&b', fixer: 'f$`g', files: [] };
    // The OLD string-replacer form would turn `$&` into the matched
    // placeholder and `` $` `` into the pre-match text — corrupting the prompt.
    expect(bindings.prompt(unit, { path: '/wt/$&x`y' } as never)).toBe(
      'pkg=a$&b fixer=f$`g wt=/wt/$&x`y',
    );
    // The check-command args use the same literal substitution.
    expect(bindings.checkCommand(unit, '/wt').args).toEqual(['scripts/check.js', 'a$&b']);
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

      const push = makePushBranch({ lockPath: join(root, 'push.lock') });
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
    expect(dot).toBe('/repo/worktrees/.cq-state/cq/run%2Eone');
    // `..` cannot escape the state namespace either.
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/..')).toBe(
      '/repo/worktrees/.cq-state/cq/%2E%2E',
    );
    // An EMPTY segment is reserved: `cq//one` must not collapse onto
    // `cq/one`, and a leading empty segment must not make the namespace
    // ABSOLUTE (which would escape the state dir).
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq//one')).toBe(
      '/repo/worktrees/.cq-state/cq/%EMPTY/one',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', '/one')).toBe(
      '/repo/worktrees/.cq-state/%EMPTY/one',
    );
  });

  test('the dispatch mutex defaults to a repo-level lock; the input overrides', () => {
    const bindings = bindingsFromDispatch(VALID);
    expect(bindings.mutex).toEqual({
      lockPath: join(sweepRunStateDir('/repo', 'worktrees', 'cq/09-16a'), 'git-mutex.lock'),
    });
    const overridden = bindingsFromDispatch({
      ...VALID,
      mutex: { lockPath: '/locks/custom.lock', staleMs: 5000 },
    });
    expect(overridden.mutex).toEqual({ lockPath: '/locks/custom.lock', staleMs: 5000 });
    // jeDcl: the PUSH lock preserves the caller's FULL mutex config — only
    // the lockfile is the push's own. A shorter stale window on the push
    // could let a waiting sibling classify the push's held lock as stale and
    // steal it MID-PUSH.
    expect(
      pushLockOptions(
        { lockPath: '/locks/custom.lock', staleMs: 45000, retries: 4, retryBaseMs: 250 },
        12000,
      ),
    ).toEqual({
      timeoutMs: 12000,
      lockPath: '/locks/custom.lock',
      staleMs: 45000,
      retries: 4,
      retryBaseMs: 250,
    });
    // The resolved segments override rides the bindings (jTPa1).
    const renamed = bindingsFromDispatch({ ...VALID, kind: 'fix', slug: 'a-b-2' });
    expect(renamed.segments).toEqual({
      kind: 'fix',
      slug: 'a-b-2',
      branch: 'cq/09-16a/fix/a-b-2',
    });
  });
});
