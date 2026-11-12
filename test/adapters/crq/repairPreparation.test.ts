/**
 * Operator-only `crq repair-prepare` adapter unit tests.
 *
 * These cover the pre-lock refusals and the lazy canonical-handoff binding
 * without a real repository: config and rollout extraction are pure, and the
 * non-canonical path runs the real gate/executor composition through injected
 * git and scan seams. No production state root is read or written.
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkRepairJobId,
  parseBackfillRollout,
  parseRepairConfig,
  parseRepairPrepareArgv,
  repairPreparationArtifact,
  runRepairPrepare,
  type RepairPreparationSeams,
} from '../../../src/adapters/crq/repairPreparation.js';
import type { RepairPreparationExecutionResult } from '../../../src/ops/crq/internal/repairPrepareExecution.js';
import type {
  RepairGateGit,
  RepairScan,
} from '../../../src/ops/crq/internal/repairPrepareGates.js';

const SOURCE = 'a'.repeat(40);
const BLOB = 'c'.repeat(40);
const CANONICAL = 'f'.repeat(64);
const OLD = 'crq-historical-F1';
const FINDING_SHA256 = '6b4e7b3f540256eada167cf6980e4dad34cfa6d815983d0c7e3a99d09d9a8096';
const PINNED = 'b'.repeat(40);

const OLD_JOB = {
  job: OLD,
  item: 'pr1-merged',
  kind: 'merged',
  pr: 1,
  run: 'old-run',
  cycle: 1,
  repair_base: PINNED,
  branch: null,
  finding: {
    path: 'src/lock.ts',
    line: 2,
    severity: 'major',
    body: 'Finding data',
    id: 'thread-1',
  },
  repair_round: 1,
  prior: null,
  recurrence: false,
  review_diff: '',
  source: { run: 'old-run', id: 'thread-1', thread_id: 'th-1' },
};

const QUEUE = {
  items: [
    {
      id: 'pr1-merged',
      pr: 1,
      kind: 'merged',
      state: 'done',
      repair_runs: {
        'old-run': { jobs: [OLD], base: PINNED, pin: PINNED, state: 'queued' },
      },
    },
  ],
};

const EVIDENCE = {
  source_sha: SOURCE,
  source_blob_sha: BLOB,
  finding_sha256: FINDING_SHA256,
  verdict: 'still-valid',
  reviewer: 'independent-test-reviewer',
  reason: 'Pinned source retains the unstable initialization metadata comparison.',
};

const cleanScan: RepairScan = {
  async scanDiff() {
    return {
      clean: true,
      report: { denylistRules: 0, denylistHits: 0, gitleaks: 'not-run', gitleaksHits: 0 },
    };
  },
};

const fakeGit: RepairGateGit = {
  async currentTip() {
    return SOURCE;
  },
  async blobOid() {
    return BLOB;
  },
  async showFile() {
    return '\nfirst\nsecond\n';
  },
};

const seams: RepairPreparationSeams = {
  git: fakeGit,
  scan: cleanScan,
  withTickLock: async (fn) => fn(),
};

/** One isolated runner root and state root with the historical state on disk. */
async function roots(
  input: {
    canonical?: boolean;
    rollout?: boolean;
    config?: unknown;
  } = {},
): Promise<{ runnerRoot: string; stateRoot: string; argv: string[] }> {
  const base = await mkdtemp(join(tmpdir(), 'crq-repair-prepare-unit-'));
  const runnerRoot = join(base, 'runner');
  const stateRoot = join(base, 'state');
  await mkdir(runnerRoot, { recursive: true });
  await mkdir(join(stateRoot, 'repair', 'inbox'), { recursive: true });
  await writeFile(
    join(runnerRoot, 'config.json'),
    `${JSON.stringify(input.config ?? { clone: '/unused', repair: { max_rounds_per_pin: 2 } }, null, 2)}\n`,
  );
  await writeFile(join(stateRoot, 'queue.json'), `${JSON.stringify(QUEUE, null, 2)}\n`);
  await writeFile(
    join(stateRoot, 'repair', 'inbox', `${OLD}.json`),
    `${JSON.stringify(
      input.canonical === true ? { ...OLD_JOB, canonical_finding_id: CANONICAL } : OLD_JOB,
      null,
      2,
    )}\n`,
  );
  if (input.rollout === true) {
    await writeFile(
      join(stateRoot, 'backfill-rollout.json'),
      `${JSON.stringify({ durable_artifact_root: join(base, 'durable') }, null, 2)}\n`,
    );
  }
  const revalidation = join(base, 'evidence.json');
  await writeFile(revalidation, `${JSON.stringify(EVIDENCE, null, 2)}\n`);
  return {
    runnerRoot,
    stateRoot,
    argv: [
      OLD,
      '--source-sha',
      SOURCE,
      '--revalidation',
      revalidation,
      '--runner-root',
      runnerRoot,
      '--state-root',
      stateRoot,
    ],
  };
}

