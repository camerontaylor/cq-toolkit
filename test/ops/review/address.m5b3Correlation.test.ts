// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,admission,blockedRereview,vendorBoundary,lock}.test.ts.
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { correlationInvocation } from '../../../src/driver/correlationInvocation.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeReviewAddress, type ReviewAddressDeps } from '../../../src/ops/review/address.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { makeTestRepo } from '../dev/repo.js';
import { config, fixture, reportOf } from './address.helpers.js';

describe('M5b3 forward governed invocation correlation (review.address)', () => {
  let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
  beforeEach(async () => {
    scanner = await makeGitleaksFixture();
    vi.stubEnv('PATH', scanner.path);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scanner.root, { recursive: true, force: true });
  });
  const correlationCases = [
    { name: 'run id only', correlation: { workId: 'run:jr:1', runId: 'run' } },
    {
      name: 'work and parent',
      correlation: { workId: 'run:jr:1', runId: 'run', parentWorkId: 'paseo:agent-1' },
    },
    {
      name: 'explicit role',
      correlation: { workId: 'run:jr:1', runId: 'run', role: 'review.address' },
    },
  ] as const;
  test.each(correlationCases)(
    'table: $name does not silently inherit the outer job',
    async ({ correlation }) => {
      // The review-leg forwarding is asserted through the REAL reviewDrivers
      // path: a committed cq.json repo, injected drivers, no deps.review —
      // deleting the forwarding at src/ops/review/address.ts fails here.
      const f = await fixture();
      const repo = await withCommittedConfig();
      try {
        const seen: Array<{ prompt: string; correlation?: unknown }> = [];
        const drivers: DriverFactory = {
          resolve: (request) => ({
            lane: 'ai-sdk',
            modelSpec: request.modelSpec,
            driver: {
              run: async (invocation) => {
                seen.push({ prompt: invocation.prompt, correlation: invocation.correlation });
                return {
                  stopReason: 'complete' as const,
                  structuredOutput: { findings: [] },
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                };
              },
            },
          }),
        };
        const expected = correlationInvocation({ ...correlation }).correlation;
        const outcome = await runLadder(
          () =>
            makeReviewAddress(depsForReviewLeg(f, repo, drivers))({
              repoRoot: repo.root,
              source: 'local',
              journalDir: f.input.journalDir,
            }),
          { wallClockMs: 20000 },
          {
            op: 'review.address',
            jobKey: 'outer-job',
            attempt: 1,
            correlation: { ...correlation },
          },
        );
        expect(outcome.outcome).toBe('completed');
        expect(seen.length).toBeGreaterThan(0);
        // The invocation carries the SHARED HELPER's result: the preserved
        // 'fixer' default applies when the minted correlation lacks a role
        // (M5b0 semantics, not a new role here).
        for (const row of seen) expect(row.correlation).toEqual(expected);
      } finally {
        await repo.cleanup();
        await f.cleanup();
      }
    },
  );

  // A review-leg driver run needs a real committed cq.json in the fixture repo.
  const withCommittedConfig = async () => {
    const repo = await makeTestRepo();
    await repo.write(
      'cq.json',
      JSON.stringify({
        ...config,
        budgets: { run: { maxTokens: 1000, wallMs: 20000 }, step: { wallMs: 5000 } },
      }),
    );
    await repo.write('package.json', '{"name":"fixture-review"}\n');
    repo.commitAll('fixture review config');
    return repo;
  };
  const depsForReviewLeg = (
    f: Awaited<ReturnType<typeof fixture>>,
    repo: Awaited<ReturnType<typeof withCommittedConfig>>,
    drivers?: DriverFactory,
  ): ReviewAddressDeps => ({
    config: {
      ...config,
      budgets: { run: { maxTokens: 1000, wallMs: 20000 }, step: { wallMs: 5000 } },
    },
    initialRecord: {
      schemaVersion: 1,
      branch: 'feature/x',
      reviewed: { base: repo.git('merge-base', 'origin/main', 'HEAD').trim(), scope: 'full' },
      head: repo.git('rev-parse', 'HEAD').trim(),
      sources: [{ kind: 'agent', status: 'terminal' }],
      findings: f.deps.initialRecord!.findings,
    },
    drivers: drivers ?? f.deps.drivers!,
  });

  // M5b3 nominal evidence: under a governed dispatch, the review-leg driver
  // wrapper forwards the minted correlation onto the invocation.
  test('M5b3 nominal evidence', async () => {
    const f = await fixture();
    const repo = await withCommittedConfig();
    try {
      const seen: Array<{ prompt: string; correlation?: unknown }> = [];
      const drivers: DriverFactory = {
        resolve: (request) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (invocation) => {
              seen.push({ prompt: invocation.prompt, correlation: invocation.correlation });
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            },
          },
        }),
      };
      const correlation = { workId: 'run:jn:2', runId: 'run', role: 'review.address' } as const;
      const expected = correlationInvocation({ ...correlation }).correlation;
      const outcome = await runLadder(
        () =>
          makeReviewAddress(depsForReviewLeg(f, repo, drivers))({
            repoRoot: repo.root,
            source: 'local',
            journalDir: f.input.journalDir,
          }),
        { wallClockMs: 20000 },
        { op: 'review.address', jobKey: 'jn', attempt: 1, correlation: { ...correlation } },
      );
      // The re-review then ends needs-human on the scripted reviewer's
      // non-terminal cycle; the invocation forwarding under test already
      // happened on every review-leg dispatch.
      expect(outcome.outcome).toBe('completed');
      expect(seen.length).toBeGreaterThan(0);
      for (const row of seen) expect(row.correlation).toEqual(expected);
    } finally {
      await repo.cleanup();
      await f.cleanup();
    }
  });

  // M5b3 missing evidence: no governed context — the review leg forwards no
  // correlation and the composition behaves exactly as before.
  test('M5b3 missing evidence', async () => {
    const f = await fixture();
    const repo = await withCommittedConfig();
    try {
      const seen: Array<{ prompt: string; correlation?: unknown }> = [];
      const drivers: DriverFactory = {
        resolve: (request) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (invocation) => {
              seen.push({ prompt: invocation.prompt, correlation: invocation.correlation });
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            },
          },
        }),
      };
      const result = await makeReviewAddress(depsForReviewLeg(f, repo, drivers))({
        repoRoot: repo.root,
        source: 'local',
        journalDir: f.input.journalDir,
      });
      expect(result.status).toBe('needs-human');
      expect(seen.length).toBeGreaterThan(0);
      for (const row of seen) expect(row.correlation).toBeUndefined();
    } finally {
      await repo.cleanup();
      await f.cleanup();
    }
  });

  // M5b3 failure evidence: a correlation whose role is already set passes
  // through verbatim — no new role is minted on the review leg.
  test('M5b3 failure evidence', async () => {
    const f = await fixture();
    const repo = await withCommittedConfig();
    try {
      const seen: Array<{ prompt: string; correlation?: unknown }> = [];
      const drivers: DriverFactory = {
        resolve: (request) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (invocation) => {
              seen.push({ prompt: invocation.prompt, correlation: invocation.correlation });
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            },
          },
        }),
      };
      const correlation = { workId: 'run:jf:2', runId: 'run', role: 'reviewer' } as const;
      const expected = correlationInvocation({ ...correlation }).correlation;
      const outcome = await runLadder(
        () =>
          makeReviewAddress(depsForReviewLeg(f, repo, drivers))({
            repoRoot: repo.root,
            source: 'local',
            journalDir: f.input.journalDir,
          }),
        { wallClockMs: 20000 },
        { op: 'review.address', jobKey: 'jf', attempt: 1, correlation: { ...correlation } },
      );
      // The re-review then ends needs-human on the scripted reviewer's
      // non-terminal cycle; the invocation forwarding under test already
      // happened on every review-leg dispatch.
      expect(outcome.outcome).toBe('completed');
      expect(seen.length).toBeGreaterThan(0);
      for (const row of seen) expect(row.correlation).toEqual(expected);
    } finally {
      await repo.cleanup();
      await f.cleanup();
    }
  });

  test('T14: a worker attempt-observation failure marks the surface indeterminate, never the verdict', async () => {
    // ADR-0008 T14: the worker cannot hand a strict-schema refusal or a
    // refused append to the writer, so it carries them on
    // observationFailures(). The composition folds them into
    // observation.status 'indeterminate'; the finding verdict is identical to
    // the same world whose worker reports no observation failure.
    const controlFixture = await fixture(),
      observedFixture = await fixture();
    try {
      const run = async (
        f: Awaited<ReturnType<typeof fixture>>,
        observationFailures?: () => readonly string[],
      ) => {
        const result = await makeReviewAddress({
          ...f.deps,
          workerFactory: () => ({
            escalation: createEscalationState,
            fix: async (item) => ({
              finding: { ...item, status: 'deferred', reason: 'requires owner' },
              reason: 'requires owner',
              observedHead: f.record().head,
              validation: [],
            }),
            ...(observationFailures ? { observationFailures } : {}),
          }),
        })({ repoRoot: f.repo.root, source: 'local', journalDir: f.input.journalDir });
        // A deferred finding stays blocking (needs-human), which is the shared
        // verdict of both worlds; the observation failure must not move it.
        return { result, report: reportOf(result) };
      };
      const control = await run(controlFixture);
      const observed = await run(observedFixture, () => ['attempt observation failed: disk full']);
      expect(observed.result.status).toBe(control.result.status);
      expect(observed.report.findings.map((row) => row.status)).toEqual(
        control.report.findings.map((row) => row.status),
      );
      expect(control.report.observation?.status).toBe('durable');
      expect(observed.report.observation?.status).toBe('indeterminate');
      expect(observed.report.observation?.failure).toContain('attempt observation failed');
    } finally {
      await controlFixture.cleanup();
      await observedFixture.cleanup();
    }
  });

  test('T14: the composition drains in-flight invocations before it closes, and folds after close', async () => {
    // Open question (PR #1030): finish() can run while a fixer invocation is
    // still in flight — runPlan's ladder DETACHES an op that ignored its kill
    // rung — and that invocation appends its attempt event last. The
    // composition therefore drains the worker BEFORE the fold and folds once
    // more AFTER close, so a failure discovered while the writer drained is
    // evidence on the persisted surface, never a silent loss.
    const f = await fixture();
    try {
      const order: string[] = [];
      let reads = 0;
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (item) => ({
            finding: { ...item, status: 'deferred', reason: 'requires owner' },
            reason: 'requires owner',
            observedHead: f.record().head,
            validation: [],
          }),
          settleObservations: async () => {
            order.push('drain');
          },
          // The first fold sees nothing; the invocation's refusal lands only
          // after the stream was closed. It must still reach the surface.
          observationFailures: () => {
            reads++;
            order.push(`fold-${String(reads)}`);
            return reads < 2 ? [] : ['attempt observation failed: append refused at close'];
          },
        }),
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.input.journalDir });
      const report = reportOf(result);
      // The drain precedes both folds: no attempt append can race the close.
      expect(order).toEqual(['drain', 'fold-1', 'fold-2']);
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).toContain('append refused at close');
    } finally {
      await f.cleanup();
    }
  });
});
