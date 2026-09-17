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
  DEFAULT_UNIT_PROMPT_TEMPLATE,
  makePushBranch,
  pushLockOptions,
  sweepRunStateDir,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDispatchInput } from '../../../src/ops/sweep/unit.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';

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

describe('sweep registry drift pins (VB3D F1)', () => {
  test('GitMutexBindingSchema mirrors the gitMutex family defaults verbatim', async () => {
    // The registry module must stay lazy (zod + types only), so this pin
    // lives in a TEST: the schema's mirrored default literals must equal the
    // family's shipped defaults (gitMutex.ts) — a drift on either side
    // changes the collectively-insufficient rejection at the arg boundary.
    const gitMutex = await import('../../../src/ops/sweep/gitMutex.js');
    const { registry } = await import('../../../src/ops/sweep/registry.js');
    const worktreeForEntry = registry.find((entry) => entry.name === 'sweep.worktreeFor');
    expect(worktreeForEntry).toBeDefined();
    // No explicit timings: the schema-level refine accepts (family defaults
    // are collectively sufficient).
    const bare = worktreeForEntry?.inputSchema.safeParse({
      repoRoot: '/repo',
      worktreesDir: 'wt',
      runPrefix: 'cq/x',
      kind: 'fix',
      slug: 'a',
      base: 'main',
      mutex: { lockPath: '/locks/m.lock' },
    });
    expect(bare?.success).toBe(true);
    // Below the backoff floor WITH the mirrored defaults: rejected.
    const under = worktreeForEntry?.inputSchema.safeParse({
      repoRoot: '/repo',
      worktreesDir: 'wt',
      runPrefix: 'cq/x',
      kind: 'fix',
      slug: 'a',
      base: 'main',
      mutex: { lockPath: '/locks/m.lock', staleMs: 60_000, retries: 1, retryBaseMs: 100 },
    });
    expect(under?.success).toBe(false);
    // The exact floor WITH the mirrored defaults: accepted — and the floor
    // arithmetic (retryBaseMs × (2^retries − 1) ≥ staleMs) is expressed in
    // the family's default constants:
    expect(gitMutex.DEFAULT_GIT_MUTEX_STALE_MS).toBe(30_000);
    expect(gitMutex.DEFAULT_GIT_MUTEX_RETRIES).toBe(9);
    expect(gitMutex.DEFAULT_GIT_MUTEX_RETRY_BASE_MS).toBe(100);
    expect(
      gitMutex.DEFAULT_GIT_MUTEX_RETRY_BASE_MS * (2 ** gitMutex.DEFAULT_GIT_MUTEX_RETRIES - 1),
    ).toBeGreaterThanOrEqual(gitMutex.DEFAULT_GIT_MUTEX_STALE_MS);
  });
});

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
    // An EMPTY-STRING file path is refused (files min(1) — VB3D F7).
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        files: ['packages/alpha/test/suite.test.js', ''],
      }).success,
    ).toBe(false);
  });

  test('the importer resolves and refuses dispatch inputs without driver/check config', async () => {
    const entry = sweepRegistry.find((candidate) => candidate.name === 'sweep.unit');
    expect(entry).toBeDefined();
    const op = await entry?.importer();
    expect(typeof op).toBe('function');
    if (op === undefined) throw new Error('importer resolved undefined');
    // No driver config: the binding refuses, the dispatch seam folds it into
    // an honest `failed` naming the field.
    const driverless = await op({
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
    const checkless = await op({
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

  test(
    'jhDjC: a PREP dispatch needs only the check binding and returns prep evidence',
    { timeout: 120_000 },
    async () => {
      // A prep dispatch input with NO driver section binds (the requirement is
      // mode-conditional) and the op runs the probe leg alone.
      const entry = sweepRegistry.find((candidate) => candidate.name === 'sweep.unit');
      const op = await entry?.importer();
      if (op === undefined) throw new Error('importer resolved undefined');
      const prepDispatch: Record<string, unknown> = {
        repoRoot: VALID.repoRoot,
        worktreesDir: VALID.worktreesDir,
        runPrefix: VALID.runPrefix,
        base: VALID.base,
        package: VALID.package,
        fixer: VALID.fixer,
        files: VALID.files,
        mode: 'prep',
        check: VALID.check,
      };
      // Registry-schema admission WITHOUT a driver section.
      expect(SweepUnitDispatchInputSchema.safeParse(prepDispatch).success).toBe(true);
      // The op needs a REAL worktree to probe, so run it against a scratch repo
      // generated into a tmpdir (the prep evidence is the pin).
      const { mkdtempSync } = await import('node:fs');
      const root = mkdtempSync(join(tmpdir(), 'd4-prep-dispatch-'));
      CLEANUP.push(root);
      const repo = join(root, 'repo');
      await generateScratchRepo(repo);
      prepDispatch.repoRoot = repo;
      const result = await op(prepDispatch);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const report = result.value as {
        mode?: string;
        baseline?: { verdict?: string };
        final?: unknown;
      };
      expect(report.mode).toBe('prep');
      expect(report.baseline?.verdict).toBe('failing'); // alpha's seeded failure
      expect(report.final).toBeUndefined(); // no AFTER probe in prep
      // Fix-mode dispatch WITHOUT driver: the binding refusal is unchanged.
      const fixWithoutDriver = await op({
        repoRoot: VALID.repoRoot,
        worktreesDir: VALID.worktreesDir,
        runPrefix: VALID.runPrefix,
        base: VALID.base,
        package: VALID.package,
        fixer: VALID.fixer,
        files: VALID.files,
        check: VALID.check,
      });
      expect(fixWithoutDriver.status).toBe('failed');
      expect(fixWithoutDriver.status === 'failed' && fixWithoutDriver.error).toMatch(
        /no driver config/,
      );
    },
  );

  test('jhDi6: an omitted check timeoutMs binds the advertised 600s default', () => {
    const noTimeout = bindingsFromDispatch({
      ...VALID,
      check: {
        adapter: 'tsc-lines' as const,
        command: 'node',
        args: ['scripts/check.js', '{package}'],
      },
    });
    const command = noTimeout.checkCommand(
      { package: 'alpha', fixer: 'fix', files: [] },
      '/worktrees/fix/alpha',
    );
    expect(command.timeoutMs).toBe(600_000);
    // An explicit timeout still wins.
    const explicit = bindingsFromDispatch({
      ...VALID,
      check: {
        adapter: 'tsc-lines',
        command: 'node',
        args: ['scripts/check.js', '{package}'],
        timeoutMs: 5000,
      },
    });
    expect(
      explicit.checkCommand({ package: 'alpha', fixer: 'fix', files: [] }, '/wt').timeoutMs,
    ).toBe(5000);
  });

  test('jhDjZ: {package} interpolation uses replacement CALLBACKS (a $& package stays literal)', () => {
    const hostile = bindingsFromDispatch({
      ...VALID,
      package: '$&',
      check: {
        adapter: 'tsc-lines',
        command: 'node',
        args: ['scripts/check.js', '{package}'],
      },
      promptTemplate: 'fix {package} in {worktree} as {fixer}',
    });
    const command = hostile.checkCommand({ package: '$&', fixer: 'fix', files: [] }, '/wt');
    // Replacement-STRING semantics would turn '$&' into the whole match
    // ('{package}') — the callback keeps the package name literal.
    expect(command.args).toEqual(['scripts/check.js', '$&']);
    const prompt = hostile.prompt?.({ package: '$&', fixer: 'fix', files: [] }, {
      path: '/wt',
    } as never);
    expect(prompt).toContain('fix $& in /wt');
  });

  test('bindingsFromDispatch defaults the push leg ON (push:false opts out)', () => {
    expect(bindingsFromDispatch(VALID).pushBranch).toBeDefined();
    expect(bindingsFromDispatch({ ...VALID, push: false }).pushBranch).toBeUndefined();
    // The prompt template: the shipped default, placeholders substituted
    // (fix-mode bindings carry the prompt; prep omits it).
    const bindings = bindingsFromDispatch(VALID);
    expect(bindings.prompt).toBeDefined();
    const expected = DEFAULT_UNIT_PROMPT_TEMPLATE.replaceAll('{package}', 'alpha')
      .replaceAll('{fixer}', 'fix')
      .replaceAll('{worktree}', '/worktrees/fix/alpha');
    expect(
      bindings.prompt?.({ package: 'alpha', fixer: 'fix', files: [] }, {
        path: '/worktrees/fix/alpha',
      } as never),
    ).toBe(expected);
    const prepBindings = bindingsFromDispatch({ ...VALID, mode: 'prep' });
    expect(prepBindings.prompt).toBeUndefined();
    expect(prepBindings.driver).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The push leg on a real (local, offline) origin
// ---------------------------------------------------------------------------

describe('sweep.unit dispatch defaults (VB3D F10)', () => {
  test('the unit op sessions-dir default equals the driver layer’s own default', async () => {
    const { defaultSessionsDir } = await import('../../../src/ops/sweep/unit.js');
    const os = await import('node:os');
    // The driver layer's documented default (src/driver/subprocess/index.ts):
    // a driver constructed WITHOUT sessionsDir creates its records under
    // <os.tmpdir()>/cq-harness/sessions — the shipped binding must agree.
    const driverDefault = join(os.tmpdir(), 'cq-harness', 'sessions');
    expect(defaultSessionsDir()).toBe(driverDefault);
  });
});

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
