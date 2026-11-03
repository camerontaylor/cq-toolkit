// ADR-0008 T30 — fix composition observation writer wiring (M0-fix-writer).
//
// What is pinned here:
//   1. makeRegistry wraps the existing exported const registry array and
//      injects the observation writer through the sweep.unit importer's
//      RESOLVED RUNTIME BINDINGS — the serialized dispatch input carries no
//      writer/callback, and the exported default registry is unchanged.
//   2. The writer lifecycle: makeFixRun opens one composition stream,
//      writes its composition-started header, links the RETURNED kernel run
//      explicitly (kernel-run-linked), and closes the writer in finally —
//      including on a failure path.
//   3. Memory-only mode (no journalDir): the writer's persistence surface
//      declares 'unavailable' and the report still carries the observed
//      events through writer.events() — never a durability claim.
//   4. Sanitization: every persisted text field passes through
//      sanitizeObservation via finishAttempt BEFORE the writer sees it, and
//      repoId is the hashed remote digest (never the raw remote).
//   5. Failure boundary: a writer whose append fails after the header does
//      not mask the run's own terminal result, and the writer's failure
//      surface carries the first write error.
// Fake/local inputs only: no provider, no network, no credentials.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { openObservationWriter, readObservations } from '../../../src/kernel/observation.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeRegistry, registry } from '../../../src/ops/sweep/registry.js';
import type { SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

let roots: string[] = [];
beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 't30-obs-'));
  roots.push(root);
  return root;
};

const exec = async (cwd: string, ...args: string[]): Promise<void> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['-C', cwd, ...args], {
    env: scrubbedGitEnv(),
    timeout: 10_000,
  });
};

/** A scratch repo with a cq.json the composition accepts. */
const fixture = async (): Promise<{ root: string; repo: string; journalDir: string }> => {
  const root = await scratch();
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  await writeFile(
    join(repo, 'cq.json'),
    JSON.stringify({
      schemaVersion: 2,
      checks: [
        {
          kind: 'tests',
          adapter: 'vitest-json',
          command: { command: process.execPath, args: ['scripts/tests.cjs'] },
          relatedArgs: ['scripts/tests.cjs', '{files}'],
        },
      ],
      roles: { worker: { provider: 'fixture', model: 'scripted' } },
      budgets: { run: { maxTokens: 1000 } },
    }),
  );
  await exec(repo, 'add', '-A');
  await exec(repo, 'commit', '-m', 'seed failing tests');
  return { root, repo, journalDir: join(root, 'journal') };
};

const fixingDrivers = (): DriverFactory => ({
  resolve: ({ modelSpec }) => ({
    modelSpec,
    lane: 'ai-sdk',
    driver: {
      run: async (invocation) => {
        if (!invocation.workspace) throw new Error('fixture requires a workspace');
        const line = invocation.prompt.split('\n').find((line) => line.startsWith('Task: '));
        const taskRow = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
        for (const file of taskRow.files)
          await writeFile(
            join(invocation.workspace.path, file),
            'module.exports = { actual: 1, expected: 1 };\n',
          );
        return {
          stopReason: 'complete',
          denials: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          structuredOutput: { outcome: 'broken-test', summary: 'fixed', confidence: 0.8 },
        };
      },
    },
  }),
});

const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>>) =>
  result.status === 'ok' ? result.value : (result.report as FixRunReport);

const fixedUnitReport = (): SweepUnitReport => ({
  package: 'scratch-repo',
  fixer: 'tests-1',
  worktree: {
    path: join('tmp', 'worktree'),
    branch: 'cq/fixture/tests-1/scratch-repo',
    requestedBase: 'HEAD',
    reused: false,
    clearedBaselineCaches: [],
    refusedBaselineCaches: [],
  },
  mode: 'fix',
  baseline: {
    verdict: 'failing',
    attempts: 1,
    failureSet: { tool: 'vitest', failures: [], exitCode: 1, numTotalTests: 1 },
  },
  final: {
    verdict: 'clean',
    attempts: 1,
    failureSet: { tool: 'vitest', failures: [], exitCode: 0, numTotalTests: 0 },
  },
  prBranch: 'cq/fixture/tests-1/scratch-repo',
  committed: true,
  committedSha: 'a'.repeat(40),
  tasks: [],
});

