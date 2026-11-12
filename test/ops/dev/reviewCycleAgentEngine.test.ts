import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Op } from '../../../src/kernel/types.js';
import { makeAgentReviewRunner } from '../../../src/ops/dev/agentReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  SCAN_COMPONENT_CAP_BYTES,
  makeDevReview,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import { parseDevLedger, serializeDevLedger } from '../../../src/ops/dev/record.js';
import { makeDevReady } from '../../../src/ops/dev/ready.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { restoreDurableDisposition } from '../../../src/ops/review/internal/durableDisposition.js';
import { checkRecord, stubScanner } from './fakes.js';
import { capturingScanner, reviewerCalls, wireRequest } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.review cycle', () => {
  test.each(['terminal', 'blocked'] as const)(
    'configured agent composes the scripted engine, shared lock and %s author evidence',
    async (outcome) => {
      const role = { provider: 'scripted', model: 'fixture-reviewer' };
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: role },
          budgets: { run: { maxTokens: 5000, wallMs: 20000 } },
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('configure scripted reviewer');
      const effects = repoEffects(repo);
      let locked = false;
      const lock = vi.fn(async (fn: () => unknown) => {
        expect(locked).toBe(false);
        locked = true;
        try {
          return await fn();
        } finally {
          locked = false;
        }
      });
      effects.withHostLock = async (fn) => (await lock(fn)) as Awaited<ReturnType<typeof fn>>;
      const scanner = capturingScanner();
      const dispatch = vi.fn(async (invocation: { prompt: string }) => {
        expect(locked).toBe(true);
        const payload = wireRequest(invocation.prompt);
        return payload;
      });
      const resolve = vi.fn(
        (request: {
          modelSpec: unknown;
          beforeRequest?: (
            text: string,
            contents: readonly { text: string }[],
            context: { kind: 'model-request' },
          ) => Promise<void>;
        }) => {
          expect(locked).toBe(true);
          expect(request.modelSpec).toEqual(role);
          return {
            lane: 'ai-sdk',
            modelSpec: role,
            driver: {
              run: async (invocation: {
                prompt: string;
                toolPolicy: unknown;
                sandboxPolicy: unknown;
              }) => {
                expect(invocation.toolPolicy).toEqual({
                  mode: 'allowlist',
                  allow: ['read', 'grep', 'glob'],
                });
                expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
                const payload = await dispatch(invocation);
                await request.beforeRequest?.(payload.text, payload.contents, {
                  kind: 'model-request',
                });
                return {
                  stopReason: outcome === 'terminal' ? 'complete' : 'error',
                  error: outcome === 'blocked' ? 'scripted provider unavailable' : undefined,
                  structuredOutput: { findings: [] },
                  usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                };
              },
            },
          };
        },
      );
      const runner = makeAgentReviewRunner({
        repoRoot: repo.root,
        readFile: async (path) => {
          expect(locked).toBe(true);
          return readFile(path, 'utf8');
        },
        drivers: { resolve } as unknown as DriverFactory,
        scanSecrets: scanner,
        run: runAgentReviewer,
      });
      const state = await readWorkState(effects, { target: 'main' });
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      const { base, head, dirtySha256 } = state.state;
      const op = makeDevReview({ effects, scanSecrets: scanner, runAgentReviewer: runner });
      const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
      expect(result.status).toBe(outcome === 'terminal' ? 'ok' : 'needs-human');
      // Reuse admission and fresh dispatch acquire the same host lock separately.
      expect(lock).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(reviewerCalls(effects)).toEqual([]);
      expect(scanner.seen.some((c) => c.component === 'request')).toBe(true);
      const store = effects.openLedger('feature/x');
      const ledger = store.load();
      const [cycle] = ledger.records;
      expect(cycle).toMatchObject({
        kind: 'cycle',
        reviewer: 'agent:reviewer',
        scope: 'full',
        target: 'main',
        base,
        head,
        dirtySha256,
        completion: { kind: outcome },
      });
      for (const field of [
        `reviewer: agent:reviewer`,
        `base: ${base}`,
        `head: ${head}`,
        `dirtySha256: ${dirtySha256}`,
        'scope: full',
        `completion: ${outcome}`,
        'coverage: v2 mode=session',
      ]) {
        expect(effects.logs[0]).toContain(field);
      }
      if (cycle?.kind !== 'cycle') return;
      if (outcome === 'blocked' && cycle.completion.kind === 'blocked')
        expect(cycle.completion.reason).toContain('scripted provider unavailable');
      expect(cycle.logPath).toContain('/tmp/fake-cq-dev-review/');
      // A scripted green check supplies the separate check prerequisite; no gate runs here.
      store.save({
        ...ledger,
        records: [...ledger.records, checkRecord({ base, head, dirtySha256 })],
      });
      const ready = await makeDevReady(effects)({ repoRoot: repo.root });
      if (outcome === 'terminal') {
        expect(ready.status).toBe('ok');
        if (ready.status === 'ok') {
          expect(ready.value).toMatchObject({
            evidenceClass: 'author',
            reviewer: 'agent:reviewer',
            cycleId: cycle.cycleId,
            checkId: 'k001-aaaaaaaa',
            base,
            head,
            dirtySha256,
          });
          expect(ready.value.caveat).toContain('not verification');
        }
      } else {
        expect(ready.status).toBe('needs-human');
        if (ready.status === 'needs-human') expect(ready.reason).toContain('latest-review-blocked');
      }
    },
  );

  test.each([
    ['missing', undefined, 'requires cq.json'],
    ['malformed', '{ invalid', 'agent reviewer config:'],
    [
      'missing role',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      }),
      'roles.reviewer is required',
    ],
  ] as const)(
    'unavailable agent config (%s) records blocked identity without dispatch',
    async (_name, config, reason) => {
      const effects = repoEffects(repo);
      const run = vi.fn();
      const runner = makeAgentReviewRunner({
        repoRoot: repo.root,
        readFile: async () => {
          if (config === undefined)
            throw Object.assign(new Error("ENOENT: no such file, open 'cq.json'"), {
              code: 'ENOENT',
            });
          return config;
        },
        drivers: { resolve: vi.fn() } as unknown as DriverFactory,
        scanSecrets: stubScanner(),
        run,
      });
      const result = await makeDevReview({
        effects,
        scanSecrets: stubScanner(),
        runAgentReviewer: runner,
      })({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
      expect(result.status).toBe('needs-human');
      expect(run).not.toHaveBeenCalled();
      expect(reviewerCalls(effects)).toEqual([]);
      const [cycle] = effects.openLedger('feature/x').load().records;
      expect(cycle).toMatchObject({
        kind: 'cycle',
        reviewer: 'agent:reviewer',
        completion: { kind: 'blocked' },
      });
      if (cycle?.kind === 'cycle' && cycle.completion.kind === 'blocked')
        expect(cycle.completion.reason).toContain(reason);
      expect(effects.logs[0]).toContain('completion: blocked');
    },
  );

  test.each(['hit', 'scanner fault', 'symlink', 'oversized'] as const)(
    'agent safety refusal (%s) precedes dispatch and records no cycle',
    async (failure) => {
      if (failure === 'symlink')
        await symlink('/outside-scripted-workspace', join(repo.root, 'link'));
      if (failure === 'oversized')
        await repo.write('big.txt', 'x'.repeat(SCAN_COMPONENT_CAP_BYTES + 1));
      const effects = repoEffects(repo);
      const runner = vi.fn();
      const scanner: DiffSecretScanner =
        failure === 'scanner fault'
          ? () => {
              throw new Error('scripted scanner unavailable');
            }
          : stubScanner(
              failure === 'hit'
                ? [{ component: 'committed:src/a.ts', ruleId: 'fixture:secret' }]
                : [],
            );
      const result = await makeDevReview({
        effects,
        scanSecrets: scanner,
        runAgentReviewer: runner,
      })({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain(
          {
            hit: 'fixture:secret',
            'scanner fault': 'scripted scanner unavailable',
            symlink: "untracked file 'link'",
            oversized: 'per-file scan cap',
          }[failure],
        );
      expect(runner).not.toHaveBeenCalled();
      expect(reviewerCalls(effects)).toEqual([]);
      expect(effects.openLedger('feature/x').load().records).toEqual([]);
    },
  );

  test.each([
    ['src/a.ts', 'fixture-rule'],
    ['', 'fixture-rule'],
    [undefined, 'fixture-rule'],
    ['src/a.ts', ''],
    ['src/a.ts', undefined],
  ])('agent:reviewer records file %j and rule %j identity verbatim', async (file, rule) => {
    const effects = repoEffects(repo);
    const run = vi.fn(
      async (invocation: {
        prompt: string;
        toolPolicy: { mode?: string; allow?: string[] };
        outputSchema?: unknown;
      }) => {
        expect(invocation.toolPolicy.mode).toBe('allowlist');
        expect(invocation.toolPolicy.allow).toEqual(['read', 'grep', 'glob']);
        expect(invocation.outputSchema).toBeDefined();
        return {
          stopReason: 'complete' as const,
          structuredOutput: {
            findings: [
              {
                ...(file === undefined ? {} : { file }),
                line: 1,
                ...(rule === undefined ? {} : { rule }),
                severity: 'high',
                text: 'Seeded agent finding',
              },
            ],
          },
          usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 },
          denials: [],
        };
      },
    );
    let wire = '';
    const drivers = {
      resolve: (request: {
        beforeRequest?: (
          text: string,
          contents?: readonly { text: string }[],
          context?: { kind: 'model-request' | 'tool-output' },
        ) => void | Promise<void>;
      }) => {
        const resolved = {
          lane: 'ai-sdk',
          modelSpec: { provider: 'scripted', model: 'reviewer' },
          driver: {
            run: async (invocation: { prompt: string }) => {
              const payload = wireRequest(invocation.prompt);
              wire = payload.text;
              await request.beforeRequest?.(payload.text, payload.contents, {
                kind: 'model-request',
              });
              return run(invocation as never);
            },
          },
        };
        return resolved;
      },
    } as unknown as DriverFactory;
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: (input) =>
        runAgentReviewer(drivers, {
          ...input,
          scanSecrets: stubScanner(),
          role: { provider: 'scripted', model: 'reviewer' },
          maxTokens: 500,
          wallMs: 1000,
          severityMap: { high: 'major', medium: 'minor' },
        }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status, result.status === 'needs-human' ? result.reason : '').toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.reviewer).toBe('agent:reviewer');
    expect(result.value.completion).toEqual({ kind: 'terminal' });
    expect(result.value.findings).toEqual([
      expect.objectContaining({
        severity: 'major',
        ...(file === undefined ? {} : { fileName: file }),
        excerpt: 'Seeded agent finding',
      }),
    ]);
    expect(wire).toContain('"role":"user"');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      reviewer: 'agent:reviewer',
      completion: { kind: 'terminal' },
    });
    if (cycle?.kind !== 'cycle') throw new Error('missing agent cycle');
    if (file === undefined) expect(cycle.findings[0]).not.toHaveProperty('fileName');
    else expect(cycle.findings[0]).toHaveProperty('fileName', file);
    if (rule === undefined) {
      expect(result.value.findings[0]).not.toHaveProperty('rule');
      expect(cycle.findings[0]).not.toHaveProperty('rule');
    } else {
      expect(result.value.findings[0]).toHaveProperty('rule', rule);
      expect(cycle.findings[0]).toHaveProperty('rule', rule);
    }
    if (rule === '' || rule === undefined) {
      const produced = cycle.findings[0]!;
      const persisted = parseDevLedger(
        serializeDevLedger({
          ...effects.openLedger('feature/x').load(),
          records: [
            cycle,
            {
              kind: 'disposition',
              findingId: produced.id,
              action: 'rejected',
              why: 'reviewed original identity',
              head: cycle.head,
              at: cycle.at,
            },
          ],
        }),
      );
      // Reuse the ACTUAL producer's persisted ID. Fresh cycles mint different
      // IDs; this checks same-ID replay rather than cross-cycle inheritance.
      const absentRule = {
        id: produced.id,
        source: 'agent',
        severity: 'major',
        text: 'Seeded agent finding',
        file: 'src/a.ts',
        line: 1,
        status: 'open' as const,
      };
      const restoredAbsent = restoreDurableDisposition(absentRule, persisted);
      expect(restoredAbsent.status).toBe(rule === '' ? 'open' : 'rejected');
      if (rule === '') {
        expect(restoredAbsent).not.toHaveProperty('reason');
        expect(restoreDurableDisposition({ ...absentRule, rule: '' }, persisted)).toMatchObject({
          status: 'rejected',
          reason: 'reviewed original identity',
          rule: '',
        });
      } else expect(restoredAbsent.reason).toBe('reviewed original identity');
    }
    expect(effects.logs[0]).toContain('coverage: v2 mode=session');
    expect(effects.logs[0]).toContain('advisories: none');
    expect(run).toHaveBeenCalledOnce();
  });
});
