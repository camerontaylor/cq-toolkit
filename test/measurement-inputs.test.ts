// M10b: read offline measurement artifacts. One case per asserted condition:
//   - explicit local directories only (no ambient scan, no network);
//   - dedup by repo/run/invocation identity (null repo is its own identity; a
//     workId disagreement on one identity is a conflict, never a silent dedup);
//   - schema version and checksum validation (full v2 report schema);
//   - non-measurement files (.log, markerless .json away from producer
//     paths) are skipped silently, while a markerless .json AT a producer
//     path (report basename or the session-index root) is a legacy
//     artifact — an unsupported unknown;
//   - corrupt/missing/untrusted/unsupported/conflicting children -> unknown
//     bucket, never a fallback zero, and never a known total (P1-1: any
//     rejected, torn, partially observed or unavailable input forces partial
//     or unavailable totals);
//   - parent-child references prevent double-counting costs, and a parent is
//     only complete when every leaf its row claims was observed with sums
//     that MATCH the row — a shortfall or an excess is a partial unknown —
//     while a row of the same run under another workId is a cross-work
//     conflict that adds nothing (P1-2, P2-1, P3-4);
//   - totals.attempts carries its own '/attempts' availability with the same
//     unknown-never-zero rule as the costs (P2-2), flagged incomplete by every
//     whole-record availability (report root, report '/attempts', leaf root,
//     row root) — and a row claiming zero attempts beside costs is corrupt;
//   - a malformed manifest (non-object files[] element, an unsupported
//     capture state, a declared session index with no ingested artifact) is
//     unknown evidence, never a silent drop (P3-1..P3-3);
//   - the lstat/open race (FIFO or symlink swapped in mid-read) is refused
//     without blocking (P2-3, P3-2).
// Local fixtures only: M8a-shaped bundle directories, no providers, no network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// The ACTUAL fs promises, distinct from the node:fs/promises specifier the
// race hook wraps: workspace() must resolve the physical temp path even on
// macOS alias roots, without routing through the mocked realpath.
import { promises as actualFs } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readMeasurementInputs } from '../scripts/measurement-inputs.mjs';

const REPO = `sha256:${'a'.repeat(64)}`;
const WORK = '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f';
const WORK2 = '2b8e6c15-9d47-4a1f-b6c3-7e0d5f8a9b1c';
const RUN = 'run-1';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];