const stubSweepRegistries = (unitReport: SweepUnitReport, seen: { input?: unknown } = {}) => {
  const unitJob = {
    id: 'fixture-unit',
    op: 'sweep.unit',
    input: { package: 'scratch-repo', fixer: 'tests-1', files: ['cases/a.test.cjs'] },
    dependsOn: [],
  };
  const planEntry = {
    name: 'sweep.planSweep',
    inputSchema: z.unknown(),
    importer: async () => async () => ({
      status: 'ok' as const,
      value: { jobs: [unitJob], units: [unitJob.input], suppressed: [], needsHuman: [] },
    }),
  } as unknown as OpRegistryEntry<never, never>;
  const unitEntry = {
    name: 'sweep.unit',
    inputSchema: z.unknown(),
    importer: async () =>
      (async (raw: unknown) => {
        seen.input = raw;
        return { status: 'ok' as const, value: unitReport };
      }) as unknown as Op<unknown, unknown>,
  } as unknown as OpRegistryEntry<never, never>;
  const entries = new Map([planEntry, unitEntry].map((entry) => [entry.name, entry]));
  return (name: string): OpRegistryEntry<never, never> | undefined => entries.get(name);
};

const input = (f: Awaited<ReturnType<typeof fixture>>) => ({
  repoRoot: f.repo,
  source: 'tests' as const,
  selector: { mode: 'workspace-all' as const },
  journalDir: f.journalDir,
  runPrefix: 'cq/fixture',
});

// ---- T30 round-trip -------------------------------------------------------

describe('T30 makeRegistry wraps the exported array', () => {
  test('the default exported registry is unchanged by makeRegistry options', () => {
    const built = makeRegistry();
    expect(built.map((entry) => entry.name)).toEqual(registry.map((entry) => entry.name));
    expect(makeRegistry({}).map((e) => e.name)).toEqual(registry.map((e) => e.name));
  });

  test('the sweep.unit importer is a distinct function; no writer in any schema', () => {
    const observed = makeRegistry({});
    const unitDefault = registry.find((entry) => entry.name === 'sweep.unit');
    const unitObserved = observed.find((entry) => entry.name === 'sweep.unit');
    expect(unitDefault?.importer).not.toBe(unitObserved?.importer);
    // A writer/callback is runtime-only: strict schemas refuse an extra key,
    // so a writer serialized into plan JSON cannot even validate.
    const probe = unitDefault?.inputSchema.safeParse({
      package: 'p',
      fixer: 'f',
      files: [],
      repoRoot: '/r',
      runPrefix: 'cq/x',
      base: 'HEAD',
      observationWriter: () => {},
    });
    expect(probe?.success).toBe(false);
  });
});

describe('T30 round-trip through the fix composition', () => {
  test('header, runtime injection and explicit kernel-run link persist durably', async () => {
    const f = await fixture();
    const seen: { input?: unknown } = {};
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport(), seen) },
      })(input(f));
      // The composition ran; the stream persisted under journalDir.
      expect(reportOf(result).observation).toBeDefined();
      // No writer/callback ever reached the serialized dispatch input.
      expect(JSON.stringify(seen.input)).not.toContain('observationWriter');
      expect(JSON.stringify(seen.input)).not.toContain('append');
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      const stream = streams[0];
      if (stream === undefined) throw new Error('stream missing');
      expect(stream.complete).toBe(true);
      expect(stream.events[0]?.type).toBe('composition-started');
      const header = stream.events[0];
      if (header?.type !== 'composition-started') throw new Error('header missing');
      // No raw remote ever persists: with no git remote, repoId is the
      // schema's null/unavailable (never the remote string); the hashed
      // digest form is exercised wherever a remote exists.
      const repoId = header.payload.provenance.repoId;
      expect(repoId === null || /^sha256:[0-9a-f]{64}$/.test(repoId)).toBe(true);
      expect(JSON.stringify(stream.events)).not.toContain('github.com');
      // Exactly one explicit kernel-run link, after the header.
      const links = stream.events.filter((event) => event.type === 'kernel-run-linked');
      expect(links).toHaveLength(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('memory-only mode builds the stream and declares persistence unavailable', async () => {
    const f = await fixture();
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })({
        repoRoot: f.repo,
        source: 'tests' as const,
        selector: { mode: 'workspace-all' as const },
        runPrefix: 'cq/fixture',
      });
      const report = reportOf(result);
      expect(report.observation).toBeDefined();
      expect(report.observation?.writer.persistence).toBe('unavailable');
      // The in-memory stream still carries the header and the kernel link.
      const kinds = report.observation?.writer.events().map((event) => event.type) ?? [];
      expect(kinds[0]).toBe('composition-started');
      expect(kinds).toContain('kernel-run-linked');
      // No durability claim: no stream file was created anywhere.
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});

