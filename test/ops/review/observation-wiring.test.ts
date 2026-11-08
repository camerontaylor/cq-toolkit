import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
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
import { createHash } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  openObservationWriter,
  readObservations,
  type ObservationWriter,
} from '../../../src/kernel/observation.js';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
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
import { readFileSync } from 'node:fs';

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

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
  const journalDir = await realTmpDir('t31-obs-');
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
    budgets: { run: { maxTokens: 10000, wallMs: 60000 }, step: { wallMs: 5000 } },
    escalation: { workerAttempts: 2, rescueBase: 1, rescuePerPackageCap: 1 },
  };
  await repo.write('.gitignore', '.cq/\n');
  await repo.write('src/a.ts', 'export const a = "BAD";\n');
  await repo.write('scripts/check.cjs', 'process.exitCode = 0;\n');
  // Pretty-printed on purpose: the provenance hash must cover the cq.json
  // FILE TEXT (T30 parity), which differs from JSON.stringify(config).
  await repo.write('cq.json', `${JSON.stringify(config, null, 2)}\n`);
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
  test('detached fix in checks makes the closed observation indeterminate without moving the verdict', async () => {
    const run = async (drainMs: number) => {
      const f = await fixture();
      const marker = join(f.journalDir, 'checking');
      const release = join(f.journalDir, 'release');
      const controller = new AbortController();
      let fixing: Promise<unknown> | undefined;
      let writer: ObservationWriter | undefined;
      let appendCount = () => 0;
      await f.repo.write(
        'scripts/check.cjs',
        `const fs = require('node:fs');
        if (fs.readFileSync('src/a.ts', 'utf8').includes('GOOD')) {
          fs.writeFileSync(${JSON.stringify(marker)}, 'entered');
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
          }, 5);
        }`,
      );
      f.repo.commitAll('hold candidate checks');
      f.record.head = f.repo.git('rev-parse', 'HEAD').trim();
      try {
        const result = await makeReviewAddress({
          drivers: f.drivers,
          initialRecord: f.record,
          review: f.review,
          workerFactory: (deps) => {
            writer = deps.observationWriter;
            if (writer) {
              const spy = vi.spyOn(writer, 'append');
              appendCount = () => spy.mock.calls.length;
            }
            const engine = makeAddressWorker({
              ...deps,
              parentSignal: controller.signal,
              observationDrainMs: drainMs,
              scanner: async (components) => {
                if (
                  components.some((component) => component.text.includes('related-check feedback'))
                )
                  controller.abort();
                return components.map((component) => ({
                  component: component.component,
                  hits: [],
                }));
              },
            });
            return {
              ...engine,
              fix: async (finding, round) => {
                fixing ??= engine.fix(finding, round);
                for (let i = 0; ; i++) {
                  try {
                    await readFile(marker);
                    break;
                  } catch {
                    if (i > 1000) throw new Error('checks did not start');
                    await new Promise((resolve) => setTimeout(resolve, 5));
                  }
                }
                // Model the kill rung: return while the real fix body continues.
                return {
                  finding: { ...finding, status: 'deferred', reason: 'detached' },
                  observedHead: f.record.head,
                  reason: 'detached',
                  validation: [],
                  failedAttempts: [],
                };
              },
            };
          },
        })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
        const report = reportOf(result);
        expect(report?.observation?.status).toBe('indeterminate');
        expect(report?.observation?.failure).toContain(
          'attempt observation still in flight at close:',
        );
        const callsAtClose = appendCount();
        await writeFile(release, 'release');
        await fixing;
        expect(appendCount()).toBe(callsAtClose);
        expect(writer?.failure).toBeNull();
        return {
          status: result.status,
          findings: report?.findings.map((finding) => finding.status),
        };
      } finally {
        await writeFile(release, 'release');
        await fixing;
        await f.cleanup();
      }
    };
    expect(await run(20)).toEqual(await run(0));
  });

  test('one stream across rounds and plans, runtime deps receive the writer, close before persistence', async () => {
    const f = await fixture();
    // Built at runtime: the denylist scans committed text for token shapes.
    const fakeToken = ['tok', 'en', '-', Math.random().toString(36).slice(2), 'zz'].join('');
    vi.stubEnv('CQ_SANDBOX', 'off');
    vi.stubEnv('CQ_AUTOMATION_TOKEN', fakeToken);
    // A model-spec value once made the strict header schema reject the whole stream.
    vi.stubEnv('CQ_SELFHOST_DRIVER', 'zai/glm-5');
    // Blank means unset: the version must stay the package version, not ''.
    vi.stubEnv('CQ_PRODUCER_VERSION', '  ');
    try {
      const result = await invoke(f);
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      const report = reportOf(result);
      expect(report?.observation).toBeDefined();
      expect(ReportV2Schema.safeParse(report?.reportV2).success).toBe(true);
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
      expect(header.payload.provenance.baseSha).toBe(f.record.head);
      expect(header.payload.provenance.repoId === null).toBe(true);
      // P3-6: the hash covers the cq.json FILE TEXT (pretty-printed by the
      // fixture, so this differs from JSON.stringify(config)), exactly as T30
      // runFix's captureProvenance hashes it.
      expect(header.payload.provenance.cqJsonHash).toBe(
        `sha256:${createHash('sha256')
          .update(await readFile(join(f.repo.root, 'cq.json'), 'utf8'), 'utf8')
          .digest('hex')}`,
      );
      // C5: the resolved env config is recorded; secrets as 'set' only.
      const recorded = header.payload.provenance.config;
      expect(recorded?.env['CQ_SANDBOX']).toBe('off');
      expect(recorded?.env['CQ_AUTOMATION_TOKEN']).toBe('set');
      expect(recorded?.sources['CQ_SANDBOX']).toBe('env');
      expect(recorded?.env['CQ_SELFHOST_DRIVER']).toBe('zai/glm-5');
      expect(header.payload.provenance.cqVersion).toBe(packageVersion);
      expect(report?.observation?.status).not.toBe('indeterminate');
      expect(JSON.stringify(stream.events)).not.toContain(fakeToken);
      expect(JSON.stringify(report)).not.toContain(fakeToken);
      expect(report?.observation?.baseSha).toBe(header.payload.provenance.baseSha);
      // Explicit kernel-run links for every returned run; the linked ids are
      // the actual runs the report retained. P3-9: the count EQUALS the
      // returned-run count — no missing link and no link for an unreturned run.
      const links = stream.events.filter((event) => event.type === 'kernel-run-linked');
      const returned = report?.rounds.flatMap((round) => round.runs.map((run) => run.runId)) ?? [];
      expect(returned.length).toBeGreaterThan(0);
      expect(links.length).toBe(returned.length);
      expect(new Set(links.map((link) => link.payload.kernelRunId))).toEqual(new Set(returned));
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
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      const report = reportOf(result);
      expect(report?.observation?.persistence).toBe('unavailable');
      expect(report?.observation?.kernelRuns).toEqual([]);
      // Read the directory THIS run resolved (the report's own journal dir),
      // not the fixture's unused one: a regression that wrote a stream during
      // a memory-only run must fail here.
      const streams = await readObservations(dirname(report!.reportPath));
      expect(streams).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  test('a fresh journal directory is usable: the writer creates it and the stream is durable', async () => {
    const f = await fixture();
    // P2-1: addressMany hands every PR run exactly this shape — a journal dir
    // that does not exist yet. ENOENT is USABLE (the writer mkdir -p's it).
    const fresh = join(dirname(f.repo.root), 'fresh-journal');
    try {
      await expect(lstat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await makeReviewAddress({
        drivers: f.drivers,
        initialRecord: f.record,
        review: f.review,
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: fresh });
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      const report = reportOf(result);
      expect(report?.observation?.persistence).toBe('durable');
      expect(report?.observation?.status).toBe('durable');
      expect(report?.observation?.failure).toBeNull();
      const streams = await readObservations(fresh);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      expect(streams[0]?.events[0]?.type).toBe('composition-started');
    } finally {
      await f.cleanup();
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test('an admission refusal before ownership creates no journal dir and opens no stream', async () => {
    const f = await fixture();
    // A fresh directory that does not exist yet: opening the writer would
    // create it (mkdir -p), so its continued absence is the ordering witness.
    const fresh = join(dirname(f.repo.root), 'refused-fresh-journal');
    const git = makeGhRunner({ bin: 'git', cwd: f.repo.root, timeoutMs: 10_000 });
    try {
      await expect(lstat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
      await withAddressOwnership(
        { repoRoot: f.repo.root, git, source: 'local', production: false },
        async () => {
          // Another owner holds the guard, so this run is refused in admission
          // BEFORE it enters the owned action.
          const result = await makeReviewAddress({
            drivers: f.drivers,
            initialRecord: f.record,
            review: f.review,
          })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: fresh });
          expect(result.status).toBe('needs-human');
          // No ownership, no journal IO: neither the journal dir nor the stream
          // location may appear.
          await expect(lstat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(lstat(join(fresh, 'observations'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          // The no-stream surface is EXPLICIT, not an accidental omission: a
          // future change that starts writing before ownership must change this
          // report shape to pass.
          const report = reportOf(result);
          expect(report?.observation).toBeDefined();
          expect(report?.observation?.persistence).toBe('unavailable');
          expect(report?.observation?.status).toBe('indeterminate');
          expect(report?.observation?.failure).toContain('ownership not held');
          expect(report?.observation?.kernelRuns).toEqual([]);
        },
      );
    } finally {
      await f.cleanup();
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test('injected writer owns the composition identity and closes before the report persists', async () => {
    const f = await fixture();
    const workId = '00000000-0000-4000-8000-000000000000';
    const compositionRunId = 't31-injected';
    const writer = await openObservationWriter({ workId, compositionRunId });
    const reportPath = join(f.journalDir, 'review-address-report.json');
    // P3-9: record whether the report already existed at close time.
    const persistedWhenClosed: boolean[] = [];
    const originalClose = writer.close.bind(writer);
    const closeSpy = vi.spyOn(writer, 'close').mockImplementation(async () => {
      persistedWhenClosed.push(
        await readFile(reportPath, 'utf8').then(
          () => true,
          () => false,
        ),
      );
      await originalClose();
    });
    try {
      const result = await makeReviewAddress({
        drivers: f.drivers,
        initialRecord: f.record,
        review: f.review,
        observationWriter: writer,
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: f.journalDir });
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      const report = reportOf(result);
      // P3-8: the composition adopts BOTH identities from the injected writer.
      expect(report?.observation?.compositionRunId).toBe(compositionRunId);
      expect(report?.observation?.workId).toBe(workId);
      // P3-9: close happens BEFORE the report write, exactly once.
      expect(persistedWhenClosed).toEqual([false]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('"observation"');
      const header = writer.events()[0];
      expect(header?.type).toBe('composition-started');
      if (header?.type === 'composition-started') {
        expect(header.runId).toBe(compositionRunId);
        expect(header.payload.correlation.workId).toBe(workId);
      }
    } finally {
      await f.cleanup();
      await writer.close().catch(() => undefined);
    }
  });

  test('an unwitnessable base never fails the run and records null/unavailable', async () => {
    const f = await fixture();
    const realGit = makeGhRunner({ bin: 'git', cwd: f.repo.root, timeoutMs: 10_000 });
    let probeFailed = false;
    const git: GhFn = async (args) => {
      // Fail ONLY the composition's first base probe (the local HEAD read);
      // every later git call in the run is real.
      if (
        !probeFailed &&
        args.includes('rev-parse') &&
        args.includes('-C') &&
        args.at(-1) === 'HEAD'
      ) {
        probeFailed = true;
        return { code: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD' };
      }
      return realGit(args);
    };
    try {
      const result = await makeReviewAddress({
        git,
        drivers: f.drivers,
        initialRecord: f.record,
        review: f.review,
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: f.journalDir });
      // P3-5: an observation PRE-FLIGHT failure never changes the verdict.
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      expect(probeFailed).toBe(true);
      const report = reportOf(result);
      expect(report?.observation?.baseSha).toBeNull();
      expect(report?.observation?.status).toBe('indeterminate');
      expect(report?.observation?.persistence).toBe('unavailable');
      expect(report?.observation?.failure).toContain('base witness unavailable');
      // No base, no schema-valid header: no stream file is written at all.
      expect(await readObservations(f.journalDir)).toHaveLength(0);
      expect(report?.observation?.kernelRuns).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test('a null base with an injected writer appends no links, hands nothing to the worker, and still closes', async () => {
    const f = await fixture();
    const realGit = makeGhRunner({ bin: 'git', cwd: f.repo.root, timeoutMs: 10_000 });
    let probeFailed = false;
    const git: GhFn = async (args) => {
      // Fail ONLY the composition's first base probe: the run sees no base.
      if (
        !probeFailed &&
        args.includes('rev-parse') &&
        args.includes('-C') &&
        args.at(-1) === 'HEAD'
      ) {
        probeFailed = true;
        return { code: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD' };
      }
      return realGit(args);
    };
    const writer = await openObservationWriter({
      workId: '00000000-0000-4000-8000-000000000000',
      compositionRunId: 't31-null-base',
    });
    const appendSpy = vi.spyOn(writer, 'append');
    const closeSpy = vi.spyOn(writer, 'close');
    try {
      const result = await makeReviewAddress({
        git,
        drivers: f.drivers,
        initialRecord: f.record,
        review: f.review,
        observationWriter: writer,
        workerFactory: (deps) => {
          f.boundDeps.push(deps);
          return makeAddressWorker(deps);
        },
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: f.journalDir });
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      expect(probeFailed).toBe(true);
      const report = reportOf(result);
      expect(report?.observation?.baseSha).toBeNull();
      expect(report?.observation?.status).toBe('indeterminate');
      expect(report?.observation?.failure).toContain('base witness unavailable');
      // P3-2: with no header written there is no streaming surface. The
      // injected writer receives NO link appends and is NOT handed to the
      // worker; only its close lifecycle is adopted.
      expect(appendSpy).not.toHaveBeenCalled();
      expect(f.boundDeps.length).toBeGreaterThan(0);
      expect(f.boundDeps.every((deps) => deps.observationWriter === undefined)).toBe(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // No stream exists: the writer was never a composition stream source.
      expect(await readObservations(f.journalDir)).toHaveLength(0);
    } finally {
      await f.cleanup();
      await writer.close().catch(() => undefined);
    }
  });
});

// ---- T31 unknown evidence -------------------------------------------------

describe('T31 unknown evidence: unreturned runs stay unlinked', () => {
  test('a refusal after the stream opens leaves no kernel-run link and no guessed id', async () => {
    const f = await fixture();
    try {
      // A findings record whose head does not match the checkout refuses in
      // admission — AFTER the composition stream has opened (header written),
      // before any dispatch. The stream boundary exists; no link may.
      const result = await makeReviewAddress({
        drivers: f.drivers,
        initialRecord: { ...f.record, head: 'b'.repeat(40) },
        review: f.review,
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: f.journalDir });
      expect(result.status).toBe('needs-human');
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      // No kernel-run link is guessed; the terminal measurement-summary
      // (ADR-0008 T23) is the only event after the header — this exit prints
      // its counts too, with an unseeded denominator.
      expect(streams[0]?.events.map((event) => event.type)).toEqual([
        'composition-started',
        'measurement-summary',
      ]);
      expect(streams[0]?.events.some((event) => event.type === 'kernel-run-linked')).toBe(false);
      expect(reportOf(result)?.observation?.kernelRuns).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test('a pre-dispatch refusal leaves no kernel-run link and no guessed id', async () => {
    const f = await fixture();
    try {
      // A missing findings record refuses AFTER the stream opens (ownership
      // is held, the header lands), before any dispatch: only the stream
      // boundaries may exist — never a kernel-run link.
      const result = await makeReviewAddress({
        drivers: f.drivers,
        review: f.review,
      })({ repoRoot: f.repo.root, source: 'local' as const, journalDir: f.journalDir });
      expect(result.status).not.toBe('ok');
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      expect(streams[0]?.events[0]?.type).toBe('composition-started');
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
  test.each(['header', 'link', 'close', 'fold'] as const)(
    '%s writer failure preserves the run verdict and reports an indeterminate, sanitized surface',
    async (boundary) => {
      const f = await fixture();
      const writer = await openObservationWriter({
        workId: '00000000-0000-4000-8000-000000000000',
        compositionRunId: 't31-fixture',
      });
      const append = writer.append.bind(writer);
      const originalClose = writer.close.bind(writer);
      if (boundary === 'fold') {
        const events = writer.events.bind(writer);
        vi.spyOn(writer, 'events').mockImplementation(() => [...events(), ...events()]);
      }
      // P3-8: the composition adopts the writer's own compositionRunId/workId,
      // so the injected events pass through unchanged — no test-side rewrite.
      const appendSpy = vi.spyOn(writer, 'append').mockImplementation(async (event) => {
        if (boundary === 'header' && event.type === 'composition-started')
          throw new Error('https://u:tok@h/x?k=v');
        if (boundary === 'link' && event.type === 'kernel-run-linked') await originalClose();
        await append(event);
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
        await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
        const report = reportOf(result);
        expect(ReportV2Schema.safeParse(report?.reportV2).success).toBe(true);
        expect(report?.reportV2?.availability['']?.state).toBe(
          boundary === 'header' || boundary === 'fold' ? 'unavailable' : 'partial',
        );
        if (boundary !== 'fold') expect(report?.observation?.status).toBe('indeterminate');
        if (boundary !== 'fold') expect(report?.observation?.failure).not.toContain('tok');
        // The injected writer closed exactly once, inside finish().
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalled();
        if (boundary === 'header') {
          // P3-2: the header append failed, so the streaming writer was never
          // published. Exactly one append (the header itself) may be observed,
          // no kernel-run link may follow, and no bound worker may receive the
          // writer - the surface only streams once the header has landed.
          expect(appendSpy).toHaveBeenCalledTimes(1);
          expect(f.boundDeps.every((deps) => deps.observationWriter === undefined)).toBe(true);
        }
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

  test('an observation OPEN failure leaves the surface indeterminate and changes no verdict', async () => {
    const f = await fixture();
    try {
      // P3-1: the exclusive create fails here (ENOTDIR: a regular file sits
      // where the stream directory must go; EEXIST on a pre-existing stream
      // file and EACCES/ENOSPC are the same class). The open failure is an
      // OBSERVATION failure: it must not reach the owned catch, which would
      // turn the run into needs-human.
      await writeFile(join(f.journalDir, 'observations'), 'not a directory\n');
      const result = await invoke(f);
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      const report = reportOf(result);
      expect(report?.observation?.status).toBe('indeterminate');
      expect(report?.observation?.persistence).toBe('unavailable');
      expect(report?.observation?.failure).toContain('ENOTDIR');
      expect(report?.observation?.kernelRuns).toEqual([]);
      // No writer existed, so nothing was handed to the worker.
      expect(f.boundDeps.length).toBeGreaterThan(0);
      expect(f.boundDeps.every((deps) => deps.observationWriter === undefined)).toBe(true);
      // The run continued without opening a stream: the blocker is untouched.
      expect((await lstat(join(f.journalDir, 'observations'))).isFile()).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});