describe('repair config (config.json)', () => {
  test('defaults max_rounds_per_pin to 2', () => {
    expect(parseRepairConfig('{"clone":"/repo"}')).toEqual({
      ok: true,
      value: { clone: '/repo', maxRoundsPerPin: 2 },
    });
    expect(parseRepairConfig('{"clone":"/repo","repair":{}}')).toEqual({
      ok: true,
      value: { clone: '/repo', maxRoundsPerPin: 2 },
    });
  });

  test('refuses a clone that is absent, empty or not text', () => {
    for (const text of ['{}', '{"clone":""}', '{"clone":"   "}', '{"clone":null}', '{"clone":7}']) {
      expect(parseRepairConfig(text)).toEqual({ ok: false, error: 'clone-missing' });
    }
  });

  test('refuses unreadable text and an invalid round ceiling', () => {
    expect(parseRepairConfig('not json')).toEqual({ ok: false, error: 'config-unreadable' });
    expect(parseRepairConfig('[]')).toEqual({ ok: false, error: 'config-unreadable' });
    for (const value of ['2', null, true, -1, 1.5]) {
      const text = JSON.stringify({ clone: '/repo', repair: { max_rounds_per_pin: value } });
      const result = parseRepairConfig(text);
      if (value === 1.5) {
        expect(result).toEqual({
          ok: true,
          value: { clone: '/repo', maxRoundsPerPin: 1.5 },
        });
      } else {
        expect(result).toEqual({ ok: false, error: 'config-invalid' });
      }
    }
  });
});

describe('backfill rollout reader', () => {
  test('reads a non-empty durable artifact root', () => {
    expect(parseBackfillRollout('{"durable_artifact_root":"/durable"}')).toEqual({
      ok: true,
      durableArtifactRoot: '/durable',
    });
  });

  test('fails closed on absent or malformed configuration', () => {
    for (const text of [
      '{}',
      '{"durable_artifact_root":""}',
      '{"durable_artifact_root":1}',
      '[]',
      'x',
    ]) {
      expect(parseBackfillRollout(text)).toEqual({ ok: false });
    }
  });
});

describe('inbound job id guard', () => {
  test('accepts the Python job-id grammar', () => {
    for (const id of ['crq-historical-F1', 'crq-a', 'crq-a.b_c-1', 'crq-..']) {
      expect(checkRepairJobId(id)).toBe(true);
    }
  });

  test('refuses names outside the grammar or containing a slash', () => {
    for (const id of [
      '',
      'historical-F1',
      'crq-',
      'crq-a/b',
      '../crq-a',
      'crq-a b',
      `crq-${'a'}b\n`,
    ]) {
      expect(checkRepairJobId(id)).toBe(false);
    }
  });

  test('refuses an invalid historical id before any path is joined', async () => {
    const base = await mkdtemp(join(tmpdir(), 'crq-repair-prepare-id-'));
    const result = await runRepairPrepare(
      [
        '../crq-historical-F1',
        '--source-sha',
        SOURCE,
        '--revalidation',
        join(base, 'evidence.json'),
        '--runner-root',
        join(base, 'runner'),
        '--state-root',
        join(base, 'state'),
      ],
      seams,
    );
    expect(result.exitCode).toBe(1);
    expect(result.artifact).toEqual({ status: 'failed', error: 'job-id-invalid' });
    expect(await readdir(base)).toEqual([]);
  });
});

