// ADR-0008 T31 — address composition observation writer wiring
// (measurement slice M0-address-writer).
//
// What is pinned here:
//   1. ONE composition stream per review.address invocation across all
//      rounds and plans: a composition-started header first, then an
//      explicit kernel-run-linked event after every RETURNED kernel run —
//      never a guessed link for a run that never returned.
//   2. The writer reaches the REAL worker bindings through
//      AddressWorkerDeps at runtime only — never serialized into any
//      dispatch input.
//   3. The writer closes in finish() BEFORE the report persists; the
//      persisted artifact carries a DTO (no writer instance) and an
//      explicit kernel-run-linked including returned partial results.
//   4. Failure boundary: a writer whose append/close fails never changes
//      the run's verdict; the observation surface carries the sanitized
//      first error and the status is indeterminate.
// Fake/local inputs only: no provider, no network, no credentials.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  openObservationWriter,
  readObservations,
  type ObservationWriter,
} from '../../../src/kernel/observation.js';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import {
  makeAddressWorker,
  type AddressWorkerDeps,
} from '../../../src/ops/review/addressWorker.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';
import type { ReviewRunInput, ReviewRunResult } from '../../../src/ops/review/run.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});

const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeReviewAddress>>>) =>
  ((result as { report?: ReviewAddressReport; value?: ReviewAddressReport }).report ??
    (result as { value?: ReviewAddressReport }).value ??
    null) as ReviewAddressReport | null;

interface Fixture {
  repo: Awaited<ReturnType<typeof makeTestRepo>>;
  journalDir: string;
  record: FindingsRecord;
  drivers: DriverFactory;
  boundDeps: AddressWorkerDeps[];
  review: (input: ReviewRunInput) => Promise<ReviewRunResult>;
  cleanup(): Promise<void>;
}

/**
 * A local-scope address fixture: a seeded failing finding, a scripted
 * worker that fixes it in one edit, and a canned reviewer (deps.review) so
 * the re-review leg needs no provider. Captures every AddressWorkerDeps
 * object the composition binds so the test can assert the writer reached
 * the REAL runtime deps.
 */
async function fixture(): Promise<Fixture> {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  const journalDir = await mkdtemp(join(tmpdir(), 't31-obs-'));
  const role = { provider: 'mock', model: 'worker' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      { adapter: 'tsc-lines', command: { command: process.execPath, args: ['scripts/check.cjs'] } },
    ],
    roles: {
      worker: role,
      rescue: { ...role, model: 'rescue' },
      reviewer: { ...role, model: 'reviewer' },
    },
    review: { reviewers: ['agent'], rounds: 2 },
    budgets: { run: { maxTokens: 10000, wallMs: 20000 }, step: { wallMs: 5000 } },
    escalation: { workerAttempts: 2, rescueBase: 1, rescuePerPackageCap: 1 },
  };
  await repo.write('.gitignore', '.cq/\n');
  await repo.write('src/a.ts', 'export const a = "BAD";\n');
  await repo.write('scripts/check.cjs', 'process.exitCode = 0;\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('address observation fixture');
  const head = repo.git('rev-parse', 'HEAD').trim();
  const finding: Finding = {
    id: 'seed-a',
    source: 'agent',
    file: 'src/a.ts',
    line: 1,
    severity: 'major',
    text: 'Replace BAD with GOOD',
    status: 'open',
  };
  const record: FindingsRecord = {
    schemaVersion: 1,
    branch: 'feature/x',
    head,
    sources: [{ kind: 'agent', status: 'terminal' }],
    findings: [finding],
  };
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (invocation) => {
          const content = await readFile(join(invocation.workspace!.path, 'src/a.ts'), 'utf8');
          // The agent reviewer leg: a clean record once the defect is gone.
          if (invocation.outputSchema?.name === 'review.agent/v3')
            return {
              stopReason: 'complete' as const,
              structuredOutput: {
                findings: content.includes('BAD')
                  ? [{ file: 'src/a.ts', line: 1, severity: 'high', text: 'Replace BAD with GOOD' }]
                  : [],
              },
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          if (!invocation.prompt.startsWith('related-check feedback'))
            await writeFile(
              join(invocation.workspace!.path, 'src/a.ts'),
              content.replace('BAD', 'GOOD'),
            );
          const structuredOutput =
            invocation.outputSchema?.name === 'review.address.closure/v1'
              ? {
                  closed: !content.includes('BAD') || content.includes('GOOD'),
                  reason: 'verified candidate bytes',
                }
              : { disposition: 'fixed', reason: 'fixed seeded issue', evidence: [] };
          return {
            stopReason: 'complete',
            structuredOutput,
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    }),
  };
  const boundDeps: AddressWorkerDeps[] = [];
  // Canned re-review reviewer (fake/local only): an engine-shaped clean
  // FindingsRecord at the CURRENT head, so the composition can settle ok
  // without any provider. The head is read from the repo the way the
  // composition itself reads it.
  const review = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const head = (
      await promisify(execFile)('git', ['-C', input.repoRoot, 'rev-parse', 'HEAD'], {
        timeout: 10_000,
      })
    ).stdout.trim();
    const base = (
      await promisify(execFile)(
        'git',
        ['-C', input.repoRoot, 'merge-base', 'origin/merge-queue', 'HEAD'],
        { timeout: 10_000 },
      )
    ).stdout.trim();
    return {
      status: 'ok',
      value: {
        schemaVersion: 1,
        branch: 'feature/x',
        head,
        sources: [{ kind: 'agent' as const, status: 'terminal' as const }],
        findings: [],
        reviewed: { base, scope: 'full' as const },
      },
    };
  };
  return {
    repo,
    journalDir,
    record,
    drivers,
    boundDeps,
    review,
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}

