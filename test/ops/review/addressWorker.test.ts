import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as gitMutex from '../../../src/shared/gitMutex.js';
import { makeAddressWorker, type AddressAttempt } from '../../../src/ops/review/addressWorker.js';
import { resolveCqConfigDefaults } from '../../../src/ops/analyze/cqConfigDefaults.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { OpInvocation } from '../../../src/driver/types.js';
import { makeRepoDiffScanner, type DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';

const role = { provider: 'mock', model: 'worker' };
const finding = (file = 'src/a.ts'): Finding => ({
  id: file,
  source: 'agent',
  file,
  line: 1,
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open',
});
async function fixture(
  handler?: (input: OpInvocation) => Promise<unknown>,
  check = '',
  options: {
    scannerFails?: boolean;
    parentSignal?: AbortSignal;
    maxTokens?: number;
    workerAttempts?: number;
    rescueBase?: number;
    aliasRoot?: boolean;
    installedDependencies?: 'matching' | 'mismatched';
    firstStopReason?: 'budget' | 'aborted' | 'error';
    costUSD?: number;
    remainingWallMs?: () => number;
    unitWallMs?: number;
    configure?: (config: CqConfig) => void;
    scanner?: DiffSecretScanner;
    providerRequest?: boolean;
    indexIdentityUnavailable?: boolean;
    gitHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    runPrefix?: string;
    objectFormat?: 'sha256';
  } = {},
) {
  const repo = await makeTestRepo(
    options.objectFormat ? { objectFormat: options.objectFormat } : {},
  );
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  await repo.write('src/a.ts', 'BAD\n');
  await repo.write('src/b.ts', 'BAD\n');
  await repo.write('scripts/check.cjs', check || 'process.exitCode = 0;\n');
  repo.commitAll('fixture');
  const initial = repo.git('rev-parse', 'HEAD').trim();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-test-'));
  const alias = join(journal, 'repo-alias');
  if (options.aliasRoot) await symlink(repo.root, alias, 'dir');
  const dependencyRoot = join(journal, 'installed-caller');
  if (options.installedDependencies) {
    await mkdir(join(dependencyRoot, 'node_modules'), { recursive: true });
    await repo.write('package.json', '{"name":"fixture"}\n');
    await repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    await writeFile(
      join(dependencyRoot, 'package.json'),
      options.installedDependencies === 'matching'
        ? '{"name":"fixture"}\n'
        : '{"name":"different"}\n',
    );
    await writeFile(join(dependencyRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(join(dependencyRoot, 'node_modules/check.cjs'), 'process.exitCode = 0;\n');
    repo.commitAll('dependency metadata');
  }
  const attempts: AddressAttempt[] = [];
  let spent = 0,
    calls = 0;
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      {
        adapter: 'tsc-lines',
        command: {
          command: process.execPath,
          args: [options.installedDependencies ? 'node_modules/check.cjs' : 'scripts/check.cjs'],
        },
      },
    ],
    roles: {
      worker: role,
      rescue: { ...role, model: 'rescue' },
      reviewer: { ...role, model: 'reviewer' },
    },
    budgets: {
      run: { maxTokens: options.maxTokens ?? 10000, wallMs: 20000 },
      step: { wallMs: 5000 },
      ...(options.unitWallMs === undefined ? {} : { unit: { wallMs: options.unitWallMs } }),
    },
    escalation: {
      workerAttempts: options.workerAttempts ?? 1,
      rescueBase: options.rescueBase ?? 0,
    },
    review: { reviewers: ['agent'] },
  };
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          calls++;
          if (options.providerRequest)
            await request.beforeRequest?.('synthetic request', [
              { text: 'synthetic tool output', path: 'src/a.ts' },
            ]);
          const output = handler
            ? await handler(input)
            : await (async () => {
                if (input.outputSchema?.name === 'review.address.closure/v1')
                  return { closed: true, reason: 'candidate fixed' };
                if (
                  input.prompt.includes('initial finding') ||
                  input.prompt.includes('worker retry')
                )
                  await writeFile(
                    join(
                      input.workspace!.path,
                      input.prompt.includes('src/b.ts') ? 'src/b.ts' : 'src/a.ts',
                    ),
                    'GOOD\n',
                  );
                return { disposition: 'fixed', reason: 'fixed', evidence: [] };
              })();
          return {
            stopReason: calls === 1 ? (options.firstStopReason ?? 'complete') : 'complete',
            structuredOutput: output,
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            ...(options.costUSD === undefined ? {} : { costUSD: options.costUSD }),
            denials: [],
          };
        },
      },
    }),
  };
  options.configure?.(config);
  const git = makeGhRunner({ bin: 'git', cwd: repo.root });
  let identityRequests = 0;
  const engine = makeAddressWorker({
    git: async (args) => {
      if (args.includes('--absolute-git-dir')) {
        identityRequests++;
        if (options.indexIdentityUnavailable)
          return { code: 1, stdout: '', stderr: 'identity unavailable' };
      }
      return options.gitHook ? options.gitHook(args, git) : git(args);
    },
    drivers,
    repoRoot: options.aliasRoot ? alias : repo.root,
    ...(options.installedDependencies ? { dependencyRoot } : {}),
    journalDir: journal,
    policy: resolveCqConfigDefaults(config, { packageName: 'fixture' }),
    attempts,
    ...(options.runPrefix ? { runPrefix: options.runPrefix } : {}),
    remainingTokens: () => config.budgets!.run!.maxTokens! - spent,
    remainingWallMs: options.remainingWallMs ?? (() => 20000),
    account: (r) => {
      spent += r.usage.input + r.usage.output;
    },
    scanner:
      options.scanner ??
      (async (components) => {
        if (options.scannerFails) throw new Error('scanner unavailable');
        return components.map((c) => ({ component: c.component, hits: [] }));
      }),
    ...(options.parentSignal ? { parentSignal: options.parentSignal } : {}),
  });
  return {
    repo,
    engine,
    attempts,
    initial,
    calls: () => calls,
    identityRequests: () => identityRequests,
    cleanup: async () => {
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    },
  };
}