describe('pre-lock config refusal', () => {
  test('a missing clone refuses before the tick lock exists', async () => {
    const { stateRoot, argv } = await roots({ config: { repair: {} } });
    const result = await runRepairPrepare(argv, seams);
    expect(result.exitCode).toBe(1);
    expect(result.artifact).toEqual({ status: 'failed', error: 'clone-missing' });
    expect(await readdir(stateRoot).catch(() => [])).not.toContain('tick.lock');
    expect(await readdir(join(stateRoot, 'repair', 'inbox'))).toEqual([`${OLD}.json`]);
  });
});

describe('lazy canonical-handoff binding', () => {
  test('a canonical job without backfill-rollout.json refuses with zero writes', async () => {
    const { stateRoot, argv } = await roots({ canonical: true });
    const before = await readFile(join(stateRoot, 'queue.json'), 'utf8');
    const result = await runRepairPrepare(argv, seams);
    expect(result.exitCode).toBe(1);
    expect(result.artifact).toMatchObject({
      status: 'failed',
      error: 'refused',
      refusal: 'canonical-handoff-unavailable',
    });
    expect(await readFile(join(stateRoot, 'queue.json'), 'utf8')).toBe(before);
    expect(await readdir(join(stateRoot, 'repair', 'inbox'))).toEqual([`${OLD}.json`]);
  });

  test('a non-canonical job proceeds without any rollout file', async () => {
    const { stateRoot, argv } = await roots();
    const result = await runRepairPrepare(argv, seams);
    expect(result.exitCode).toBe(0);
    expect(result.artifact).toMatchObject({ status: 'ok' });
    const artifact = result.artifact as {
      value: { jobId: string; handoff?: unknown; remainingGates: string[] };
    };
    expect(artifact.value.jobId).toMatch(/^crq-revalidated-[0-9a-f]{24}-F1$/);
    expect(artifact.value.handoff).toBeUndefined();
    expect(artifact.value.remainingGates).toEqual([
      'dispatch-request-construction',
      'enqueue-dispatch',
      'harvest-disposition',
    ]);
    const jobBytes = await readFile(
      join(stateRoot, 'repair', 'inbox', `${artifact.value.jobId}.json`),
      'utf8',
    );
    const job = JSON.parse(jobBytes) as { job: string; canonical_finding_id?: string };
    expect(job.job).toBe(artifact.value.jobId);
    expect(job.canonical_finding_id).toBeUndefined();
    const queue = JSON.parse(await readFile(join(stateRoot, 'queue.json'), 'utf8')) as {
      items: { repair_runs: Record<string, { state: string; jobs: string[] }> }[];
    };
    const runs = queue.items[0]?.repair_runs ?? {};
    const prepared = Object.entries(runs).find(([run]) => run !== 'old-run');
    expect(prepared?.[1]).toMatchObject({ state: 'queued', jobs: [artifact.value.jobId] });
    expect(await readdir(join(stateRoot, 'backfill')).catch(() => [])).toEqual([]);
  });
});