// ---- invocation wrapper --------------------------------------------------

const invoke = async (
  f: Fixture,
  overrides: Partial<Parameters<ReturnType<typeof makeReviewAddress>>[0]> = {},
) => {
  // Recreated per call so each test controls its own deps injection.
  return makeReviewAddress({
    drivers: f.drivers,
    initialRecord: f.record,
    review: f.review,
    workerFactory: (deps) => {
      f.boundDeps.push(deps);
      return makeAddressWorker(deps);
    },
    ...overrides,
  })({
    repoRoot: f.repo.root,
    source: 'local' as const,
    journalDir: f.journalDir,
  });
};

// ---- T31 round-trip -------------------------------------------------------

describe('T31 round-trip through the address composition', () => {
  test('one stream across rounds and plans, runtime deps receive the writer, close before persistence', async () => {
    const f = await fixture();
    try {
      const result = await invoke(f);
      expect(result.status, JSON.stringify(result)).toBe('ok');
      const report = reportOf(result);
      expect(report?.observation).toBeDefined();
      // The REAL runtime deps received the writer.
      expect(f.boundDeps.length).toBeGreaterThan(0);
      const writers = new Set(
        f.boundDeps.map((deps) => deps.observationWriter as ObservationWriter | undefined),
      );
      expect(writers.size).toBe(1);
      const writer = f.boundDeps[0]?.observationWriter as ObservationWriter;
      expect(writer).toBeDefined();
      // unitId is the planned dispatch unit identity surface (null here:
      // run-scoped injection only); never a fabricated kernel jobId.
      expect(f.boundDeps.every((deps) => deps.observationUnitId === null)).toBe(true);
      // One composition stream across all rounds and plans.
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      const stream = streams[0]!;
      expect(stream.complete).toBe(true);
      expect(stream.events[0]?.type).toBe('composition-started');
      const header = stream.events[0];
      if (header?.type !== 'composition-started') throw new Error('header missing');
      expect(header.payload.journalVersion).toBe(3);
      expect(header.payload.provenance.baseSha).toBe(header.payload.provenance.witnesses.base);
      expect(header.payload.provenance.repoId === null).toBe(true);
      // Explicit kernel-run links for every returned run; the linked ids are
      // the actual runs the report retained.
      const links = stream.events.filter((event) => event.type === 'kernel-run-linked');
      expect(links.length).toBeGreaterThanOrEqual(1);
      const returned = new Set(
        report?.rounds.flatMap((round) => round.runs.map((run) => run.runId)) ?? [],
      );
      for (const link of links) {
        if (link.type !== 'kernel-run-linked') continue;
        expect(returned.has(link.payload.kernelRunId)).toBe(true);
      }
      // The report surface lists the same kernel runs, and the persisted
      // artifact is a DTO: no writer instance ever serialized.
      // T04's kernel v3 header writer has not landed: kernel runs are still
      // v1/v2-era, so every descriptor stays unknown/empty (links recorded,
      // headers unresolvable) — never a guessed descriptor.
      expect(report?.observation?.kernelRuns).toEqual([]);
      const persisted = JSON.parse(
        await readFile(report!.reportPath, 'utf8'),
      ) as ReviewAddressReport;
      expect(persisted.observation).toEqual(report?.observation);
      expect(JSON.stringify(persisted)).not.toContain('append');
      expect(JSON.stringify(persisted)).not.toContain('"close"');
      // Close happened BEFORE persistence: the closed writer refuses appends.
      await expect(
        writer.append({
          type: 'kernel-run-linked',
          runId: writer.compositionRunId,
          at: new Date().toISOString(),
          unitId: null,
          jobId: null,
          taskId: null,
          attempt: null,
          payload: { kernelRunId: 'late', planId: 'late', round: 99 },
        }),
      ).rejects.toThrow(/closed/);
    } finally {
      await f.cleanup();
    }
  });

  test('memory-only mode (no journalDir) declares persistence unavailable and persists no stream', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        drivers: f.drivers,
        initialRecord: f.record,
        review: f.review,
      })({
        repoRoot: f.repo.root,
        source: 'local' as const,
      });
      expect(result.status).toBe('ok');
      const report = reportOf(result);
      expect(report?.observation?.persistence).toBe('unavailable');
      expect(report?.observation?.kernelRuns).toEqual([]);
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
});