// Race hook for the lstat/open window: the mocked realpath swaps the artifact
// (regular file -> FIFO, or -> symlink) after the component checks pass but
// before open(), which is exactly the window the FIFO finding describes.
const race = vi.hoisted(() => ({
  onResolvedPath: null as null | ((resolved: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (async (path: string, options?: { encoding?: 'utf8' }) => {
      const resolved = await actual.realpath(path, options);
      if (race.onResolvedPath !== null) await race.onResolvedPath(resolved);
      return resolved;
    }) as typeof actual.realpath,
  };
});

async function workspace(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'cq-m10b-'));
  // The physical path, not the alias macOS gives tmpdir() (/var ->
  // /private/var): the reader canonicalizes the bundle root, and the race
  // hooks match on resolved paths — an aliased base would miss every match,
  // so the FIFO and ELOOP swaps never fire on static-macos.
  const dir = await actualFs.realpath(made);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  race.onResolvedPath = null;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface AvailabilityFixture {
  state: string;
  reason: string;
  source: string | null;
}

const avail = (state: string, reason: string): AvailabilityFixture => ({
  state,
  reason,
  source: null,
});

/** Reject a promise if it has not settled within `ms` (the FIFO block guard). */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: exceeded the ${ms}ms deadline`)),
      ms,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface AttemptOptions {
  availability?: Record<string, AvailabilityFixture>;
  stopCode?: string;
  runId?: string;
}

function attempt(
  invocation: string,
  tokens: number | null,
  wallMs: number | null,
  options: AttemptOptions = {},
) {
  return {
    type: 'attempt-finished',
    runId: options.runId ?? RUN,
    at: '2026-11-03T05:00:00.000Z',
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      tier: 'worker',
      invocation,
      model: { model: 'glm-5.3', provider: 'zai' },
      provider: 'zai',
      requestedModel: 'glm-5.3',
      servedModel: null,
      tokens,
      usageChannels: {},
      requests: 1,
      wallMs,
      modeledUsd: null,
      priceTableRevision: null,
      priceCoverage: null,
      stopReason: 'completed',
      stopCode: options.stopCode ?? 'completed',
      class: 'terminal',
      error: null,
      timeout: null,
      budget: {
        allowed: { tokens: null, wallMs: null },
        spent: { tokens, wallMs },
        remaining: { tokens: null, wallMs: null },
      },
      availability: options.availability ?? {},
    },
  };
}

interface ReportOptions {
  availability?: Record<string, AvailabilityFixture>;
  /** null omits the remote identity (repoId null); undefined keeps REPO. */
  repoId?: string | null;
  workId?: string;
}

function report(attempts: unknown[], options: ReportOptions = {}) {
  const producerNotWired = avail('unavailable', 'producer not yet wired');
  return {
    reportVersion: 2,
    provenance: {
      cqVersion: '0.2.0-dev',
      producerVersion: '0.2.0-dev',
      repoId: options.repoId === null ? null : (options.repoId ?? REPO),
      cqJsonHash: `sha256:${'b'.repeat(64)}`,
      baseSha: 'a'.repeat(40),
      runPrefix: 'run',
      startedAt: '2026-11-03T04:59:00.000Z',
      endedAt: '2026-11-03T05:01:00.000Z',
      journalLink: 'observations/w/j.ndjson',
      reportLink: 'reports/w/r.json',
      witnesses: {
        base: 'a'.repeat(40),
        admitted: null,
        execution: null,
        reviewed: null,
        accepted: null,
      },
    },
    correlation: {
      workId: options.workId ?? WORK,
      parentWorkId: null,
      branch: 'b',
      commitSha: null,
      sessionId: null,
      agentId: null,
    },
    tasks: [],
    attempts,
    gates: [],
    dispositions: [],
    acceptances: [],
    reviews: [],
    approvals: [],
    writeDecisions: [],
    metric: {
      fixesPerRun: { numerator: null, denominator: null },
      verifiedCommits: [],
      closures: [],
      baselineFailures: [],
    },
    availability: {
      '': avail('known', 'all observation streams are whole'),
      '/attempts': avail('known', 'measured attempt-finished events'),
      '/provenance': avail('known', 'witnessed composition header'),
      '/tasks': producerNotWired,
      '/gates': producerNotWired,
      '/dispositions': producerNotWired,
      '/reviews': producerNotWired,
      '/approvals': producerNotWired,
      '/writeDecisions': producerNotWired,
      '/metric': producerNotWired,
      '/metric/fixesPerRun/numerator': producerNotWired,
      '/metric/fixesPerRun/denominator': producerNotWired,
      '/acceptances': avail('unavailable', 'T20 acceptance importer deferred'),
      ...options.availability,
    },
  };
}

interface RowOptions {
  attempts?: number;
  availability?: Record<string, AvailabilityFixture>;
  repo?: string | null;
  workId?: string;
  runId?: string;
}

function row(tokens: number | null, wallMs: number | null, options: RowOptions = {}) {
  return {
    repo: options.repo ?? REPO,
    sessionId: null,
    workId: options.workId ?? WORK,
    parentWorkId: null,
    branch: 'b',
    commitSha: null,
    runId: options.runId ?? RUN,
    agentId: null,
    model: { model: 'glm-5.3', provider: 'zai' },
    attempts: options.attempts ?? 1,
    tokens,
    wallMs,
    stopReasons: [],
    availability: options.availability ?? {},
  };
}

function index(tokens: number | null, wallMs: number | null, options: RowOptions = {}) {
  return { indexVersion: 1, sessions: [row(tokens, wallMs, options)] };
}

interface BundleOptions {
  manifest?: Record<string, unknown>;
  tamper?: string;
}

async function bundle(
  base: string,
  name: string,
  files: Record<string, string>,
  options: BundleOptions = {},
): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  const entries: Array<Record<string, unknown>> = [];
  for (const [rel, content] of Object.entries(files)) {
    const pointer = `files/${rel}`;
    await mkdir(dirname(join(dir, pointer)), { recursive: true });
    await writeFile(join(dir, pointer), content);
    const [root, ...rest] = rel.split('/');
    entries.push({
      root,
      path: rest.join('/'),
      state: 'present',
      pointer,
      sha256: sha256(content),
      sourceSha256: sha256(content),
    });
  }
  const manifest = {
    bundleVersion: 1,
    runId: RUN,
    files: entries,
    missing: [],
    sessionIndex: { state: 'unknown', reason: 'none' },
    receipts: { state: 'unavailable' },
    ...options.manifest,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (options.tamper !== undefined) await writeFile(join(dir, options.tamper), 'tampered');
  return dir;
}

describe('M10b nominal evidence', () => {
  test('reads only explicit local directories, never ambient state', async () => {
    const base = await workspace();
    const wanted = await bundle(base, 'wanted', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const decoy = await bundle(base, 'decoy', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-z', 999, 999)])),
    });

    const result = await readMeasurementInputs({ dirs: [wanted] });

    expect(result.inputs.map((row) => row.invocation)).toEqual(['inv-a']);
    expect(result.inputs[0]?.source).toContain(wanted);
    expect(result.inputs[0]?.source).not.toContain(decoy);
    expect(result.unknown).toEqual([]);
    expect(await readMeasurementInputs({ dirs: [] })).toEqual({
      inputs: [],
      parents: [],
      unknown: [],
      totals: {
        attempts: 0,
        tokens: null,
        wallMs: null,
        modeledUsd: null,
        availability: {
          '/attempts': {
            state: 'known-zero',
            reason: 'zero attempts observed',
            source: null,
          },
          '/tokens': {
            state: 'n-a',
            reason: 'no token evidence was observed',
            source: null,
          },
          '/wallMs': { state: 'n-a', reason: 'no wall evidence was observed', source: null },
          '/modeledUsd': {
            state: 'n-a',
            reason: 'no modeled USD evidence was observed',
            source: null,
          },
        },
      },
    });

    const source = await readFile('scripts/measurement-inputs.mjs', 'utf8');
    for (const forbidden of ['fetch(', 'node:http', 'node:https', 'node:net', 'node:tls'])
      expect(source).not.toContain(forbidden);
  });

  test('dedups repo/run/invocation identity across artifacts', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'dedup', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-copy.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.invocation).toBe('inv-a');
    expect(result.inputs[0]?.repo).toBe(REPO);
    expect(result.inputs[0]?.workId).toBe(WORK);
    expect(result.inputs[0]?.runId).toBe(RUN);
    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(100);
  });

  test('a null repo and a named repo are distinct identities, never merged', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'null-repo', {
      'fix/state/report-local.json': JSON.stringify(
        report([attempt('inv-a', 100, 400)], { repoId: null }),
      ),
      'fix/state/report-remote.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // Same run and invocation under no remote and under a named remote are
    // two identities: neither adopts the other's rows, so both are listed.
    expect(result.inputs).toHaveLength(2);
    expect(result.unknown).toEqual([]);
  });

  test('validates schema version and checksums before use', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'valid', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(index(100, 400, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(1);
    expect(result.parents).toHaveLength(1);
    const parent = result.parents[0];
    expect(parent?.source).toContain('session-index/session-index.json');
    expect(parent && { ...parent, source: 0 }).toEqual({
      repo: REPO,
      runId: RUN,
      workId: WORK,
      parentWorkId: null,
      attempts: 1,
      tokens: 100,
      wallMs: 400,
      source: 0,
      mirrored: true,
    });
    expect(result.unknown).toEqual([]);
  });

  test('keys parents by repo, workId and runId, not runId alone', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'two-works', {
      'fix/state/report-a.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-b.json': JSON.stringify(
        report([attempt('inv-b', 50, 200)], { workId: WORK2 }),
      ),
      'session-index/index-a.json': JSON.stringify(index(100, 400, { attempts: 1 })),
      'session-index/index-b.json': JSON.stringify(index(50, 200, { attempts: 1, workId: WORK2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // One composition run, two works: runId alone would collapse them.
    expect(result.parents).toHaveLength(2);
    expect(result.parents.map((parent) => parent.workId).sort()).toEqual([WORK, WORK2]);
    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(150);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('accepts the M8a bundle shape, ignoring receipts, streams and logs', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'm8a', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/observations/work/run.ndjson': '{"type":"composition-started"}\n',
      'fix/observations/work/agent.log': 'not json at all\n',
      'git-common-dir/ns/dispatch.jsonl': '{"action":"review"}\n',
      'git-common-dir/ns/bookkeeping.json': '{}\n',
      'session-index/session-index.json': JSON.stringify(index(100, 400, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(1);
    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('a non-measurement .log artifact never becomes corrupt evidence', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'log-skip', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/observations/work/agent.log': 'definitely not json\n',
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('a stray markerless .json beside a valid report never degrades totals', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'stray-json', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'worktree/package.json': '{"name":"not-a-report"}',
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // package.json parses but carries none of the measurement markers
    // (reportVersion, reportV2, indexVersion): non-measurement, skipped
    // silently — the report's totals stay known, never partial.
    expect(result.unknown).toEqual([]);
    expect(result.inputs).toHaveLength(1);
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('reads the embedded v2 payload in persisted operation reports', async () => {
    const base = await workspace();
    const embedded = JSON.stringify(report([attempt('inv-a', 100, 400)]));
    const dir = await bundle(base, 'persisted', {
      // The shapes runFix and review.address persist: an outer report whose
      // reportV2 carries the assembled v2 payload — no writer emits a
      // standalone v2 report, so this is where attempt evidence lives.
      'fix/state/fix-run-report-9f2c.json': `{"verdict":"ok","reportV2":${embedded}}`,
      'fix/state/review-address-report.json': `{"verdict":"ok","reportV2":${embedded}}`,
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // Both outer reports embed the same payload: one identity, read once.
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.invocation).toBe('inv-a');
    expect(result.unknown).toEqual([]);
    expect(result.totals.attempts).toBe(1);
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('operation-report envelope version: 1 is read, absent is legacy v1, anything else is refused at ANY path', async () => {
    const base = await workspace();
    const uuid = '9f2b7c4d-8e1a-4b3c-9d5e-6a7f8b9c0d1e';
    const embedded = report([attempt('inv-a', 100, 400)]);
    // The envelope is recognised by its reportV2 payload, not by its name:
    // the production UUID name, the pre-existing non-UUID fixture name, a
    // renamed report, and the sibling review-address location are all
    // governed by the version the envelope declares.
    const paths = [
      `fix-journal/fix-run-report-${uuid}.json`,
      'fix/state/fix-run-report-9f2c.json',
      'fix/state/report.json',
      'review-journal/w/review-address-report.json',
    ];
    for (const [index, path] of paths.entries()) {
      for (const [label, version] of [
        ['v1', 1],
        ['legacy', undefined],
      ] as const) {
        const envelope =
          version === undefined
            ? { verdict: 'ok', reportV2: embedded }
            : { version, verdict: 'ok', reportV2: embedded };
        const dir = await bundle(base, `report-${label}-${index}`, {
          [path]: JSON.stringify(envelope),
        });
        const result = await readMeasurementInputs({ dirs: [dir] });
        expect(result.unknown).toEqual([]);
        expect(result.inputs).toHaveLength(1);
        expect(result.totals.tokens).toBe(100);
        expect(result.totals.availability['/tokens']?.state).toBe('known');
      }
      // Any other version is refused fail-closed BEFORE the embedded payload
      // is read, whatever path the envelope sits at.
      const future = await bundle(base, `report-v2-${index}`, {
        [path]: JSON.stringify({ version: 2, verdict: 'ok', reportV2: embedded }),
      });
      const refused = await readMeasurementInputs({ dirs: [future] });
      expect(refused.inputs).toEqual([]);
      expect(refused.unknown).toHaveLength(1);
      expect(refused.unknown[0]).toMatchObject({ kind: 'unsupported' });
      expect(refused.unknown[0]?.reason).toContain('operation report version 2');
      expect(refused.totals.tokens).toBeNull();
      expect(refused.totals.availability['/tokens']?.state).toBe('unavailable');
    }
  });

  test('unmirrored session rows contribute attempts, never across works', async () => {
    const base = await workspace();
    const indexOnly = await bundle(base, 'index-only', {
      'session-index/session-index.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });

    const onlyIndex = await readMeasurementInputs({ dirs: [indexOnly] });

    // The row's costs are admitted as evidence; its attempt count is evidence
    // too — reporting measured costs alongside zero attempts contradicts it.
    expect(onlyIndex.totals.attempts).toBe(2);
    expect(onlyIndex.totals.tokens).toBe(150);
    expect(onlyIndex.totals.availability['/tokens']?.state).toBe('known');

    const mixed = await bundle(base, 'mixed', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/other.json': JSON.stringify(index(50, 200, { attempts: 2, workId: WORK2 })),
    });

    const mixedResult = await readMeasurementInputs({ dirs: [mixed] });

    // The report's leaf counts once; a sibling row of the same run under
    // another workId is a cross-work conflict (one run cannot be two works),
    // so its attempts and costs are never added on top of the leaf's.
    expect(mixedResult.totals.attempts).toBe(1);
    expect(mixedResult.totals.tokens).toBe(100);
    expect(mixedResult.unknown).toHaveLength(1);
    expect(mixedResult.unknown[0]).toMatchObject({ kind: 'conflict' });
    expect(mixedResult.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('parent-child references prevent double-counting costs', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'parent', {
      'fix/state/report.json': JSON.stringify(
        report([attempt('inv-a', 100, 400), attempt('inv-b', 50, 200)]),
      ),
      'session-index/session-index.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(2);
    expect(result.parents[0]).toMatchObject({ runId: RUN, mirrored: true });
    // The row aggregates the same two attempts; adding it would double the cost.
    expect(result.totals.tokens).toBe(150);
    expect(result.totals.wallMs).toBe(600);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });
});

describe('M10b missing evidence', () => {
  test('a missing bundle, manifest or child artifact is unknown and never zero', async () => {
    const base = await workspace();
    const absent = await readMeasurementInputs({ dirs: [join(base, 'absent')] });
    expect(absent.unknown[0]).toMatchObject({ kind: 'missing' });
    expect(absent.totals.tokens).toBeNull();
    expect(absent.totals.tokens).not.toBe(0);
    expect(absent.totals.availability['/tokens']?.state).toBe('unavailable');

    const dir = await bundle(base, 'missing-child', {});
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      files: unknown[];
      missing: unknown[];
    };
    manifest.files = [
      {
        root: 'fix',
        path: 'state/report.json',
        state: 'missing',
        reason: 'expected file is absent',
      },
    ];
    manifest.missing = manifest.files;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

    const result = await readMeasurementInputs({ dirs: [dir] });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]?.kind).toBe('missing');
    expect(result.unknown[0]?.source).toContain('report.json');
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a manifest without a files array is corrupt, not silently empty', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'no-files', {}, { manifest: { files: undefined } });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a non-object manifest entry is corrupt, not silently dropped', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'entry-not-object', {}, { manifest: { files: ['nope', null] } });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // A files[] element that is not an object is a corrupt manifest, never a
    // silent drop — the manifest lied about its own shape.
    expect(result.unknown).toHaveLength(2);
    for (const entry of result.unknown) expect(entry).toMatchObject({ kind: 'corrupt' });
    expect(result.unknown[0]?.reason).toBe('manifest entry is not an object');
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('an unsupported capture state stays unsupported with its reason', async () => {
    const base = await workspace();
    const dir = await bundle(
      base,
      'state-unsupported',
      {},
      {
        manifest: {
          files: [
            {
              root: 'fix',
              path: 'state/report.json',
              state: 'unsupported',
              reason: 'root unavailable (EPERM)',
            },
          ],
        },
      },
    );

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The capture vocabulary is preserved — missing stays missing,
    // unsupported stays unsupported, anything else is untrusted — and the
    // capture reason rides along in the message instead of being relabelled.
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'unsupported' });
    expect(result.unknown[0]?.reason).toContain('artifact absent');
    expect(result.unknown[0]?.reason).toContain('root unavailable (EPERM)');
  });

  test('a declared session index with no ingested index artifact is unknown', async () => {
    const base = await workspace();
    const dir = await bundle(
      base,
      'declared-index-missing',
      { 'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])) },
      { manifest: { sessionIndex: { state: 'present' } } },
    );

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The manifest declares a captured session index, but no session-index
    // artifact was ingested: that index evidence is missing, never silently
    // absent — the report beside it stays partial, not known.
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'missing' });
    expect(result.unknown[0]?.reason).toContain('sessionIndex');
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('an unparseable session index is one corrupt unknown, not two', async () => {
    const base = await workspace();
    const dir = await bundle(
      base,
      'index-not-json',
      { 'session-index/sessions.json': '{ not json' },
      { manifest: { sessionIndex: { state: 'present' } } },
    );

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The artifact was present and checksum-valid — the capture DID deliver
    // the declared index — so its damage is one corrupt unknown. The
    // declared-index-missing unknown must not fire on top of it.
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.unknown[0]?.reason).toBe('artifact is not JSON');
  });

  test('a legacy report without reportVersion is unsupported, not silent', async () => {
    const base = await workspace();
    const address = await bundle(base, 'legacy-address', {
      'review-journal/w/review-address-report.json': '{"attempts":[{"tokens":5}]}',
    });

    // review.address persists review-address-report.json into its journal
    // (src/ops/review/address.ts) and the bundle capture keeps that basename:
    // a markerless .json at a producer report path is a legacy report — an
    // unsupported unknown that degrades totals, never a silent skip that
    // would leave a too-low known total.
    const addressResult = await readMeasurementInputs({ dirs: [address] });
    expect(addressResult.unknown).toHaveLength(1);
    expect(addressResult.unknown[0]).toMatchObject({ kind: 'unsupported' });
    expect(addressResult.inputs).toEqual([]);
    expect(addressResult.totals.tokens).toBeNull();
    expect(addressResult.totals.availability['/tokens']?.state).toBe('unavailable');

    // runFix persists fix-run-report-<uuid>.json (src/ops/fix/runFix.ts): the
    // same legacy rule, matched by the UUID basename at the capture root.
    const fixRun = await bundle(base, 'legacy-fix-run', {
      'fix-journal/fix-run-report-9f2b7c4d-8e1a-4b3c-9d5e-6a7f8b9c0d1e.json':
        '{"attempts":[{"tokens":5}]}',
    });
    const fixRunResult = await readMeasurementInputs({ dirs: [fixRun] });
    expect(fixRunResult.unknown).toHaveLength(1);
    expect(fixRunResult.unknown[0]).toMatchObject({ kind: 'unsupported' });
    expect(fixRunResult.inputs).toEqual([]);
    expect(fixRunResult.totals.tokens).toBeNull();
    expect(fixRunResult.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a markerless session index under the session-index root is unsupported, not silent', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'legacy-index', {
      'session-index/sessions.json': '{"sessions":[{"runId":"run-1"}]}',
    });

    // The session-index root is where the index producer writes — the archive
    // capture explicitly selects the index artifact there (basename(path) in
    // scripts/archive-measurement-evidence.mjs) — so a .json that parses but
    // omits indexVersion is a legacy or broken index: expected measurement
    // evidence that must not vanish beside valid reports (known totals
    // despite the unusable index) or read an index-only bundle as empty n-a.
    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'unsupported' });
    expect(result.inputs).toEqual([]);
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a markerless .json away from producer paths is non-measurement; a wrong marker stays unknown', async () => {
    const base = await workspace();
    const stray = await bundle(base, 'stray', {
      'worktree/package.json': '{"name":"not-a-report"}',
    });
    const strayResult = await readMeasurementInputs({ dirs: [stray] });

    // No reportVersion, reportV2 or indexVersion, and not at a producer
    // report path: not measurement evidence — skipped silently, never an
    // unknown that would degrade totals.
    expect(strayResult.unknown).toEqual([]);
    expect(strayResult.inputs).toEqual([]);
    expect(strayResult.totals.tokens).toBeNull();
    expect(strayResult.totals.availability['/tokens']?.state).toBe('n-a');

    const wrongVersion = await bundle(base, 'wrong-version', {
      'fix/state/report.json': '{"reportVersion":3,"attempts":[]}',
    });
    const versionResult = await readMeasurementInputs({ dirs: [wrongVersion] });

    // A marker that is present but fails validation is measurement evidence
    // that could not be used: unknown, never a silent skip.
    expect(versionResult.unknown).toHaveLength(1);
    expect(versionResult.unknown[0]).toMatchObject({ kind: 'unsupported' });
    expect(versionResult.totals.tokens).toBeNull();
    expect(versionResult.totals.availability['/tokens']?.state).toBe('unavailable');
  });
});

describe('M10b failure evidence', () => {
  test('corrupt evidence mixed with valid evidence forces partial totals', async () => {
    const base = await workspace();
    const good = await bundle(base, 'good', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const corrupt = await bundle(base, 'corrupt', {
      'fix/state/report.json': '{ not json',
    });

    const result = await readMeasurementInputs({ dirs: [good, corrupt] });

    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
  });

  test('a checksum mismatch mixed with valid evidence forces partial totals', async () => {
    const base = await workspace();
    const good = await bundle(base, 'good', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const mismatch = await bundle(
      base,
      'mismatch',
      { 'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])) },
      { tamper: 'files/fix/state/report.json' },
    );

    const result = await readMeasurementInputs({ dirs: [good, mismatch] });

    expect(result.unknown[0]).toMatchObject({ kind: 'untrusted' });
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('an embedded reportV2 that fails the strict schema is corrupt, not ingested', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'persisted-invalid', {
      'fix/state/fix-run-report-bad.json': JSON.stringify({
        verdict: 'ok',
        reportV2: { ...report([attempt('inv-a', 100, 400)]), attempts: 'nope' },
      }),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toEqual([]);
    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.tokens).not.toBe(0);
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('all-corrupt evidence is unavailable, never n-a', async () => {
    const base = await workspace();
    const corrupt = await bundle(base, 'corrupt', {
      'fix/state/report.json': '{ not json',
    });
    const unsupported = await bundle(
      base,
      'unsupported',
      {
        'fix/state/report.json': JSON.stringify(report([])),
      },
      { manifest: { bundleVersion: 2 } },
    );

    const result = await readMeasurementInputs({ dirs: [corrupt, unsupported] });

    expect(result.unknown).toHaveLength(2);
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.tokens).not.toBe(0);
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
    expect(result.totals.attempts).toBe(0);
    expect(result.totals.availability['/attempts']?.state).toBe('unavailable');
  });

  test('a torn session row forces partial totals even with known values', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'torn-row', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(
        index(100, 400, {
          attempts: 1,
          availability: { '': avail('partial', 'the observation stream is incomplete') },
        }),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('a session row with a partial field subtotal stays partial, never known', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'row-partial-field', {
      'session-index/session-index.json': JSON.stringify(
        index(100, 400, {
          attempts: 1,
          availability: {
            '/tokens': avail('partial', 'some attempts reported a known token count'),
          },
        }),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // buildSessionIndex emits numeric subtotals with field availability
    // 'partial'; the row's own availability governs the aggregate, per field.
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/wallMs']?.state).toBe('known');
  });

  test('a report whose attempts are unavailable forces partial or unavailable totals', async () => {
    const base = await workspace();
    const withRow = await bundle(base, 'address-row', {
      'fix/state/report.json': JSON.stringify(
        report([], {
          availability: {
            '/attempts': avail('unavailable', 'address attempts (T14) have not landed'),
          },
        }),
      ),
      'session-index/session-index.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });
    const rowResult = await readMeasurementInputs({ dirs: [withRow] });
    expect(rowResult.totals.tokens).toBe(150);
    expect(rowResult.totals.availability['/tokens']?.state).toBe('partial');

    const bare = await bundle(base, 'address-bare', {
      'fix/state/report.json': JSON.stringify(
        report([], {
          availability: {
            '/attempts': avail('unavailable', 'address attempts (T14) have not landed'),
          },
        }),
      ),
    });
    const bareResult = await readMeasurementInputs({ dirs: [bare] });
    expect(bareResult.totals.tokens).toBeNull();
    expect(bareResult.totals.tokens).not.toBe(0);
    expect(bareResult.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a measured zero with a non-known availability is partial, never known-zero', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'zero-unknown', {
      'fix/state/report.json': JSON.stringify(
        report([
          attempt('inv-a', 0, 400, {
            availability: { '/tokens': avail('partial', 'provider reported a partial count') },
          }),
        ]),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.totals.tokens).toBe(0);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/tokens']?.state).not.toBe('known-zero');
  });

  test('an attempt payload whose root availability is not known forces partial totals', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'attempt-root', {
      'fix/state/report.json': JSON.stringify(
        report([
          attempt('inv-a', 100, 400, {
            availability: { '': avail('partial', 'the attempt payload is torn') },
          }),
        ]),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The payload's own root entry ('' — valid per AvailabilityMapSchema)
    // marks every field it covers incomplete, exactly as the report root does.
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
    expect(result.totals.availability['/modeledUsd']?.state).toBe('unavailable');
  });

  test('partially observed leaves force a partial total, never known', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'partial-leaves', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(index(900, 1200, { attempts: 3 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.unknown[0]?.kind).toBe('partial');
    expect(result.unknown[0]?.reason).toContain('1 of 3 leaves observed');
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
    expect(result.totals.availability['/attempts']?.state).toBe('partial');
  });

  test('a torn stream behind an index row marks the attempt count partial', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'torn-stream', {
      'session-index/session-index.json': JSON.stringify(
        index(100, 400, {
          attempts: 2,
          availability: { '': avail('partial', 'stream.complete: false') },
        }),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The row's own availability says its stream was torn (the real index
    // producer writes stream completeness there): the costs are partial AND
    // so is the attempt count it states — a known count beside partial costs
    // would contradict the same artifact's record.
    expect(result.unknown).toEqual([]);
    expect(result.parents).toHaveLength(1);
    expect(result.totals.attempts).toBe(2);
    expect(result.totals.availability['/attempts']?.state).toBe('partial');
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
  });

  test('a leaf token sum below the row total forces a partial total', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'short-sum', {
      'fix/state/report.json': JSON.stringify(
        report([attempt('inv-a', 100, 400), attempt('inv-b', 50, 200)]),
      ),
      'session-index/session-index.json': JSON.stringify(index(900, 600, { attempts: 2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown[0]).toMatchObject({ kind: 'partial' });
    expect(result.totals.tokens).toBe(150);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('a leaf wall-time sum below the row total forces a partial total', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'short-wall', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(index(100, 900, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // Leaf count and token sum match the row, but the leaf wall sum does not:
    // the 500 ms shortfall must surface, not vanish beside a `known` total.
    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.unknown[0]).toMatchObject({ kind: 'partial' });
    expect(result.unknown[0]?.reason).toContain('wall');
    expect(result.totals.wallMs).toBe(400);
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
  });

  test('a leaf token sum above the row total forces a partial total', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'token-above-row', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 200, 400)])),
      'session-index/session-index.json': JSON.stringify(index(100, 400, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // Leaf count and wall sum match the row, but the leaf token sum is double
    // the row total: the evidence disagrees, so the run cannot be known — an
    // excess is a partial unknown exactly as a shortfall is.
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'partial' });
    expect(result.unknown[0]?.reason).toContain('exceeds the row total');
    expect(result.totals.tokens).toBe(200);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('a leaf wall-time sum above the row total forces a partial total', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'wall-above-row', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 1000)])),
      'session-index/session-index.json': JSON.stringify(index(100, 400, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'partial' });
    expect(result.unknown[0]?.reason).toContain('exceeds the row total');
    expect(result.totals.wallMs).toBe(1000);
    expect(result.totals.availability['/wallMs']?.state).toBe('partial');
  });

  test('more leaves than the row claims forces a partial total', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'count-above-row', {
      'fix/state/report.json': JSON.stringify(
        report([attempt('inv-a', 100, 400), attempt('inv-b', 100, 400)]),
      ),
      'session-index/session-index.json': JSON.stringify(index(100, 400, { attempts: 1 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // Two observed leaves against a row claiming one attempt: the row does
    // not account for its own run, so nothing about it may read as known.
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'partial' });
    expect(result.unknown[0]?.reason).toContain('exceeds the row total');
    expect(result.totals.tokens).toBe(200);
    expect(result.totals.attempts).toBe(2);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('a mirrored row adds no attempts beyond its observed leaves', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'mirrored-attempts', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // One of the row's two attempts was observed: the parent's stated 2 must
    // not inflate the count beside its own partial unknown.
    expect(result.totals.attempts).toBe(1);
    expect(result.unknown[0]?.kind).toBe('partial');
  });

  test('fully observed leaves stay known', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'full-leaves', {
      'fix/state/report.json': JSON.stringify(
        report([attempt('inv-a', 100, 400), attempt('inv-b', 50, 200)]),
      ),
      'session-index/session-index.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(150);
    expect(result.totals.availability['/tokens']?.state).toBe('known');
  });

  test('a symlinked artifact is untrusted, mixed with valid evidence', async () => {
    const base = await workspace();
    const good = await bundle(base, 'good', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const outside = join(base, 'outside.json');
    await writeFile(outside, JSON.stringify(report([attempt('inv-x', 1, 1)])));
    const linked = await bundle(base, 'linked', {
      'fix/state/report.json': JSON.stringify(report([])),
    });
    await rm(join(linked, 'files/fix/state/report.json'));
    await symlink(outside, join(linked, 'files/fix/state/report.json'));

    const result = await readMeasurementInputs({ dirs: [good, linked] });

    expect(result.unknown[0]).toMatchObject({ kind: 'untrusted' });
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('conflicting leaf copies are all unknown, regardless of order', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'conflict', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-two.json': JSON.stringify(report([attempt('inv-a', 999, 999)])),
      'fix/state/report-three.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The third copy matches the first, but its key is already conflicted:
    // re-admitting it would make the result depend on directory order.
    expect(result.inputs).toEqual([]);
    expect(result.unknown.filter((entry) => entry.kind === 'conflict')).toHaveLength(2);
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.tokens).not.toBe(0);
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('a leaf conflict on any payload field, not only the numbers, is unknown', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'conflict-field', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-two.json': JSON.stringify(
        report([attempt('inv-a', 100, 400, { stopCode: 'crashed' })]),
      ),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toEqual([]);
    expect(result.unknown[0]).toMatchObject({ kind: 'conflict' });
  });

  test('the same invocation under two works is a conflict, never a silent dedup', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'two-works-one-invocation', {
      'fix/state/report-a.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-b.json': JSON.stringify(
        report([attempt('inv-a', 100, 400)], { workId: WORK2 }),
      ),
      'session-index/index-a.json': JSON.stringify(index(100, 400, { attempts: 1 })),
      'session-index/index-b.json': JSON.stringify(index(100, 400, { attempts: 1, workId: WORK2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // One (repo, runId, invocation) identity claimed by two works: neither
    // copy may win silently and drop the other work's evidence while its
    // unmirrored index row re-adds the cost beside a known total. The workId
    // disagreement is a conflict unknown and the total is partial.
    expect(result.inputs).toEqual([]);
    expect(result.unknown.filter((entry) => entry.kind === 'conflict')).toHaveLength(1);
    expect(result.totals.tokens).toBe(200);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
    expect(result.totals.availability['/tokens']?.state).not.toBe('known');
  });

  test('a sibling index row of the same run under another work is a conflict, never an added cost', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'cross-work-row', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/index.json': JSON.stringify(index(50, 200, { attempts: 1, workId: WORK2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // The report's leaves carry one workId (the producer fold takes a single
    // work per report), so a row of the same (repo, runId) under another
    // workId cannot be their mirror: its costs must not be added on top of
    // the leaves'. The disagreement is a conflict unknown and the row adds
    // nothing — not its tokens, and not its attempt count.
    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'conflict' });
    expect(result.totals.tokens).toBe(100);
    expect(result.totals.attempts).toBe(1);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('conflicting parent copies are all unknown, regardless of order', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'parent-conflict', {
      'session-index/a.json': JSON.stringify(index(150, 600, { attempts: 2 })),
      'session-index/b.json': JSON.stringify(index(999, 999, { attempts: 2 })),
      'session-index/c.json': JSON.stringify(index(150, 600, { attempts: 2 })),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.parents).toEqual([]);
    expect(result.unknown.filter((entry) => entry.kind === 'conflict')).toHaveLength(2);
    expect(result.totals.tokens).toBeNull();
    expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
  });

  test('conflicted identities stay excluded in any manifest order', async () => {
    const base = await workspace();
    const copies = {
      'fix/state/a.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/b.json': JSON.stringify(report([attempt('inv-a', 999, 999)])),
      'fix/state/c.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    };
    const forward = await bundle(base, 'forward', copies);
    const reversed = await bundle(base, 'reversed', copies);
    const manifestPath = join(reversed, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: unknown[] };
    manifest.files.reverse();
    await writeFile(manifestPath, JSON.stringify(manifest));

    // The tombstone set is consulted before the prior-lookup in every order,
    // so no third copy is re-admitted and no order changes the result.
    for (const result of [
      await readMeasurementInputs({ dirs: [forward] }),
      await readMeasurementInputs({ dirs: [reversed] }),
    ]) {
      expect(result.inputs).toEqual([]);
      expect(result.unknown.filter((entry) => entry.kind === 'conflict')).toHaveLength(2);
      expect(result.totals.tokens).toBeNull();
      expect(result.totals.tokens).not.toBe(0);
      expect(result.totals.availability['/tokens']?.state).toBe('unavailable');
    }
  });

  test('a row claiming zero attempts beside costs is corrupt, not known-zero', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'zero-attempts-costs', {
      'session-index/session-index.json': JSON.stringify({
        indexVersion: 1,
        sessions: [row(100, 400, { attempts: 0 })],
      }),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    // attempts 0 beside non-null tokens/wallMs contradicts itself: measured
    // work with no attempts to measure it in. Admitting the row would state
    // a known-zero-adjacent count beside measured costs, so it is a corrupt
    // row, exactly like a malformed one.
    expect(result.parents).toEqual([]);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.unknown[0]?.reason).toContain('zero attempts beside costs');
  });

  test('a malformed session row is skipped without dropping later rows', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'torn-index', {
      'session-index/session-index.json': JSON.stringify({
        indexVersion: 1,
        sessions: [
          { ...row(100, 400), tokens: 'many', attempts: 'several' },
          row(50, 200, { runId: 'run-2', workId: WORK2 }),
        ],
      }),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.parents).toHaveLength(1);
    expect(result.parents[0]?.runId).toBe('run-2');
    expect(result.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(result.unknown[0]?.reason).toContain('sessions[0]');
    // The surviving row contributes a value, but the malformed sibling makes
    // the total partial, never known.
    expect(result.totals.tokens).toBe(50);
    expect(result.totals.availability['/tokens']?.state).toBe('partial');
  });

  test('a FIFO swapped in before open is refused without blocking', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'fifo', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const artifact = join(dir, 'files/fix/state/report.json');
    race.onResolvedPath = async (resolved) => {
      if (resolved !== artifact) return;
      race.onResolvedPath = null;
      await rm(artifact);
      execFileSync('mkfifo', [artifact]);
    };

    try {
      const result = await withDeadline(
        readMeasurementInputs({ dirs: [dir] }),
        3000,
        'opening a FIFO artifact blocked',
      );
      expect(result.unknown[0]).toMatchObject({ kind: 'unsupported' });
      expect(result.totals.tokens).toBeNull();
    } finally {
      race.onResolvedPath = null;
    }
  });

  test('a symlink swapped in before open is untrusted (ELOOP), not unavailable', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'eloop', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
    });
    const outside = join(base, 'outside.json');
    await writeFile(outside, JSON.stringify(report([attempt('inv-x', 1, 1)])));
    const artifact = join(dir, 'files/fix/state/report.json');
    race.onResolvedPath = async (resolved) => {
      if (resolved !== artifact) return;
      race.onResolvedPath = null;
      await rm(artifact);
      await symlink(outside, artifact);
    };

    try {
      const result = await withDeadline(
        readMeasurementInputs({ dirs: [dir] }),
        3000,
        'opening a symlinked artifact blocked',
      );
      expect(result.unknown[0]).toMatchObject({ kind: 'untrusted' });
      expect(result.totals.tokens).toBeNull();
    } finally {
      race.onResolvedPath = null;
    }
  });
});