describe('operator argv parsing', () => {
  const full = [
    OLD,
    '--source-sha',
    SOURCE,
    '--revalidation',
    '/tmp/evidence.json',
    '--runner-root',
    '/tmp/runner',
    '--state-root',
    '/tmp/state',
  ];

  test('accepts the exact operator form and the optional instructions file', () => {
    expect(parseRepairPrepareArgv(full)).toEqual({
      ok: true,
      value: {
        jobId: OLD,
        sourceSha: SOURCE,
        revalidationPath: '/tmp/evidence.json',
        runnerRoot: '/tmp/runner',
        stateRoot: '/tmp/state',
      },
    });
    expect(parseRepairPrepareArgv([...full, '--instructions-file', '/tmp/i.txt'])).toMatchObject({
      ok: true,
      value: { instructionsPath: '/tmp/i.txt' },
    });
  });

  test('refuses duplicates, unknown flags, missing values and extra positionals', () => {
    expect(parseRepairPrepareArgv([OLD, ...full.slice(1), '--source-sha', SOURCE])).toEqual({
      ok: false,
      message: 'duplicate flag: --source-sha',
    });
    expect(parseRepairPrepareArgv([OLD, '--bogus', 'x'])).toEqual({
      ok: false,
      message: 'unknown flag: --bogus',
    });
    expect(parseRepairPrepareArgv([OLD, '--source-sha'])).toEqual({
      ok: false,
      message: 'missing value for --source-sha',
    });
    expect(parseRepairPrepareArgv([OLD, 'floating'])).toEqual({
      ok: false,
      message: 'unknown flag: floating',
    });
    expect(parseRepairPrepareArgv([OLD])).toEqual({
      ok: false,
      message: 'missing required flag: --source-sha',
    });
    expect(parseRepairPrepareArgv([])).toEqual({
      ok: false,
      message: 'missing historical job id',
    });
  });
});

describe('executor result mapping', () => {
  const callerGates = [
    'dispatch-request-construction',
    'enqueue-dispatch',
    'harvest-disposition',
  ] as const;

  test('a completed preparation is ok with the remaining caller gates', () => {
    const result = {
      ok: true,
      value: {
        status: 'preparation-executed',
        idempotent: false,
        jobId: 'crq-revalidated-0123456789abcdef01234567-F1',
        run: 'revalidated-0123456789abcdef01234567',
        effects: [],
        remainingGates: callerGates,
      },
    } satisfies RepairPreparationExecutionResult;
    expect(repairPreparationArtifact(result, undefined)).toMatchObject({
      exitCode: 0,
      artifact: {
        status: 'ok',
        value: { remainingGates: [...callerGates] },
      },
    });
  });

  test('a busy lock maps to exit 3 and an unsupported lock to exit 1', () => {
    const busy = {
      ok: false,
      kind: 'lock-unavailable',
      readGates: 'not-attempted',
      steps: [],
      remainingGates: callerGates,
      recovery: 're-run-preparation',
    } satisfies RepairPreparationExecutionResult;
    expect(repairPreparationArtifact(busy, 'busy')).toEqual({
      artifact: { status: 'failed', error: 'tick lock busy' },
      exitCode: 3,
    });
    expect(repairPreparationArtifact(busy, 'unsupported')).toEqual({
      artifact: { status: 'failed', error: 'lock-unsupported' },
      exitCode: 1,
    });
    expect(repairPreparationArtifact(busy, undefined)).toEqual({
      artifact: { status: 'failed', error: 'lock-unavailable' },
      exitCode: 1,
    });
  });

  test('an unconfirmed effect is indeterminate and a refusal stays failed', () => {
    const unconfirmed = {
      ok: false,
      kind: 'effect-failed',
      step: 'write-queue',
      steps: [{ step: 'write-queue', outcome: 'unconfirmed' }],
      effects: [],
      readGates: 'attempted-under-tick-lock',
      remainingGates: callerGates,
      recovery: 're-run-preparation',
    } satisfies RepairPreparationExecutionResult;
    expect(repairPreparationArtifact(unconfirmed, undefined)).toMatchObject({
      exitCode: 1,
      artifact: { status: 'indeterminate', detail: 'effect-failed', step: 'write-queue' },
    });

    const refused = {
      ok: false,
      kind: 'refused',
      refusal: 'round-ceiling',
      readGates: 'attempted-under-tick-lock',
      effects: [],
      remainingGates: callerGates,
    } satisfies RepairPreparationExecutionResult;
    expect(repairPreparationArtifact(refused, undefined)).toEqual({
      artifact: { status: 'failed', error: 'refused', refusal: 'round-ceiling' },
      exitCode: 1,
    });
  });
});
