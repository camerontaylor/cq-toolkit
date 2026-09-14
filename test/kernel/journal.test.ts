// T1.2 slice 1 — tests for the run manifest (src/kernel/manifest.ts) and the
// NDJSON run journal (src/kernel/journal.ts).
//
// Pinned here:
//   1. Manifest: canonicalJson key-order independence (and array-order
//      significance), hashInputs stability, makeManifest shape + dependsOn
//      normalization + no aliasing into the plan, JSON serializability,
//      topoOrder waves / cycle / unknown-dep / duplicate-id rejection.
//   2. Journal: append+read round-trip (every line parses through
//      JournalEventSchema), append creates the directory recursively, a torn
//      LAST line (no trailing newline) tolerated while a complete but
//      invalid line anywhere — including last — throws, statusOf
//      derivation rules (including the documented needs-human/indeterminate
//      friction with the frozen JobState taxonomy), runs() mtime ordering,
//      loud rejection of invalid events and unsafe runIds.
//
// Determinism: fixed ISO timestamps in events; runs() ordering is forced
// with explicit utimes() calls (filesystem mtime resolution can tie). No
// Date.now(), no Math.random(). Temp dirs: mkdtemp under os.tmpdir, removed
// in afterEach.
import { appendFile, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertSafeRunId,
  candidateRunsForPlan,
  deriveJobStatuses,
  openRunLog,
} from '../../src/kernel/journal.js';
import {
  canonicalJson,
  hashInputs,
  makeManifest,
  topoOrder,
} from '../../src/kernel/manifest.js';
import type { RunManifest } from '../../src/kernel/manifest.js';
import { JournalEventSchema } from '../../src/kernel/schema.js';
import type {
  JobFinishedJournalEvent,
  JobStartedJournalEvent,
  JournalEvent,
  OpResult,
  Plan,
  RunFinishedJournalEvent,
  RunStartedJournalEvent,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Event builders — fixed timestamps, no clocks
// ---------------------------------------------------------------------------

const AT = '2026-01-01T00:00:00.000Z';

function runStarted(runId: string, planId = 'plan-x'): RunStartedJournalEvent {
  return { type: 'run-started', runId, at: AT, planId };
}

function jobStarted(runId: string, jobId: string, attempt = 1): JobStartedJournalEvent {
  return { type: 'job-started', runId, at: AT, jobId, op: `op-${jobId}`, attempt };
}

function jobFinished(
  runId: string,
  jobId: string,
  result: OpResult<unknown>,
): JobFinishedJournalEvent {
  return {
    type: 'job-finished',
    runId,
    at: AT,
    jobId,
    opId: `op-${jobId}`,
    inputsHash: `hash-${jobId}`,
    result,
  };
}

function runFinished(runId: string, stoppedEarly = false): RunFinishedJournalEvent {
  const event: RunFinishedJournalEvent = { type: 'run-finished', runId, at: AT, stoppedEarly };
  if (stoppedEarly) event.earlyStopReason = 'budget';
  return event;
}

// ---------------------------------------------------------------------------
// Run manifest: canonicalJson / hashInputs / makeManifest / topoOrder
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  test('sorts object keys in code-unit order', () => {
    expect(canonicalJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });

  test('key order in nested objects does not change the output', () => {
    const one = canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } });
    const two = canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 });
    expect(one).toBe(two);
  });

  test('array order is significant (arrays are ordered data)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test('sparse array slots canonicalize as null — a hole never hashes like []', () => {
    // value.map skipped holes, so `new Array(1)` hashed like `[]`. Index-based
    // canonicalization reads a hole as undefined → the documented `null`.
    expect(canonicalJson(new Array(1))).toBe('[null]');
    const sparse = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(canonicalJson(sparse)).toBe('[1,null,3]');
    expect(hashInputs('op-x', new Array(1))).not.toBe(hashInputs('op-x', []));
  });

  test('scalars, null, and explicit-undefined values have stable forms', () => {
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('hashInputs', () => {
  test('is a sha256 hex digest', () => {
    expect(hashInputs('op-x', { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same op+input → same hash, regardless of input key order', () => {
    const h = hashInputs('op-x', { a: 1, b: { c: [1, 2] } });
    expect(hashInputs('op-x', { b: { c: [1, 2] }, a: 1 })).toBe(h);
  });

  test('different op → different hash', () => {
    expect(hashInputs('op-y', { a: 1 })).not.toBe(hashInputs('op-x', { a: 1 }));
  });

  test('different input → different hash', () => {
    expect(hashInputs('op-x', { a: 2 })).not.toBe(hashInputs('op-x', { a: 1 }));
  });

  test('array order changes the hash (ordered data)', () => {
    expect(hashInputs('op-x', [1, 2])).not.toBe(hashInputs('op-x', [2, 1]));
  });
});

/** Diamond plan, jobs deliberately out of dependency order. */
function diamondPlan(): Plan {
  return {
    id: 'plan-diamond',
    label: 'a throwaway label that must not leak into the manifest',
    jobs: [
      { id: 'd', op: 'op-d', input: { n: 3 }, dependsOn: ['b', 'c'] },
      { id: 'a', op: 'op-a', input: { n: 1 } },
      { id: 'c', op: 'op-c', input: { n: 2 }, dependsOn: ['a'] },
      { id: 'b', op: 'op-b', input: { n: 2 }, dependsOn: ['a'] },
    ],
  };
}

describe('makeManifest', () => {
  test('preserves planId, job order, and computes inputsHash per job', () => {
    const manifest = makeManifest(diamondPlan());
    expect(manifest.planId).toBe('plan-diamond');
    expect(manifest.jobs.map((job) => job.id)).toEqual(['d', 'a', 'c', 'b']);
    for (const job of manifest.jobs) {
      expect(job.inputsHash).toBe(hashInputs(job.op, job.input));
    }
  });

  test('normalizes dependsOn to [] when absent and never aliases plan arrays', () => {
    const plan = diamondPlan();
    const manifest = makeManifest(plan);
    expect(manifest.jobs.find((job) => job.id === 'a')?.dependsOn).toEqual([]);

    // Mutating the manifest must not reach back into the plan...
    manifest.jobs.find((job) => job.id === 'd')?.dependsOn.push('zzz');
    expect(plan.jobs.find((job) => job.id === 'd')?.dependsOn).toEqual(['b', 'c']);
    // ...and mutating a normalized entry must not invent plan fields.
    manifest.jobs.find((job) => job.id === 'a')?.dependsOn.push('zzz');
    expect(plan.jobs.find((job) => job.id === 'a')?.dependsOn).toBeUndefined();
  });

  test('deep-copies job input at commit: mutating the plan afterwards changes neither manifest nor hash', () => {
    const plan = diamondPlan();
    const manifest = makeManifest(plan);
    const hashBefore = manifest.jobs[0]?.inputsHash;

    // Mutate the plan-owned input object AFTER the commit.
    const planInput = plan.jobs[0]?.input as { n: number };
    planInput.n = 999;

    expect((manifest.jobs[0]?.input as { n: number }).n).toBe(3); // snapshot untouched
    expect(manifest.jobs[0]?.inputsHash).toBe(hashBefore); // committed hash is the hash of the committed input
  });

  test('carries only {planId, jobs} — the plan label is not load-bearing', () => {
    const manifest: RunManifest = makeManifest(diamondPlan());
    expect(Object.keys(manifest)).toEqual(['planId', 'jobs']);
  });

  test('is plain serializable data: JSON round-trip deep-equals', () => {
    const manifest = makeManifest(diamondPlan());
    const roundTripped = JSON.parse(JSON.stringify(manifest)) as RunManifest;
    expect(roundTripped).toEqual(manifest);
  });

  test('manifest jobs satisfy topoOrder directly (diamond waves)', () => {
    // Input order is preserved within a wave; the diamond plan lists c before
    // b, so the second wave is ['c', 'b'] (see the topoOrder describe block
    // for the ['b', 'c'] spelling with b-before-c input order).
    expect(topoOrder(makeManifest(diamondPlan()).jobs)).toEqual([['a'], ['c', 'b'], ['d']]);
  });
});

describe('topoOrder', () => {
  test('diamond dependency graph yields waves, input order preserved within a wave', () => {
    const jobs = [
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ];
    expect(topoOrder(jobs)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  test('no dependsOn → single wave in input order', () => {
    expect(topoOrder([{ id: 'x' }, { id: 'y' }])).toEqual([['x', 'y']]);
  });

  test('empty input → no waves', () => {
    expect(topoOrder([])).toEqual([]);
  });

  test('throws on a cycle (mutual and self-dependency)', () => {
    expect(() =>
      topoOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]),
    ).toThrow(/cycle/);
    expect(() => topoOrder([{ id: 's', dependsOn: ['s'] }])).toThrow(/cycle/);
  });

  test('throws on an unknown dependency', () => {
    expect(() => topoOrder([{ id: 'a', dependsOn: ['ghost'] }])).toThrow(
      /unknown job 'ghost'/,
    );
  });

  test('throws on duplicate job ids', () => {
    expect(() => topoOrder([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/);
  });
});

// ---------------------------------------------------------------------------
// Run journal: openRunLog (append / read / runs / statusOf)
// ---------------------------------------------------------------------------

describe('openRunLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-journal-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const pathFor = (runId: string): string => join(dir, `${runId}.ndjson`);

  test('append + read round-trips events, every line parses through JournalEventSchema', async () => {
    const log = openRunLog(dir);
    const events: JournalEvent[] = [
      runStarted('run-rt'),
      jobStarted('run-rt', 'a'),
      { ...jobFinished('run-rt', 'a', { status: 'ok', value: { answer: 42 } }), usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 0 } },
      runFinished('run-rt'),
    ];
    for (const event of events) {
      await log.append('run-rt', event);
    }

    const read = await log.read('run-rt');
    expect(read).toEqual(events);

    // Every physical line is a valid journal event per the frozen schema.
    const raw = await readFile(pathFor('run-rt'), 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(events.length);
    lines.forEach((line, i) => {
      expect(JournalEventSchema.parse(JSON.parse(line))).toEqual(events[i]);
    });
  });

  test('append creates the journal directory recursively', async () => {
    const nested = join(dir, 'runs', 'nested');
    const log = openRunLog(nested);
    await log.append('run-nested', runStarted('run-nested', 'plan-nested'));
    await expect(log.read('run-nested')).resolves.toEqual([
      runStarted('run-nested', 'plan-nested'),
    ]);
  });

  test('read ignores a torn LAST line (crash mid-append)', async () => {
    const log = openRunLog(dir);
    await log.append('run-torn', runStarted('run-torn'));
    await log.append('run-torn', jobStarted('run-torn', 'a'));
    // Simulate a crash mid-write: a partial line with no trailing newline.
    await appendFile(
      pathFor('run-torn'),
      '{"type":"job-started","runId":"run-torn","at":"2026-0',
      'utf8',
    );
    await expect(log.read('run-torn')).resolves.toEqual([
      runStarted('run-torn'),
      jobStarted('run-torn', 'a'),
    ]);
  });

  test('read throws on a corrupt MIDDLE line (unparsable JSON)', async () => {
    const log = openRunLog(dir);
    // A torn line that later got a newline (then a good event) is now MIDDLE
    // evidence with a hole in it — that is corruption, not a torn tail.
    await appendFile(pathFor('run-bad'), '{"type":"job-started","runI\n', 'utf8');
    await log.append('run-bad', runStarted('run-bad'));
    await expect(log.read('run-bad')).rejects.toThrow(/corrupt line 1/);
  });

  test('read throws on a schema-invalid MIDDLE line (valid JSON, invalid event)', async () => {
    const log = openRunLog(dir);
    await appendFile(pathFor('run-schema'), '{}\n', 'utf8');
    await log.append('run-schema', runStarted('run-schema'));
    await expect(log.read('run-schema')).rejects.toThrow(/corrupt line 1/);
  });

  test('read drops trailing blank lines (byte-less whitespace, not a torn event)', async () => {
    const log = openRunLog(dir);
    await log.append('run-blank', runStarted('run-blank'));
    // `echo '' >>` appends a bare newline: complete lines, no event bytes.
    // This heals on read instead of permanently bricking the journal.
    await appendFile(pathFor('run-blank'), '\n\n', 'utf8');
    await expect(log.read('run-blank')).resolves.toEqual([runStarted('run-blank')]);

    // Whitespace-only trailing content is the same story.
    await appendFile(pathFor('run-blank'), '   \n', 'utf8');
    await expect(log.read('run-blank')).resolves.toEqual([runStarted('run-blank')]);
  });

  test('read still throws on a blank MIDDLE line (a hole in the evidence)', async () => {
    const log = openRunLog(dir);
    await log.append('run-mid-blank', runStarted('run-mid-blank'));
    // A blank line BETWEEN events is a structural hole, not trailing noise.
    await log.append('run-mid-blank', runFinished('run-mid-blank'));
    const raw = await readFile(pathFor('run-mid-blank'), 'utf8');
    const withHole = raw.replace('\n', '\n\n'); // blank line after line 1
    await rm(pathFor('run-mid-blank'));
    await appendFile(pathFor('run-mid-blank'), withHole, 'utf8');
    await expect(log.read('run-mid-blank')).rejects.toThrow(/corrupt line 2/);
  });

  test('read throws when a line carries another runId than the file records', async () => {
    const log = openRunLog(dir);
    // System-written files always match (append enforces it); a mismatched
    // line means operator-concatenated journals — misattributed evidence.
    const foreign = runStarted('run-other');
    await appendFile(pathFor('run-mine'), `${JSON.stringify(foreign)}\n`, 'utf8');
    await expect(log.read('run-mine')).rejects.toThrow(
      /event\.runId 'run-other' does not match this file's run 'run-mine'/,
    );
  });

  test('candidateRunsForPlan: sibling-plan ids cannot slip past the two-segment tail', () => {
    // plan 'a' must not match plan 'a--b''s files ('b--k3y--c0ffee' is three
    // tail segments); case-insensitive so operator-copied evidence ('A3F2')
    // still parses; non-conforming tails are skipped (re-run direction only).
    expect(
      candidateRunsForPlan(
        ['a--ts--beef', 'a--b--k3y--c0ffee', 'a--r7--A3F2', 'ab--ts--beef', 'a--ts'],
        'a',
      ),
    ).toEqual(['a--ts--beef', 'a--r7--A3F2']);
  });

  test('read throws when the last COMPLETE line is invalid (file ends with a newline)', async () => {
    const log = openRunLog(dir);
    await log.append('run-complete', runStarted('run-complete'));
    // A fully-written but schema-invalid line: with the trailing newline this
    // is a COMPLETE record, not a torn write — tolerance must not hide it.
    await appendFile(pathFor('run-complete'), '{}\n', 'utf8');
    await expect(log.read('run-complete')).rejects.toThrow(/corrupt line 2/);
  });

  test('read throws when the last complete line is pure JSON garbage (file ends with a newline)', async () => {
    const log = openRunLog(dir);
    await log.append('run-garbage', runStarted('run-garbage'));
    // Same rule for non-JSON garbage: trailing newline ⇒ complete line ⇒ loud.
    await appendFile(pathFor('run-garbage'), 'not json at all\n', 'utf8');
    await expect(log.read('run-garbage')).rejects.toThrow(/corrupt line 2/);
  });

  test('read of an unknown run yields [] (no facts yet)', async () => {
    const log = openRunLog(dir);
    await expect(log.read('run-absent')).resolves.toEqual([]);
  });

  test('statusOf derives states from the event fold', async () => {
    const log = openRunLog(dir);
    const events: JournalEvent[] = [
      runStarted('run-st'),
      jobStarted('run-st', 'a'),
      jobStarted('run-st', 'b'),
      jobFinished('run-st', 'b', { status: 'ok', value: 1 }),
      jobStarted('run-st', 'c'),
      jobFinished('run-st', 'c', { status: 'failed', error: 'boom' }),
      jobStarted('run-st', 'e'),
      jobFinished('run-st', 'e', { status: 'budget-exhausted' }),
      jobStarted('run-st', 'f'),
      // Frozen-type friction (documented in journal.ts): JobState has no
      // needs-human value, so the job keeps its last derived state.
      jobFinished('run-st', 'f', { status: 'needs-human', reason: 'missing credential' }),
      jobStarted('run-st', 'g'),
      jobFinished('run-st', 'g', { status: 'indeterminate', detail: 'worker lost' }),
      // job 'h' is never started — it must not appear in the derived status.
    ];
    for (const event of events) {
      await log.append('run-st', event);
    }

    await expect(log.statusOf('run-st')).resolves.toEqual([
      { jobId: 'a', state: 'running' },
      { jobId: 'b', state: 'done' },
      { jobId: 'c', state: 'failed' },
      { jobId: 'e', state: 'budget-exhausted' },
      { jobId: 'f', state: 'running' }, // needs-human: last known state, re-dispatch on resume
      { jobId: 'g', state: 'running' }, // indeterminate: last known state, re-dispatch on resume
    ]);
  });

  test('statusOf: a retry after a finish puts the job back to running', async () => {
    const log = openRunLog(dir);
    for (const event of [
      jobStarted('run-retry', 'a', 1),
      jobFinished('run-retry', 'a', { status: 'failed', error: 'transient' }),
      jobStarted('run-retry', 'a', 2),
    ] as JournalEvent[]) {
      await log.append('run-retry', event);
    }
    await expect(log.statusOf('run-retry')).resolves.toEqual([
      { jobId: 'a', state: 'running' },
    ]);
  });

  test('statusOf of an unknown run yields [] (deriveJobStatuses of no facts)', async () => {
    const log = openRunLog(dir);
    await expect(log.statusOf('run-absent')).resolves.toEqual([]);
    expect(deriveJobStatuses([])).toEqual([]);
  });

  test('runs() lists runIds oldest-mtime first, ties broken by id', async () => {
    const log = openRunLog(dir);
    await log.append('run-old', runStarted('run-old'));
    await log.append('run-new', runStarted('run-new'));
    // Force deterministic mtimes (real mtime resolution can tie).
    const at = (ms: number): Date => new Date(ms);
    await utimes(pathFor('run-old'), at(1000), at(1000));
    await utimes(pathFor('run-new'), at(2000), at(2000));
    await expect(log.runs()).resolves.toEqual(['run-old', 'run-new']);

    await utimes(pathFor('run-old'), at(3000), at(3000));
    await expect(log.runs()).resolves.toEqual(['run-new', 'run-old']);

    // Equal mtimes: deterministic tie-break by id.
    await utimes(pathFor('run-old'), at(2000), at(2000));
    await expect(log.runs()).resolves.toEqual(['run-new', 'run-old']);
  });

  test('runs() of an empty directory yields []', async () => {
    const log = openRunLog(join(dir, 'fresh'));
    await expect(log.runs()).resolves.toEqual([]);
  });

  test('invalid events fail loudly before anything is written', async () => {
    const log = openRunLog(dir);
    // Bogus discriminant.
    await expect(
      log.append('run-v', { type: 'teleported' } as unknown as JournalEvent),
    ).rejects.toThrow();
    // Extra key on a strict event shape.
    await expect(
      log.append('run-v', { ...runStarted('run-v'), extra: true } as unknown as JournalEvent),
    ).rejects.toThrow();
    // Event's own runId does not match the target run.
    await expect(log.append('run-v', runStarted('run-other'))).rejects.toThrow(
      /does not match/,
    );
    // None of the failed appends left evidence behind.
    await expect(log.read('run-v')).resolves.toEqual([]);
  });

  test('runIds must be filesystem-safe (the file is <runId>.ndjson)', async () => {
    expect(() => assertSafeRunId('run-OK.01_a')).not.toThrow();
    expect(() => assertSafeRunId('')).toThrow();
    expect(() => assertSafeRunId('../escape')).toThrow();
    expect(() => assertSafeRunId('a/b')).toThrow();
    expect(() => assertSafeRunId('a\\b')).toThrow();
    expect(() => assertSafeRunId('.')).toThrow();
    expect(() => assertSafeRunId('..')).toThrow();

    const log = openRunLog(dir);
    await expect(log.append('a/b', runStarted('a/b'))).rejects.toThrow();
    await expect(log.read('../escape')).rejects.toThrow();
  });
});