describe('review.address failed-attempt branches', () => {
  test('SHA256 failure branches are ordinary single-parent commits with create-only identity', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'SHA256 PARTIAL\n');
        throw new Error('partial failure');
      },
      '',
      { objectFormat: 'sha256' },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      const retained = result.failedAttempts![0]!;
      expect(retained.sha).toMatch(/^[a-f0-9]{64}$/);
      expect(f.repo.git('rev-parse', retained.branch).trim()).toBe(retained.sha);
      expect(f.repo.git('rev-list', '--parents', '-n', '1', retained.sha).trim()).toBe(
        `${retained.sha} ${f.initial}`,
      );
      expect(f.repo.git('show', `${retained.branch}:src/a.ts`)).toBe('SHA256 PARTIAL\n');
    } finally {
      await f.cleanup();
    }
  });
  test('collision exhaustion is bounded and preserves unarchived owned bytes', async () => {
    let collisions = 0;
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'UNCAPTURED\n');
        throw new Error('failure');
      },
      '',
      {
        gitHook: async (args, run) => {
          if (args.includes('update-ref') && args.some((arg) => arg.includes('/failed/'))) {
            collisions++;
            return { code: 1, stdout: '', stderr: 'reference already exists' };
          }
          if (
            args.includes('rev-parse') &&
            args.some((arg) => arg.startsWith('refs/heads/cq-address/'))
          )
            return run(['rev-parse', 'HEAD']);
          return run(args);
        },
      },
    );
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status).toBe('deferred');
      expect(result.reason).toContain('collision limit');
      expect(collisions).toBe(32);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('UNCAPTURED\n');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
    } finally {
      await f.cleanup();
    }
  });

  test('failed capture owns only its assigned file while a concurrent sibling remains dirty', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(async (input) => {
      const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
      if (file === 'src/b.ts') {
        await writeFile(join(input.workspace!.path, file), 'SIBLING DIRTY\n');
        entered();
        await gate;
        throw new Error('sibling failed');
      }
      await writeFile(join(input.workspace!.path, file), 'OWNED PARTIAL\n');
      throw new Error('owned failed');
    });
    let sibling: ReturnType<typeof f.engine.fix> | undefined;
    try {
      sibling = f.engine.fix(finding('src/b.ts'), 1);
      await held;
      const failed = await f.engine.fix(finding(), 1);
      const retained = failed.failedAttempts![0]!;
      expect(retained.executionHead).toBe(f.initial);
      expect(retained.parent).toBe(f.initial);
      expect(retained.tier).toBe('worker');
      expect(f.repo.git('rev-parse', retained.branch).trim()).toBe(retained.sha);
      expect(f.repo.git('rev-list', '--parents', '-n', '1', retained.sha).trim()).toBe(
        `${retained.sha} ${f.initial}`,
      );
      expect(f.repo.git('diff', '--name-only', retained.parent, retained.sha).trim()).toBe(
        'src/a.ts',
      );
      expect(f.repo.git('show', `${retained.sha}:src/a.ts`)).toBe('OWNED PARTIAL\n');
      expect(f.repo.git('show', `${retained.sha}:src/b.ts`)).toBe('BAD\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('SIBLING DIRTY\n');
      expect(f.repo.git('show', '-s', '--format=%an <%ae>%n%B', retained.sha)).toContain(
        'CQ fix engine <cq-fix-engine@invalid>',
      );
      expect(f.repo.git('show', '-s', '--format=%B', retained.sha)).toContain('Cq-Tier: worker');
      expect(JSON.parse(failed.finding.evidence!)).toEqual(retained);
      expect(f.attempts[1]!.failedAttempt).toEqual(retained);
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/stash', 'refs/cq')).toBe('');
      release();
      const other = await sibling;
      expect(other.failedAttempts![0]!.sha).not.toBe(retained.sha);
      expect(
        f.repo
          .git(
            'diff',
            '--name-only',
            other.failedAttempts![0]!.parent,
            other.failedAttempts![0]!.sha,
          )
          .trim(),
      ).toBe('src/b.ts');
    } finally {
      release();
      await sibling;
      await f.cleanup();
    }
  });
  test('collisions preserve existing branches and worker/rescue history continues ordinals', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(
          join(input.workspace!.path, 'src/a.ts'),
          `${input.modelSpec.model} PARTIAL\n`,
        );
        throw new Error('provider failed');
      },
      '',
      { workerAttempts: 2, rescueBase: 1, runPrefix: 'cq-address/collision' },
    );
    try {
      const collision = 'cq-address/collision/failed/review/fixture/src-a-ts/a1';
      f.repo.git('update-ref', `refs/heads/${collision}`, f.initial);
      const failed = await f.engine.fix(finding(), 1);
      expect(failed.failedAttempts?.map((row) => [row.ordinal, row.tier])).toEqual([
        [2, 'worker'],
        [3, 'worker'],
        [4, 'rescue'],
      ]);
      expect(f.repo.git('rev-parse', collision).trim()).toBe(f.initial);
      for (const row of failed.failedAttempts!) {
        expect(f.repo.git('rev-parse', row.branch).trim()).toBe(row.sha);
        expect(f.repo.git('show', '-s', '--format=%B', row.sha)).toContain(
          `Cq-Attempt: ${row.ordinal}`,
        );
        expect(f.repo.git('rev-parse', `${row.sha}^`).trim()).toBe(f.initial);
      }
      expect(f.attempts.map((row) => row.failedAttempt?.sha)).toEqual(
        failed.failedAttempts!.map((row) => row.sha),
      );
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['clean', 'tainted'] as const)(
    '%s immutable leaf whitespace reaches the configured path policy before rescue',
    async (mode) => {
      const leaf = mode === 'tainted' ? ' PRIVATE\n' : ' PUBLIC\n';
      const scans: Array<Array<{ text: string; path?: string }>> = [];
      let configured: DiffSecretScanner;
      let rescueCalls = 0;
      const f = await fixture(
        async (input) => {
          if (input.modelSpec.model === 'worker') {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), leaf);
            throw new Error('retain whitespace');
          }
          rescueCalls++;
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'rescued' };
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          return { disposition: 'fixed', reason: 'rescued', evidence: [] };
        },
        '',
        {
          rescueBase: 1,
          providerRequest: true,
          configure: (config) => {
            config.review!.denylistPatternsFile = 'patterns.yml';
          },
          scanner: async (components) => {
            if (components.some((part) => part.path === '.git/cq-failed-commit-message'))
              scans.push([...components]);
            return configured(components);
          },
        },
      );
      try {
        await f.repo.write(
          'patterns.yml',
          "rules:\n  - id: private-leaf\n    description: anchored whitespace\n    regex: '^ PRIVATE'\n    path: '^src/a\\.ts$'\n    sample: ' PRIVATE'\nclean_probes:\n  - ' PUBLIC'\n",
        );
        f.repo.commitAll('configured leaf policy');
        configured = makeRepoDiffScanner(f.repo.root, 'patterns.yml');
        const result = await f.engine.fix(finding(), 1);
        expect(result.finding.status, result.reason).toBe(
          mode === 'tainted' ? 'deferred' : 'fixed',
        );
        expect(rescueCalls).toBe(mode === 'tainted' ? 0 : 3);
        expect(scans).toHaveLength(mode === 'tainted' ? 1 : 4);
        for (const scan of scans) {
          expect(
            scan
              .filter((part) => part.path === 'src/a.ts')
              .slice(-2)
              .map((part) => part.text),
          ).toEqual(['BAD\n', leaf]);
        }
        expect(f.repo.git('show', `${result.failedAttempts![0]!.sha}:src/a.ts`)).toBe(leaf);
        if (mode === 'tainted') expect(result.reason).toMatch(/upload/);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each(['clean', 'positive', 'feedback-positive', 'missing', 'fault'] as const)(
    '%s immutable feedback is scanned before rescue edit and feedback',
    async (mode) => {
      const scans: Array<Array<{ text: string; path?: string }>> = [];
      const prompts: string[] = [];
      const f = await fixture(
        async (input) => {
          if (input.modelSpec.model === 'worker') {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'RETAINED PARTIAL\n');
            throw new Error('worker failure provenance');
          }
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'rescued' };
          prompts.push(input.prompt);
          if (!input.prompt.startsWith('related-check feedback')) {
            expect(await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8')).toBe('BAD\n');
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          }
          return { disposition: 'fixed', reason: 'rescued', evidence: [] };
        },
        '',
        {
          rescueBase: 1,
          providerRequest: true,
          scanner: async (components) => {
            if (components.some((part) => part.text.includes('Cq-Tier: worker'))) {
              scans.push([...components]);
              if (mode === 'fault') throw new Error('feedback scanner unavailable');
              if (mode === 'missing') return [];
              if (
                mode === 'positive' ||
                (mode === 'feedback-positive' &&
                  components[0]!.text.startsWith('related-check feedback'))
              )
                return components.map((part) => ({
                  component: part.component,
                  hits: [{ ruleId: 'tainted', lines: [1] }],
                }));
            }
            return components.map((part) => ({ component: part.component, hits: [] }));
          },
        },
      );
      try {
        const result = await f.engine.fix(finding(), 1);
        expect(result.failedAttempts!.length).toBeGreaterThan(0);
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(scan.some((part) => part.text === 'BAD\n')).toBe(true);
          expect(scan.some((part) => part.text === 'RETAINED PARTIAL\n')).toBe(true);
          expect(
            scan.some(
              (part) =>
                part.path === '.git/cq-failed-commit-message' &&
                part.text.includes('worker failure provenance'),
            ),
          ).toBe(true);
        }
        if (mode === 'clean') {
          expect(result.finding.status, result.reason).toBe('fixed');
          expect(prompts).toHaveLength(2);
          expect(prompts.every((prompt) => prompt.includes('+RETAINED PARTIAL'))).toBe(true);
          // Both invocation-boundary scans and provider-boundary scans include immutable contents.
          expect(scans).toHaveLength(4);
        } else {
          expect(result.finding.status).toBe('deferred');
          expect(prompts).toHaveLength(mode === 'feedback-positive' ? 1 : 0);
          expect(f.calls()).toBe(mode === 'feedback-positive' ? 2 : 1);
          expect(result.reason).toMatch(/upload/);
          expect(result.failedAttempts).toHaveLength(mode === 'feedback-positive' ? 2 : 1);
          expect(
            f.attempts
              .filter((row) => row.invocation === 'edit')
              .map((row) => row.failedAttempt?.sha),
          ).toEqual(result.failedAttempts!.map((row) => row.sha));
        }
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a failed sibling uses the verified parent but retains its earlier dispatch head', async () => {
    let bothEdited!: () => void, releaseFailure!: () => void;
    let edits = 0;
    const ready = new Promise<void>((r) => {
      bothEdited = r;
    });
    const failGate = new Promise<void>((r) => {
      releaseFailure = r;
    });
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'closed' };
      if (input.prompt.startsWith('related-check feedback'))
        return { disposition: 'fixed', reason: 'feedback', evidence: [] };
      const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
      await writeFile(
        join(input.workspace!.path, file),
        file === 'src/a.ts' ? 'GOOD\n' : 'FAILED SIBLING\n',
      );
      if (++edits === 2) bothEdited();
      await ready;
      if (file === 'src/b.ts') {
        await failGate;
        throw new Error('sibling failure');
      }
      return { disposition: 'fixed', reason: 'edited', evidence: [] };
    });
    let a: ReturnType<typeof f.engine.fix> | undefined,
      b: ReturnType<typeof f.engine.fix> | undefined;
    try {
      a = f.engine.fix(finding(), 1);
      b = f.engine.fix(finding('src/b.ts'), 1);
      const fixed = await a;
      expect(fixed.finding.status, fixed.reason).toBe('fixed');
      releaseFailure();
      const failed = await b;
      const retained = failed.failedAttempts![0]!;
      expect(retained.executionHead).toBe(f.initial);
      expect(retained.parent).toBe(fixed.commit);
      expect(f.repo.git('show', `${retained.sha}:src/a.ts`)).toBe('GOOD\n');
      expect(f.repo.git('diff', '--name-only', retained.parent, retained.sha).trim()).toBe(
        'src/b.ts',
      );
    } finally {
      releaseFailure();
      await Promise.allSettled([a, b]);
      await f.cleanup();
    }
  });
  test('a moved failed branch refuses rescue feedback without losing its recorded SHA', async () => {
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        throw new Error('provider failure');
      },
      '',
      {
        rescueBase: 1,
        gitHook: async (args, run) => {
          const ref = args.find((arg) => arg.startsWith('refs/heads/cq-address/'));
          if (args.includes('rev-parse') && args.includes('--verify') && ref)
            await run(['update-ref', ref, 'HEAD']);
          return run(args);
        },
      },
    );
    try {
      const failed = await f.engine.fix(finding(), 1);
      expect(failed.reason).toContain('no longer matches');
      expect(f.calls()).toBe(1);
      expect(failed.failedAttempts).toHaveLength(1);
      expect(f.repo.git('show', `${failed.failedAttempts![0]!.sha}:src/a.ts`)).toBe('PARTIAL\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test('execution admission waits for sibling commit verification and registration', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let heldOnce = false;
    const f = await fixture(undefined, '', {
      gitHook: async (args, run) => {
        if (!heldOnce && args.at(-2) === 'rev-parse' && args.at(-1)?.endsWith('^')) {
          heldOnce = true;
          entered();
          await gate;
        }
        return run(args);
      },
    });
    let first: ReturnType<typeof f.engine.fix> | undefined,
      second: ReturnType<typeof f.engine.fix> | undefined;
    try {
      first = f.engine.fix(finding(), 1);
      await held;
      const unregistered = f.repo.git('rev-parse', 'HEAD').trim();
      expect(unregistered).not.toBe(f.initial);
      second = f.engine.fix(finding('src/b.ts'), 1);
      await new Promise<void>((r) => setTimeout(r, 30));
      expect(f.attempts.some((row) => row.finding === 'src/b.ts')).toBe(false);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.finding.status, a.reason).toBe('fixed');
      expect(b.finding.status, b.reason).toBe('fixed');
      expect(b.observedHead).toBe(a.commit);
      expect(f.repo.git('rev-parse', `${b.commit}^`).trim()).toBe(a.commit);
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await f.cleanup();
    }
  });
});