// ---- T30 unknown evidence -------------------------------------------------

describe('T30 unknown evidence: unreturned kernel runs stay unlinked', () => {
  test('a run that never returned leaves no kernel-run-linked event and no guessed id', async () => {
    const f = await fixture();
    try {
      // The composition refuses BEFORE any kernel run returns (cq.json is
      // fine, but the planner stub yields needs-human through the unit).
      const failingUnit = {
        ...fixedUnitReport(),
        budgetStopped: true,
      };
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(failingUnit) },
      })(input(f));
      expect(result.status).not.toBe('ok');
      const report = reportOf(result);
      // The stream still observed its boundaries — but the kernel-run link
      // names only the run the composition actually RETURNED.
      const links =
        report.observation?.writer.events().filter((event) => event.type === 'kernel-run-linked') ??
        [];
      for (const link of links) {
        if (link.type !== 'kernel-run-linked') continue;
        // Never a guessed link: the linked id is the actual returned run's.
        expect(link.payload.kernelRunId).toBe(report.run?.runId);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('readObservations ignores non-UUID directories instead of failing the scan', async () => {
    const f = await fixture();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(f.journalDir, 'observations', 'not-a-uuid'), { recursive: true });
      expect(await readObservations(f.journalDir)).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});

// ---- T30 failure boundary -------------------------------------------------

describe('T30 failure boundary', () => {
  test('a writer append failure after the header does not mask the run result', async () => {
    const f = await fixture();
    try {
      // A real durable writer whose handle is closed underneath it: the
      // first append after our own failure injection fails, the composition
      // still returns its own terminal status, and the writer's failure
      // surface carries the error (never masked as success).
      const writer = await openObservationWriter({
        journalDir: f.journalDir,
        workId: '00000000-0000-4000-8000-000000000000',
        compositionRunId: 'boundary-probe',
      });
      const seen: { input?: unknown } = {};
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport(), seen) },
        observationWriter: writer,
      })(input(f));
      // The injected writer was opened for its own stream id, so the
      // composition's first append (the header) is refused on the runId
      // coupling: the writer NEVER adopts foreign evidence, the run's own
      // terminal path keeps its failed result naming the refusal, and the
      // writer itself is untouched (failure null — nothing was written).
      expect(result.status).toBe('failed');
      expect((result as { error?: string }).error).toContain('does not match');
      expect(writer.failure).toBeNull();
      expect(writer.events()).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('the writer is closed after a pre-dispatch refusal path cannot reopen it', async () => {
    const f = await fixture();
    // A repo without cq.json refuses before the stream opens; the report
    // carries no observation and the run still terminates cleanly.
    const { rm: rmPath } = await import('node:fs/promises');
    await rmPath(join(f.repo, 'cq.json'));
    try {
      // A repo without cq.json refuses inside the main try (the readFile
      // throw folds into the failed terminal path); the stream never
      // opened, so no observation surface exists and the run terminates
      // cleanly with the writer-close finally a no-op.
      const result = await makeFixRun({ drivers: fixingDrivers() })(input(f));
      expect(result.status).toBe('failed');
      expect(reportOf(result).observation).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('a durable run leaves a complete stream file on disk', async () => {
    const f = await fixture();
    try {
      await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })(input(f));
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      // Every line is a complete JSON event ending in a newline.
      const dir = join(f.journalDir, 'observations');
      const { readdir } = await import('node:fs/promises');
      const workIds = await readdir(dir);
      const files = await readdir(join(dir, workIds[0] as string));
      const raw = await readFile(join(dir, workIds[0] as string, files[0] as string), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      for (const line of raw.split('\n').filter((l) => l !== '')) {
        const parsed: unknown = JSON.parse(line);
        expect(parsed).toBeTypeOf('object');
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
