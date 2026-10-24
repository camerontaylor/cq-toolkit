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
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
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
    firstStopReason?: 'budget' | 'aborted';
    remainingWallMs?: () => number;
    unitWallMs?: number;
  } = {},
) {
  const repo = await makeTestRepo();
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
            denials: [],
          };
        },
      },
    }),
  };
  const engine = makeAddressWorker({
    git: makeGhRunner({ bin: 'git', cwd: repo.root }),
    drivers,
    repoRoot: options.aliasRoot ? alias : repo.root,
    ...(options.installedDependencies ? { dependencyRoot } : {}),
    journalDir: journal,
    policy: resolveCqConfigDefaults(config, { packageName: 'fixture' }),
    attempts,
    remainingTokens: () => config.budgets!.run!.maxTokens! - spent,
    remainingWallMs: options.remainingWallMs ?? (() => 20000),
    account: (r) => {
      spent += r.usage.input + r.usage.output;
    },
    scanner: async (components) => {
      if (options.scannerFails) throw new Error('scanner unavailable');
      return components.map((c) => ({ component: c.component, hits: [] }));
    },
    ...(options.parentSignal ? { parentSignal: options.parentSignal } : {}),
  });
  return {
    repo,
    engine,
    attempts,
    initial,
    calls: () => calls,
    cleanup: async () => {
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    },
  };
}

describe('review.address candidate isolation', () => {
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
      expect(f.attempts[0]?.evidenceRef).toMatch(/^refs\/cq\/review-address\//);
      expect(f.repo.git('show', `${f.attempts[0]!.evidenceSha}:src/a.ts`)).toContain('PARTIAL');
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
          (a) => a.tier === 'worker' && a.evidenceRef?.startsWith('refs/cq/review-address/'),
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
        expect(f.attempts[0]?.evidenceRef).toBeTruthy();
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
      expect(f.attempts[0]?.evidenceRef).toBeTruthy();
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
        await firstHeld;
        second = f.engine.fix(finding('src/b.ts'), 1);
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
            expect(f.attempts.some((row) => row.finding === file && row.evidenceSha)).toBe(true);
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