describe('review.address candidate isolation', () => {
  test.each(['unused', 'unanchored', 'unsafe'] as const)(
    'an %s worker leaves no asynchronous lock setup beyond its lifetime',
    async (mode) => {
      const f = await fixture(undefined, '', { indexIdentityUnavailable: true });
      try {
        if (mode !== 'unused') {
          const item = finding(mode === 'unsafe' ? '../outside.ts' : undefined);
          if (mode === 'unanchored') delete item.file;
          const fix = await f.engine.fix(item, 1);
          expect(fix.finding.status).toBe('deferred');
          expect(fix.commit).toBeUndefined();
        }
        // Let constructor-started I/O settle before the fixture is disposed.
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(f.identityRequests()).toBe(0);
        expect(f.calls()).toBe(0);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('unavailable checkout identity refuses every mutation and worker dispatch', async () => {
    const f = await fixture(undefined, '', { indexIdentityUnavailable: true });
    try {
      const results = await Promise.all([
        f.engine.fix(finding(), 1),
        f.engine.fix(finding('src/b.ts'), 1),
      ]);
      for (const result of results) {
        expect(result.finding.status).toBe('deferred');
        expect(result.reason).toContain('checkout index identity unavailable');
        expect(result.commit).toBeUndefined();
      }
      expect(f.identityRequests()).toBe(1);
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('status', '--porcelain')).toBe('');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['tracked', 'untracked'] as const)(
    'pre-existing %s edits are never adopted as worker output or erased',
    async (mode) => {
      const f = await fixture();
      const path = mode === 'tracked' ? 'src/a.ts' : 'src/owner.ts';
      try {
        await f.repo.write(path, 'OWNER CONTENT\n');
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(/clean tracked worker tree|no unknown worker files/);
        expect(f.calls()).toBe(0);
        expect(f.attempts).toEqual([]);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        expect(await readFile(join(f.repo.root, path), 'utf8')).toBe('OWNER CONTENT\n');
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a provider error can reach rescue with paid attempt cost retained', async () => {
    const f = await fixture(
      async (input) => {
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'rescued candidate closed' };
        if (!input.prompt.startsWith('related-check feedback'))
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        return { disposition: 'fixed', reason: 'edited candidate', evidence: [] };
      },
      '',
      {
        firstStopReason: 'error',
        rescueBase: 1,
        costUSD: 0.01,
      },
    );
    try {
      const fixed = await f.engine.fix(finding(), 1);
      expect(fixed.finding.status, fixed.reason).toBe('fixed');
      expect(f.attempts.map((a) => a.tier)).toEqual(['worker', 'rescue', 'rescue', 'reviewer']);
      expect(f.attempts.every((a) => a.costUSD === 0.01)).toBe(true);
      expect(f.attempts[0]?.failedAttempt?.sha).toBeTruthy();
      expect(f.attempts[1]?.reason).toMatch(/worker stopped: error/);
      expect(f.repo.git('show', '--format=', '--name-only', fixed.commit!).trim()).toBe('src/a.ts');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['positive', 'missing', 'fault'] as const)(
    'a %s tool-result scan refuses provider send and preserves sibling eligibility',
    async (mode) => {
      let providerSends = 0;
      let blocked = false;
      const f = await fixture(
        async (input) => {
          providerSends++;
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'verified sibling' };
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/b.ts'), 'GOOD\n');
          return { disposition: 'fixed', reason: 'sibling fixed', evidence: [] };
        },
        '',
        {
          providerRequest: true,
          scanner: async (components) => {
            const tool = components.find((c) => c.text === 'synthetic tool output');
            if (tool && !blocked) {
              blocked = true;
              if (mode === 'fault') throw new Error('tool scanner unavailable');
              if (mode === 'missing') return [];
              return components.map((c) => ({
                component: c.component,
                hits: c === tool ? [{ ruleId: 'synthetic-policy', lines: [1] }] : [],
              }));
            }
            return components.map((c) => ({ component: c.component, hits: [] }));
          },
        },
      );
      try {
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(/upload refused|upload scanner failed/);
        expect(providerSends).toBe(0);
        expect(f.attempts).toHaveLength(1);
        expect(refused.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
        expect(providerSends).toBe(3);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    'missing-evidence',
    'missing-line',
    'edited-disposition',
    'missing-reviewer',
  ] as const)('a rejection cannot close without engine-verifiable evidence: %s', async (mode) => {
    const f = await fixture(
      async (input) => {
        if (mode === 'edited-disposition')
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        return {
          disposition: 'rejected',
          reason: 'model asserts false positive',
          evidence:
            mode === 'missing-evidence'
              ? []
              : [{ path: 'src/a.ts', line: mode === 'missing-line' ? 1000 : 1 }],
        };
      },
      '',
      {
        configure: (config) => {
          if (mode === 'missing-reviewer') delete config.roles!.reviewer;
        },
      },
    );
    try {
      const refused = await f.engine.fix(finding(), 1);
      expect(refused.finding.status).toBe('deferred');
      expect(refused.reason).toMatch(
        /execution-head evidence|missing at execution head|accompanied by edits|roles.reviewer required/,
      );
      expect(f.calls()).toBe(1);
      expect(refused.commit).toBeUndefined();
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['reviewer', 'check-cwd', 'check-spawn'] as const)(
    'a changed candidate cannot commit with unavailable trusted validation: %s',
    async (mode) => {
      const f = await fixture(undefined, '', {
        configure: (config) => {
          if (mode === 'reviewer') delete config.roles!.reviewer;
          if (mode === 'check-cwd') config.checks[0]!.command.cwd = '..';
          if (mode === 'check-spawn')
            config.checks[0]!.command.command = join(tmpdir(), 'cq-missing-executable', 'check');
        },
      });
      try {
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(
          /roles.reviewer required|check.cwd escapes|configured check was/,
        );
        expect(f.calls()).toBe(mode === 'reviewer' ? 2 : 1);
        expect(refused.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        expect(f.attempts.some((a) => a.failedAttempt?.sha)).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each(['matching', 'mismatched'] as const)(
    'fresh worker tree reuses installed caller dependencies only with matching metadata: %s',
    async (installedDependencies) => {
      const f = await fixture(undefined, '', { installedDependencies });
      try {
        const result = await f.engine.fix(finding(), 1);
        if (installedDependencies === 'matching') {
          expect(result.commit, result.reason).toBeTruthy();
          expect(result.validation.every((gate) => gate.verdict === 'pass')).toBe(true);
        } else {
          expect(result.commit).toBeUndefined();
          expect(result.reason).toContain('manifests/locks differ');
          expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        }
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([false, true])(
    'canonical and aliased roots preserve task identity (alias=%s)',
    async (aliasRoot) => {
      const f = await fixture(undefined, '', { aliasRoot });
      try {
        const result = await f.engine.fix(finding('src/./a.ts'), 1);
        expect(result.commit, result.reason).toBeTruthy();
        expect(result.finding.file).toBe('src/a.ts');
        expect(f.calls()).toBe(3);
        expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      } finally {
        await f.cleanup();
      }
    },
  );
  test('outside symlink and missing files refuse before worker dispatch even through an aliased root', async () => {
    const f = await fixture(undefined, '', { aliasRoot: true });
    const outside = await mkdtemp(join(tmpdir(), 'cq-address-outside-'));
    try {
      await writeFile(join(outside, 'private.ts'), 'PRIVATE\n');
      await symlink(join(outside, 'private.ts'), join(f.repo.root, 'src/outside.ts'));
      for (const file of ['src/outside.ts', 'src/missing.ts']) {
        const result = await f.engine.fix(finding(file), 1);
        expect(result.commit).toBeUndefined();
        expect(result.finding.status).toBe('deferred');
      }
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(outside, 'private.ts'), 'utf8')).toBe('PRIVATE\n');
    } finally {
      await f.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });
  test('commits only a staged candidate that passed mandatory feedback, broader and closure gates', async () => {
    const f = await fixture();
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status, fix.reason).toBe('fixed');
      expect(fix.observedHead).toBe(f.initial);
      expect(fix.commit).toBe(f.repo.git('rev-parse', 'HEAD').trim());
      expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      expect(f.attempts.map((a) => a.invocation)).toEqual(['edit', 'feedback', 'closure']);
      expect(fix.validation[0]?.gates.map((g) => g.gate)).toEqual([
        'related',
        'broader',
        'paths',
        'tamper',
        'commit',
      ]);
      expect(f.repo.git('status', '--porcelain').trim()).toBe('');
    } finally {
      await f.cleanup();
    }
  });
  test('a provider exception after editing preserves evidence and restores the owned file', async () => {
    const f = await fixture(async (input) => {
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
      throw new Error('provider failed');
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toContain('provider failed');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      expect(f.attempts[0]?.failedAttempt?.branch).toMatch(/^cq-address\/[^/]+\/failed\/review\//);
      expect(f.repo.git('show', `${f.attempts[0]!.failedAttempt?.sha}:src/a.ts`)).toContain(
        'PARTIAL',
      );
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  });
  test('scanner faults and parent cancellation dispatch no worker', async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      if (cancelled) controller.abort();
      const f = await fixture(undefined, '', {
        scannerFails: !cancelled,
        parentSignal: controller.signal,
      });
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe('deferred');
        expect(f.calls()).toBe(0);
        expect(fix.reason).toMatch(/scanner unavailable|parent cancelled/);
      } finally {
        await f.cleanup();
      }
    }
  });
  test('protected scope refuses before dispatch or configured check execution', async () => {
    const f = await fixture();
    try {
      const fix = await f.engine.fix(finding('package.json'), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(f.calls()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test('out-of-scope edits refuse and cannot be absorbed into a commit', async () => {
    const f = await fixture(async (input) => {
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      await writeFile(join(input.workspace!.path, 'src/b.ts'), 'ALIEN\n');
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toContain('out-of-scope');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('diff', '--cached', '--name-only').trim()).toBe('');
    } finally {
      await f.cleanup();
    }
  });
  test('uncommitted sibling bytes cannot make the assigned related check or closure pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let edits = 0,
      maximum = 0,
      running = 0;
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate closure' };
      if (!input.prompt.startsWith('related-check feedback')) {
        running++;
        maximum = Math.max(maximum, running);
        const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
        await writeFile(join(input.workspace!.path, file), 'GOOD\n');
        edits++;
        if (edits === 2) release();
        await gate;
        running--;
      }
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    }, `const fs = require('node:fs'); const a = fs.readFileSync('src/a.ts','utf8'); const b = fs.readFileSync('src/b.ts','utf8'); if(a.includes('GOOD') && !b.includes('GOOD')) { console.log('src/a.ts(1,1): error TS9999: sibling required'); process.exitCode=1; }`);
    try {
      const [a, b] = await Promise.all([
        f.engine.fix(finding(), 1),
        f.engine.fix(finding('src/b.ts'), 1),
      ]);
      expect(maximum).toBe(2);
      // If b commits first, a may pass over that verified parent. It may
      // never pass while b exists only in the shared worker tree.
      if (a.commit) expect(f.repo.git('show', `${a.commit}^:src/b.ts`)).toContain('GOOD');
      else expect(a.finding.status).toBe('deferred');
      expect(b.finding.status, b.reason).toBe('fixed');
      expect(f.repo.git('show', '--format=', '--name-only', b.commit!).trim()).toBe('src/b.ts');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['related', 'closure'] as const)(
    'a %s gate cannot borrow a held sibling edit',
    async (gateKind) => {
      let siblingEdited!: () => void, releaseSibling!: () => void;
      const edited = new Promise<void>((resolve) => {
        siblingEdited = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      const f = await fixture(
        async (input) => {
          if (input.outputSchema?.name === 'review.address.closure/v1') {
            const b = await readFile(join(input.workspace!.path, 'src/b.ts'), 'utf8');
            return {
              closed: gateKind !== 'closure' || b.includes('GOOD'),
              reason: 'requires verified sibling bytes',
            };
          }
          if (!input.prompt.startsWith('related-check feedback')) {
            const isB = input.prompt.includes('Address only src/b.ts');
            await writeFile(join(input.workspace!.path, isB ? 'src/b.ts' : 'src/a.ts'), 'GOOD\n');
            if (isB) {
              siblingEdited();
              await held;
            } else await edited;
          }
          return { disposition: 'fixed', reason: 'claim', evidence: [] };
        },
        gateKind === 'related'
          ? `const fs=require('node:fs'); if(fs.readFileSync('src/a.ts','utf8').includes('GOOD') && !fs.readFileSync('src/b.ts','utf8').includes('GOOD')) {console.log('src/a.ts(1,1): error TS9999: requires sibling');process.exitCode=1;}`
          : 'process.exitCode=0;',
      );
      const b = f.engine.fix(finding('src/b.ts'), 1);
      try {
        const a = await f.engine.fix(finding(), 1);
        expect(a.commit).toBeUndefined();
        expect(a.finding.status).toBe('deferred');
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('GOOD\n');
        releaseSibling();
        const fixedB = await b;
        expect(fixedB.finding.status, fixedB.reason).toBe('fixed');
        expect(f.repo.git('show', '--format=', '--name-only', fixedB.commit!).trim()).toBe(
          'src/b.ts',
        );
      } finally {
        releaseSibling();
        await b;
        await f.cleanup();
      }
    },
  );
  test('unit regression bypasses the remaining worker retry and reserves rescue', async () => {
    const f = await fixture(
      async (input) => {
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'verified rescue' };
        if (!input.prompt.startsWith('related-check feedback'))
          await writeFile(
            join(input.workspace!.path, 'src/a.ts'),
            input.modelSpec.model === 'rescue' ? 'GOOD SAFE\n' : 'GOOD REGRESSION\n',
          );
        return { disposition: 'fixed', reason: 'claim', evidence: [] };
      },
      `const fs=require('node:fs');if(fs.readFileSync('src/a.ts','utf8').includes('REGRESSION')){console.log('src/b.ts(1,1): error TS9999: new sibling failure');process.exitCode=1;}`,
      { workerAttempts: 2, rescueBase: 1 },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status, fix.reason).toBe('fixed');
      expect(f.attempts.filter((a) => a.invocation === 'edit').map((a) => a.tier)).toEqual([
        'worker',
        'rescue',
      ]);
      expect(
        f.attempts.some(
          (a) => a.tier === 'worker' && a.failedAttempt?.branch?.startsWith('cq-address/'),
        ),
      ).toBe(true);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('GOOD SAFE\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['budget', 'aborted'] as const)(
    'engine-observed driver %s stops this unit without rescue and retains paid usage/evidence',
    async (stopReason) => {
      const f = await fixture(undefined, '', {
        workerAttempts: 2,
        rescueBase: 1,
        firstStopReason: stopReason,
      });
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe('deferred');
        expect(fix.reason).toBe(`worker stopped: ${stopReason}`);
        expect(f.calls()).toBe(1);
        expect(f.attempts[0]?.usage).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 });
        expect(f.attempts[0]?.failedAttempt?.branch).toBeTruthy();
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    ['feedback', 'array index still off by one'],
    ['closure', 'array index still off by one'],
    ['feedback', 'budget calculation needs another correction'],
    ['closure', 'cancel button still uses the wrong handler'],
    ['edit', 'upload budget calculation needs correction'],
  ] as const)(
    'benign %s prose reaches rescue and does not stop siblings: %s',
    async (phase, reason) => {
      let rejectClosure = phase === 'closure';
      let rejectEdit = phase === 'edit';
      const f = await fixture(
        async (input) => {
          const file = input.prompt.includes('src/b.ts') ? 'src/b.ts' : 'src/a.ts';
          const firstWorker = input.modelSpec.model === 'worker' && file === 'src/a.ts';
          if (input.outputSchema?.name === 'review.address.closure/v1') {
            if (rejectClosure) {
              rejectClosure = false;
              return { closed: false, reason };
            }
            return { closed: true, reason: 'verified fix' };
          }
          if (rejectEdit && firstWorker) {
            rejectEdit = false;
            throw new Error(reason);
          }
          const feedback = input.prompt.startsWith('related-check feedback');
          if (!feedback) await writeFile(join(input.workspace!.path, file), 'GOOD\n');
          return {
            disposition: feedback && firstWorker && phase === 'feedback' ? 'deferred' : 'fixed',
            reason,
            evidence: [],
          };
        },
        '',
        { workerAttempts: 1, rescueBase: 1 },
      );
      try {
        const first = await f.engine.fix(finding(), 1);
        expect(first.finding.status, first.reason).toBe('fixed');
        expect(
          f.attempts
            .filter((a) => a.finding === 'src/a.ts' && a.invocation === 'edit')
            .map((a) => a.tier),
        ).toEqual(['worker', 'rescue']);
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
        expect(sibling.commit).toBeTruthy();
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a candidate reviewer mutation refuses the commit and retains the worker evidence', async () => {
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1') {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'TAMPER\n');
        return { closed: true, reason: 'claim despite mutation' };
      }
      if (!input.prompt.startsWith('related-check feedback'))
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.commit).toBeUndefined();
      expect(fix.reason).toContain('mutated');
      const calls = f.calls();
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.reason).toContain('mutated');
      expect(sibling.commit).toBeUndefined();
      expect(f.calls()).toBe(calls);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each([true, false])(
    'unchanged rejection requires reviewer confirmation: %s',
    async (closed) => {
      const f = await fixture(async (input) =>
        input.outputSchema?.name === 'review.address.closure/v1'
          ? { closed, reason: 'execution-head review' }
          : {
              disposition: 'rejected',
              reason: 'false positive',
              evidence: [{ path: 'src/a.ts', line: 1 }],
            },
      );
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe(closed ? 'rejected' : 'deferred');
        expect(fix.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('cancellation after worker editing restores evidence and starts no checks or feedback', async () => {
    const parent = new AbortController();
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        parent.abort();
        return { disposition: 'fixed', reason: 'late', evidence: [] };
      },
      '',
      { parentSignal: parent.signal },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.reason).toContain('cancelled');
      expect(f.calls()).toBe(1);
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.reason).toContain('cancelled');
      expect(f.calls()).toBe(1);
      expect(fix.validation).toEqual([]);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.attempts[0]?.failedAttempt?.branch).toBeTruthy();
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['success', 'cancel', 'budget', 'unit'] as const)(
    'queued candidate %s does not exhaust sibling mutex retries; cleanup stays serial',
    async (outcome) => {
      const parent = new AbortController();
      let wallRemaining = 20000;
      let held!: () => void, release!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let edits = 0,
        bothEdited!: () => void;
      const editsReady = new Promise<void>((r) => {
        bothEdited = r;
      });
      let holding = 0,
        maximum = 0,
        contention = 0;
      const actualMutex = gitMutex.makeGitMutex;
      const spy = vi.spyOn(gitMutex, 'makeGitMutex').mockImplementation((config) => {
        const real = actualMutex(config);
        return {
          withLock: async (fn) => {
            // Model the old exhausted retry seam immediately, with no minute sleep.
            // The real filesystem mutex still protects every admitted section.
            if (holding) {
              contention++;
              throw new Error('simulated cross-process mutex waiter budget exhausted');
            }
            holding++;
            maximum = Math.max(maximum, holding);
            try {
              return await real.withLock(fn);
            } finally {
              holding--;
            }
          },
        };
      });
      const f = await fixture(
        async (input) => {
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'candidate closure' };
          if (input.prompt.startsWith('related-check feedback')) {
            if (input.prompt.includes('src/a.ts')) {
              held();
              await gate;
            }
          } else {
            const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
            await writeFile(join(input.workspace!.path, file), 'GOOD\n');
            if (++edits === 2) bothEdited();
            await editsReady;
            if (file === 'src/b.ts') await firstHeld;
          }
          return { disposition: 'fixed', reason: 'candidate fixed', evidence: [] };
        },
        '',
        { parentSignal: parent.signal, remainingWallMs: () => wallRemaining, unitWallMs: 5000 },
      );
      let first: ReturnType<typeof f.engine.fix> | undefined;
      let second: ReturnType<typeof f.engine.fix> | undefined;
      try {
        first = f.engine.fix(finding(), 1);
        second = f.engine.fix(finding('src/b.ts'), 1);
        await firstHeld;
        await vi.waitFor(() =>
          expect(
            f.attempts.find((row) => row.finding === 'src/b.ts' && row.invocation === 'edit')
              ?.usage,
          ).toBeDefined(),
        );
        // Its invocation has settled; drain its promise continuations to the queue.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(contention).toBe(0);
        expect(holding).toBe(1);
        expect(f.attempts.filter((row) => row.finding === 'src/b.ts')).toHaveLength(1);
        if (outcome === 'cancel') parent.abort();
        if (outcome === 'budget') wallRemaining = 0;
        if (outcome === 'unit') {
          const expired = Date.now() + 6000;
          vi.spyOn(Date, 'now').mockReturnValue(expired);
        }
        const callsBeforeRelease = f.calls();
        release();
        const results = await Promise.all([first, second]);
        expect(contention).toBe(0);
        expect(maximum).toBe(1);
        expect(holding).toBe(0);
        expect(f.repo.git('diff', '--cached', '--name-only')).toBe('');
        expect(f.repo.git('diff', '--name-only', 'HEAD')).toBe('');
        expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
        if (outcome === 'success') {
          expect(results.map((result) => result.finding.status)).toEqual(['fixed', 'fixed']);
          expect(f.repo.git('rev-parse', `${results[1]!.commit}^`).trim()).toBe(results[0]!.commit);
          expect(f.repo.git('show', '--format=', '--name-only', results[0]!.commit!).trim()).toBe(
            'src/a.ts',
          );
          expect(f.repo.git('show', '--format=', '--name-only', results[1]!.commit!).trim()).toBe(
            'src/b.ts',
          );
        } else {
          expect(results.every((result) => !result.commit)).toBe(true);
          expect(results.map((result) => result.reason).join('\n')).toMatch(
            outcome === 'cancel' ? /parent cancelled/ : /budget exhausted/,
          );
          expect(f.calls()).toBe(callsBeforeRelease);
          expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
          for (const file of ['src/a.ts', 'src/b.ts']) {
            expect(await readFile(join(f.repo.root, file), 'utf8')).toBe('BAD\n');
            expect(f.attempts.some((row) => row.finding === file && row.failedAttempt?.sha)).toBe(
              true,
            );
          }
        }
      } finally {
        release();
        await Promise.allSettled([first, second]);
        spy.mockRestore();
        vi.restoreAllMocks();
        await f.cleanup();
      }
    },
  );
  test('same-file overlap is refused while its original worker is active', async () => {
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const f = await fixture(async () => {
      entered();
      await pending;
      return {
        disposition: 'deferred',
        reason: 'needs scope',
        evidence: [{ path: 'src/a.ts', line: 1 }],
      };
    });
    try {
      const first = f.engine.fix(finding(), 1);
      await started;
      const second = await f.engine.fix({ ...finding(), id: 'second' }, 1);
      expect(second.reason).toContain('overlapping');
      release();
      expect((await first).finding.status).toBe('deferred');
      expect(f.calls()).toBe(1);
    } finally {
      release();
      await f.cleanup();
    }
  });
});

test.each(['index', 'worker-snapshot', 'parent'] as const)(
  'engine-owned acceptance refuses concurrent tampering: %s',
  async (mode) => {
    let tamper: () => Promise<void> = async () => undefined;
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1') {
        if (mode !== 'index') await tamper();
        return { closed: true, reason: 'candidate fixed' };
      }
      if (input.prompt.includes('initial finding')) {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        if (mode === 'index') await tamper();
      }
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    tamper = async () => {
      if (mode === 'index') f.repo.git('add', 'src/a.ts');
      else if (mode === 'worker-snapshot')
        await f.repo.write('src/a.ts', 'LATE UNCHECKED CONTENT\n');
      else {
        await f.repo.write('README.md', 'external commit');
        f.repo.commitAll('outside engine');
      }
    };
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.commit).toBeUndefined();
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toMatch(
        mode === 'index'
          ? /index|staging/
          : mode === 'worker-snapshot'
            ? /worker file changed after candidate snapshot/
            : /unexpected HEAD movement|verified parent changed/,
      );
      const calls = f.calls();
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.commit).toBeUndefined();
      expect(f.calls()).toBe(calls);
      if (mode !== 'parent') expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  'src/café.ts',
  'src/space name.ts',
  'src/line\nbreak.ts',
  'src/quote"name.ts',
  'src/trailing\n',
] as const)('exact Git path %j can commit without poisoning sibling progress', async (file) => {
  const f = await fixture(async (input) => {
    if (input.outputSchema?.name === 'review.address.closure/v1')
      return { closed: true, reason: 'verified candidate' };
    if (!input.prompt.startsWith('related-check feedback')) {
      const selected = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : file;
      await writeFile(join(input.workspace!.path, selected), 'GOOD\n');
    }
    return { disposition: 'fixed', reason: 'fixed exact file', evidence: [] };
  });
  try {
    await f.repo.write(file, 'BAD\n');
    f.repo.commitAll('unusual filename');
    const results = await Promise.all([
      f.engine.fix(finding(file), 1),
      f.engine.fix(finding('src/b.ts'), 1),
    ]);
    expect(results.map((result) => result.finding.status)).toEqual(['fixed', 'fixed']);
    for (const [index, path] of [file, 'src/b.ts'].entries()) {
      expect(results[index]!.commit).toBeDefined();
      expect(
        f.repo.git(
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          results[index]!.commit!,
        ),
      ).toBe(path + '\0');
      expect(await readFile(join(f.repo.root, path), 'utf8')).toBe('GOOD\n');
    }
    expect(f.repo.git('diff', '--cached', '--name-only', '-z')).toBe('');
    expect(f.repo.git('diff', '--name-only', '-z', 'HEAD')).toBe('');
  } finally {
    await f.cleanup();
  }
});
test.each(['baseline', 'related', 'broader'] as const)(
  'parent cancellation terminates the actual running %s check before restore and FIFO release',
  async (phase) => {
    const parent = new AbortController();
    const external = await mkdtemp(join(tmpdir(), 'cq-running-check-'));
    const marker = join(external, 'ready');
    // Counts are candidate-owned, not shared worker edits: baseline then related then broader.
    const wanted = { baseline: 1, related: 2, broader: 3 }[phase];
    const check = `
const fs = require('node:fs');
const countFile = '.cq-check-count';
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(n));
if (n === ${wanted}) {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => {}, 1000);
}
`;
    const f = await fixture(undefined, check, { parentSignal: parent.signal });
    let running: ReturnType<typeof f.engine.fix> | undefined;
    let pid: number | undefined;
    try {
      running = f.engine.fix(finding(), 1);
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(marker, 'utf8'));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
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
      parent.abort();
      await running;
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  },
);
