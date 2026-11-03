// M10b: read offline measurement artifacts. One case per asserted condition:
//   - explicit local directories only (no ambient scan, no network);
//   - dedup by repo/run/invocation identity;
//   - schema version and checksum validation;
//   - corrupt/missing/untrusted child -> unknown bucket, never a fallback zero;
//   - parent-child references prevent double-counting costs.
// Local fixtures only: M8a-shaped bundle directories, no providers, no network.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readMeasurementInputs } from '../scripts/measurement-inputs.mjs';

const REPO = `sha256:${'a'.repeat(64)}`;
const WORK = '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f';
const RUN = 'run-1';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-m10b-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function attempt(invocation: string, tokens: number | null, wallMs: number | null) {
  return {
    type: 'attempt-finished',
    runId: RUN,
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
      stopCode: 'completed',
      class: 'terminal',
      error: null,
      timeout: null,
      budget: {
        allowed: { tokens: null, wallMs: null },
        spent: { tokens, wallMs },
        remaining: { tokens: null, wallMs: null },
      },
      availability: {},
    },
  };
}

function report(attempts: unknown[]) {
  return {
    reportVersion: 2,
    provenance: {
      cqVersion: '0.2.0-dev',
      producerVersion: '0.2.0-dev',
      repoId: REPO,
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
      workId: WORK,
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
    availability: {},
  };
}

function index(tokens: number | null, wallMs: number | null) {
  return {
    indexVersion: 1,
    sessions: [
      {
        repo: REPO,
        sessionId: null,
        workId: WORK,
        parentWorkId: null,
        branch: 'b',
        commitSha: null,
        runId: RUN,
        agentId: null,
        model: { model: 'glm-5.3', provider: 'zai' },
        attempts: 2,
        tokens,
        wallMs,
        stopReasons: [],
        availability: {},
      },
    ],
  };
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
    expect(result.inputs[0]?.runId).toBe(RUN);
    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(100);
  });

  test('validates schema version and checksums before use', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'valid', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'session-index/session-index.json': JSON.stringify(index(100, 400)),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(1);
    expect(result.parents).toEqual([
      { runId: RUN, parentWorkId: null, tokens: 100, wallMs: 400, mirrored: true },
    ]);
    expect(result.unknown).toEqual([]);
  });

  test('accepts the M8a bundle shape, ignoring receipts and stream files', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'm8a', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/observations/work/run.ndjson': '{"type":"composition-started"}\n',
      'git-common-dir/ns/dispatch.jsonl': '{"action":"review"}\n',
      'git-common-dir/ns/bookkeeping.json': '{}\n',
      'session-index/session-index.json': JSON.stringify(index(100, 400)),
    });

    const result = await readMeasurementInputs({ dirs: [dir] });

    expect(result.inputs).toHaveLength(1);
    expect(result.parents[0]?.mirrored).toBe(true);
    expect(result.unknown).toEqual([]);
    expect(result.totals.tokens).toBe(100);
  });

  test('parent-child references prevent double-counting costs', async () => {
    const base = await workspace();
    const dir = await bundle(base, 'parent', {
      'fix/state/report.json': JSON.stringify(
        report([attempt('inv-a', 100, 400), attempt('inv-b', 50, 200)]),
      ),
      'session-index/session-index.json': JSON.stringify(index(150, 600)),
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
    expect(result.totals.availability['/tokens']?.state).toBe('n-a');
  });
});

describe('M10b failure evidence', () => {
  test('corrupt, untrusted, unsupported and conflicting children are unknown, never zero', async () => {
    const base = await workspace();
    const corrupt = await bundle(base, 'corrupt', {
      'fix/state/report.json': '{ not json',
    });
    const corruptResult = await readMeasurementInputs({ dirs: [corrupt] });
    expect(corruptResult.unknown[0]).toMatchObject({ kind: 'corrupt' });
    expect(corruptResult.totals.tokens).toBeNull();

    const mismatch = await bundle(
      base,
      'mismatch',
      { 'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])) },
      { tamper: 'files/fix/state/report.json' },
    );
    const mismatchResult = await readMeasurementInputs({ dirs: [mismatch] });
    expect(mismatchResult.unknown[0]).toMatchObject({ kind: 'untrusted' });
    expect(mismatchResult.totals.tokens).toBeNull();

    const unsupported = await bundle(
      base,
      'unsupported',
      { 'fix/state/report.json': JSON.stringify(report([])) },
      { manifest: { bundleVersion: 2 } },
    );
    const unsupportedResult = await readMeasurementInputs({ dirs: [unsupported] });
    expect(unsupportedResult.unknown[0]).toMatchObject({ kind: 'unsupported' });

    const outside = join(base, 'outside.json');
    await writeFile(outside, JSON.stringify(report([attempt('inv-x', 1, 1)])));
    const linked = await bundle(base, 'linked', {
      'fix/state/report.json': JSON.stringify(report([])),
    });
    await rm(join(linked, 'files/fix/state/report.json'));
    await symlink(outside, join(linked, 'files/fix/state/report.json'));
    const linkedResult = await readMeasurementInputs({ dirs: [linked] });
    expect(linkedResult.unknown[0]).toMatchObject({ kind: 'untrusted' });

    const conflict = await bundle(base, 'conflict', {
      'fix/state/report.json': JSON.stringify(report([attempt('inv-a', 100, 400)])),
      'fix/state/report-two.json': JSON.stringify(report([attempt('inv-a', 999, 999)])),
    });
    const conflictResult = await readMeasurementInputs({ dirs: [conflict] });
    expect(conflictResult.unknown[0]).toMatchObject({ kind: 'conflict' });
    expect(conflictResult.inputs).toEqual([]);
    expect(conflictResult.totals.tokens).toBeNull();
    expect(conflictResult.totals.tokens).not.toBe(0);
  });
});