// ---- T31 unknown evidence -------------------------------------------------

describe('T31 unknown evidence: unreturned runs stay unlinked', () => {
  test('a pre-dispatch refusal leaves no kernel-run link and no guessed id', async () => {
    const f = await fixture();
    try {
      // A missing findings record refuses before any dispatch; only the
      // stream boundaries (header) may exist — never a kernel-run link.
      await rm(join(f.repo.root, 'cq.json'), { force: true });
      const result = await invoke(f);
      expect(result.status).not.toBe('ok');
      const streams = await readObservations(f.journalDir);
      const links = streams.flatMap((stream) =>
        stream.events.filter((event) => event.type === 'kernel-run-linked'),
      );
      expect(links).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
});

// ---- T31 failure boundary -------------------------------------------------

describe('T31 failure boundary', () => {
  test.each(['header', 'link', 'close'] as const)(
    '%s writer failure preserves the run verdict and reports an indeterminate, sanitized surface',
    async (boundary) => {
      const f = await fixture();
      const writer = await openObservationWriter({
        workId: '00000000-0000-4000-8000-000000000000',
        compositionRunId: 't31-fixture',
      });
      const append = writer.append.bind(writer);
      const originalClose = writer.close.bind(writer);
      const appendSpy = vi.spyOn(writer, 'append').mockImplementation(async (event) => {
        if (boundary === 'header' && event.type === 'composition-started')
          throw new Error('https://u:tok@h/x?k=v');
        if (boundary === 'link' && event.type === 'kernel-run-linked') await originalClose();
        await append(
          event.type === 'composition-started'
            ? {
                ...event,
                runId: writer.compositionRunId,
                payload: {
                  ...event.payload,
                  correlation: {
                    ...event.payload.correlation,
                    workId: '00000000-0000-4000-8000-000000000000',
                  },
                },
              }
            : { ...event, runId: writer.compositionRunId },
        );
      });
      const closeSpy = vi.spyOn(writer, 'close').mockImplementation(async () => {
        if (boundary === 'close') throw new Error('https://u:tok@h/x?k=v');
      });
      try {
        const result = await makeReviewAddress({
          drivers: f.drivers,
          initialRecord: f.record,
          review: f.review,
          observationWriter: writer,
        })({
          repoRoot: f.repo.root,
          source: 'local' as const,
          journalDir: f.journalDir,
        });
        // The writer NEVER changes the verdict: the run still settles on
        // its own outcome (ok on the fixture's clean fix cycle).
        expect(result.status).toBe('ok');
        const report = reportOf(result);
        expect(report?.observation?.status).toBe('indeterminate');
        expect(report?.observation?.failure).not.toContain('tok');
        // The injected writer closed exactly once, inside finish().
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalled();
        const persisted = JSON.parse(
          await readFile(report!.reportPath, 'utf8'),
        ) as ReviewAddressReport & { observation?: { writer?: unknown } };
        expect(persisted.observation).toEqual(report?.observation);
        expect(persisted.observation?.writer).toBeUndefined();
      } finally {
        await f.cleanup();
        await writer.close().catch(() => undefined);
      }
    },
  );
});
