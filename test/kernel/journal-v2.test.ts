// Journal v2 (W2.2, ADR-0003 annex) — the additions the governed runner
// writes and the fold rules the resume path reads.
//
// Pinned here:
//   1. Schema: a v2 run-started (journalVersion/seq/governance/ungoverned)
//      parses; every addition is OPTIONAL so v1 records still parse; the
//      strict mirrors reject unknown keys (an old reader fails closed on
//      journalVersion, annex §4); job-finished gains optional costUSD.
//   2. Durable append: { durable: true } writes the line and the promise
//      settles only after the bytes are on disk (read-back equality); the
//      directory is fsync'd on first write to a run file (best-effort, so
//      not directly observable — the observable contract is the read-back).
//   3. claimSeq: sequential claims from a fresh dir yield 1, 2, 3…; a
//      pre-existing tombstone is skipped (EEXIST → n+1); non-integer or
//      non-positive startAt throws.
//   4. foldOrderRuns: v1 runs order by (at, runId) and ALL precede v2 runs;
//      v2 runs order by seq regardless of `at` (the fake-clock reversal
//      proof, annex §5); a v2 run without seq throws; duplicate seq across
//      two v2 runs throws.
//
// Determinism: fixed ISO timestamps, no Date.now()/Math.random(); temp dirs
// under os.tmpdir removed in afterEach (same idiom as journal.test.ts).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertNoSeqGap,
  claimSeq,
  foldOrderRuns,
  openRunLog,
  type FoldRun,
} from '../../src/kernel/journal.js';
import { JournalEventSchema } from '../../src/kernel/schema.js';
import type { JournalEvent, RunStartedJournalEvent } from '../../src/kernel/types.js';

const AT_A = '2026-01-01T00:00:00.000Z';
const AT_B = '2026-01-02T00:00:00.000Z';

function runStarted(
  overrides: Partial<RunStartedJournalEvent> & { runId: string },
): RunStartedJournalEvent {
  return {
    type: 'run-started',
    at: AT_A,
    planId: 'plan-x',
    ...overrides,
  };
}

describe('journal v2 schema', () => {
  test('a v2 run-started with governance parses; every field stays optional', () => {
    const v2: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: {
        capUsd: 5,
        capTokens: 1000,
        attended: false,
        legacyJournal: { mode: 'reset', v1RunIds: ['plan-x--old--a'] },
        raiseCap: { from: 5, to: 10 },
      },
    });
    expect(JournalEventSchema.parse(v2)).toEqual(v2);
  });

  test('a v1-shaped run-started (no v2 fields) still parses', () => {
    const v1: JournalEvent = runStarted({ runId: 'plan-x--k--a' });
    expect(JournalEventSchema.parse(v1)).toEqual(v1);
  });

  test('ungoverned marker parses; unknown keys are rejected (strict)', () => {
    const ungoverned: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 2,
      ungoverned: { optIn: true },
    });
    expect(JournalEventSchema.parse(ungoverned)).toEqual(ungoverned);
    const extra = { ...runStarted({ runId: 'plan-x--k--a' }), vendor: true };
    expect(JournalEventSchema.safeParse(extra).success).toBe(false);
  });

  test('v2 markers are v2-only and mutually exclusive: governance/ungoverned/seq without journalVersion, or both markers, is corruption', () => {
    // No writer emits these shapes: folding a governance-bearing line as v1
    // would silently downgrade the governed-history refusals (the fold sees
    // no governed run) instead of failing loud like every other shape
    // violation, and a both-markers line would sit inside AND outside the
    // ledger at once (cap provenance from one, spend excluded by the other).
    const withoutVersion = (marker: 'governance' | 'ungoverned' | 'seq'): JournalEvent =>
      runStarted({
        runId: 'plan-x--k--a',
        ...(marker === 'governance' ? { governance: { attended: false } } : {}),
        ...(marker === 'ungoverned' ? { ungoverned: { optIn: true } } : {}),
        ...(marker === 'seq' ? { seq: 1 } : {}),
      }) as JournalEvent;
    expect(JournalEventSchema.safeParse(withoutVersion('governance')).success).toBe(false);
    expect(JournalEventSchema.safeParse(withoutVersion('ungoverned')).success).toBe(false);
    expect(JournalEventSchema.safeParse(withoutVersion('seq')).success).toBe(false);
    const both: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
      ungoverned: { optIn: true },
    });
    expect(JournalEventSchema.safeParse(both).success).toBe(false);
    // …and a v2 record with NEITHER marker is ledger-invisible history: the
    // fold would count its seq but add it to neither governedRunIds nor
    // ungovernedRunIds, so later plain runs would never be refused over its
    // dispatches. Exactly one marker is required.
    const markerless: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
    });
    expect(JournalEventSchema.safeParse(markerless).success).toBe(false);
  });

  test('job-finished costUSD parses and stays optional; negative capUsd is malformed', () => {
    const finished: JournalEvent = {
      type: 'job-finished',
      runId: 'plan-x--k--a',
      at: AT_A,
      jobId: 'j1',
      opId: 'op-j1',
      inputsHash: 'h',
      result: { status: 'ok', value: 1 },
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.25,
    };
    expect(JournalEventSchema.parse(finished)).toEqual(finished);
    const badGovernance: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: -1, attended: false },
    });
    expect(JournalEventSchema.safeParse(badGovernance).success).toBe(false);
    const validGovernance: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: 1, attended: false },
    });
    expect(JournalEventSchema.parse(validGovernance)).toEqual(validGovernance);
  });

  test('allowAdvisoryProvenance parses only ALONGSIDE allowAdvisory (r1 M4)', () => {
    const operator: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false, allowAdvisory: true, allowAdvisoryProvenance: 'operator' },
    });
    expect(JournalEventSchema.parse(operator)).toEqual(operator);
    const product: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false, allowAdvisory: true, allowAdvisoryProvenance: 'product' },
    });
    expect(JournalEventSchema.parse(product)).toEqual(product);
    // Provenance without the escape is meaningless — corruption, not a fact.
    const orphan: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      governance: { attended: false, allowAdvisoryProvenance: 'operator' },
    });
    expect(JournalEventSchema.safeParse(orphan).success).toBe(false);
    // The enum is closed.
    const bogus: JournalEvent = runStarted({
      runId: 'plan-x--k--a',
      governance: {
        attended: false,
        allowAdvisory: true,
        allowAdvisoryProvenance: 'nobody' as 'operator',
      },
    });
    expect(JournalEventSchema.safeParse(bogus).success).toBe(false);
  });
});

describe('reservation-era journal events (W2.3)', () => {
  const OPENED: JournalEvent = {
    type: 'reservation-opened',
    runId: 'plan-x--k--a',
    at: AT_A,
    jobId: 'j1',
    op: 'op-j1',
    attempt: 1,
    reservationId: 'plan-x--k--a:j1:1:1',
    usd: 0.5,
    class: 'advisory',
  };

  test('reservation-opened parses; negative usd, unknown keys, and a hard class are shape-checked', () => {
    expect(JournalEventSchema.parse(OPENED)).toEqual(OPENED);
    const withProposal: JournalEvent = { ...OPENED, proposedUsd: 1 };
    expect(JournalEventSchema.parse(withProposal)).toEqual(withProposal);
    expect(JournalEventSchema.safeParse({ ...OPENED, usd: -1 }).success).toBe(false);
    expect(JournalEventSchema.safeParse({ ...OPENED, vendor: true }).success).toBe(false);
  });

  test('reservation-settled parses; charged is required, negative charged is malformed', () => {
    const settled: JournalEvent = {
      type: 'reservation-settled',
      runId: 'plan-x--k--a',
      at: AT_B,
      jobId: 'j1',
      reservationId: 'plan-x--k--a:j1:1:1',
      charged: 0.25,
      basis: 'observed',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    };
    expect(JournalEventSchema.parse(settled)).toEqual(settled);
    const full: JournalEvent = {
      type: 'reservation-settled',
      runId: 'plan-x--k--a',
      at: AT_B,
      jobId: 'j1',
      reservationId: 'plan-x--k--a:j1:1:1',
      charged: 0.5,
      basis: 'full',
    };
    expect(JournalEventSchema.parse(full)).toEqual(full);
    expect(JournalEventSchema.safeParse({ ...settled, charged: -0.5 }).success).toBe(false);
    const noCharged = { ...settled } as Record<string, unknown>;
    delete noCharged['charged'];
    expect(JournalEventSchema.safeParse(noCharged).success).toBe(false);
    // PRICE PRESENCE (r1 H2): a zero-priced lane's `priced: true` parses;
    // the field is boolean-typed.
    expect(JournalEventSchema.safeParse({ ...settled, charged: 0, priced: true }).success).toBe(
      true,
    );
    expect(JournalEventSchema.safeParse({ ...settled, priced: 'yes' }).success).toBe(false);
  });

  test('reservation-refused parses; the reason enum is closed', () => {
    const refused: JournalEvent = {
      type: 'reservation-refused',
      runId: 'plan-x--k--a',
      at: AT_A,
      jobId: 'j1',
      op: 'op-j1',
      reason: 'advisory-lane',
    };
    expect(JournalEventSchema.parse(refused)).toEqual(refused);
    expect(JournalEventSchema.safeParse({ ...refused, reason: 'vibes' }).success).toBe(false);
  });

  test('job-quarantined and quarantine-released parse; provenance is closed to call', () => {
    const quarantined: JournalEvent = {
      type: 'job-quarantined',
      runId: 'plan-x--k--b',
      at: AT_B,
      jobId: 'j1',
      reservationId: 'plan-x--k--a:j1:1:1',
      chargedUsd: 0.5,
      reason: 'unresolved-reservation',
    };
    expect(JournalEventSchema.parse(quarantined)).toEqual(quarantined);
    const released: JournalEvent = {
      type: 'quarantine-released',
      runId: 'plan-x--k--b',
      at: AT_B,
      jobId: 'j1',
      provenance: 'call',
    };
    expect(JournalEventSchema.parse(released)).toEqual(released);
    expect(JournalEventSchema.safeParse({ ...released, provenance: 'env' }).success).toBe(false);
  });

  test('job-finished charged parses and stays optional (the reservation-side rollup)', () => {
    const finished: JournalEvent = {
      type: 'job-finished',
      runId: 'plan-x--k--a',
      at: AT_A,
      jobId: 'j1',
      opId: 'op-j1',
      inputsHash: 'h',
      result: { status: 'ok', value: 1 },
      costUSD: 0.25,
      charged: 0.5,
    };
    expect(JournalEventSchema.parse(finished)).toEqual(finished);
    expect(JournalEventSchema.safeParse({ ...finished, charged: -1 }).success).toBe(false);
  });
});

describe('durable append', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-journal-v2-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a durable append round-trips through read', async () => {
    const log = openRunLog(dir);
    const runId = 'plan-x--a--0a';
    await log.append(
      runId,
      runStarted({ runId, journalVersion: 2, seq: 1, governance: { attended: false } }),
      { durable: true },
    );
    await log.append(
      runId,
      {
        type: 'job-finished',
        runId,
        at: AT_B,
        jobId: 'j1',
        opId: 'op-j1',
        inputsHash: 'h',
        result: { status: 'ok', value: 7 },
        costUSD: 0.5,
      },
      { durable: true },
    );
    const events = await log.read(runId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'job-finished', costUSD: 0.5 });
  });

  test('durable and non-durable appends interleave in call order (one write chain)', async () => {
    const log = openRunLog(dir);
    const runId = 'plan-x--b--0b';
    await log.append(runId, runStarted({ runId }), { durable: true });
    await log.append(runId, {
      type: 'job-started',
      runId,
      at: AT_A,
      jobId: 'j1',
      op: 'op-j1',
      attempt: 1,
    });
    await log.append(
      runId,
      {
        type: 'job-finished',
        runId,
        at: AT_B,
        jobId: 'j1',
        opId: 'op-j1',
        inputsHash: 'h',
        result: { status: 'ok', value: null },
      },
      { durable: true },
    );
    const events = await log.read(runId);
    expect(events.map((event) => event.type)).toEqual([
      'run-started',
      'job-started',
      'job-finished',
    ]);
  });
});

describe('claimSeq', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-seq-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('sequential claims yield 1, 2, 3 and leave one tombstone each', async () => {
    expect(await claimSeq(dir, 'plan-x', 1)).toBe(1);
    expect(await claimSeq(dir, 'plan-x', 1)).toBe(2);
    expect(await claimSeq(dir, 'plan-x', 1)).toBe(3);
  });

  test('a pre-existing tombstone is skipped (EEXIST → n+1)', async () => {
    await writeFile(join(dir, 'plan-x.seq.1'), '', 'utf8');
    await writeFile(join(dir, 'plan-x.seq.2'), '', 'utf8');
    expect(await claimSeq(dir, 'plan-x', 1)).toBe(3);
  });

  test('plans claim independently (the planId namespaces the tombstones)', async () => {
    expect(await claimSeq(dir, 'plan-a', 1)).toBe(1);
    expect(await claimSeq(dir, 'plan-b', 1)).toBe(1);
  });

  test('invalid startAt throws', async () => {
    await expect(claimSeq(dir, 'plan-x', 0)).rejects.toThrow(/startAt/);
  });
});

describe('assertNoSeqGap — the claimSeq tombstones are read on the fold path (review H2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-seqgap-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('tombstones within the folded seq pass (ordinary claims)', async () => {
    await writeFile(join(dir, 'plan-x.seq.1'), '', 'utf8');
    await writeFile(join(dir, 'plan-x.seq.2'), '', 'utf8');
    await expect(assertNoSeqGap(dir, 'plan-x', 2)).resolves.toBeUndefined();
  });

  test('a tombstone beyond the highest folded seq throws: a claimed run\u2019s file is gone', async () => {
    await writeFile(join(dir, 'plan-x.seq.1'), '', 'utf8');
    await writeFile(join(dir, 'plan-x.seq.3'), '', 'utf8');
    await expect(assertNoSeqGap(dir, 'plan-x', 1)).rejects.toThrow(
      /journal: corrupt — seq gap for plan 'plan-x': claim tombstone 'plan-x\.seq\.3' exists/,
    );
  });

  test('another plan\u2019s tombstones never trip this plan\u2019s check (planId-namespaced)', async () => {
    await writeFile(join(dir, 'plan-other.seq.9'), '', 'utf8');
    await expect(assertNoSeqGap(dir, 'plan-x', 0)).resolves.toBeUndefined();
  });

  test('a missing journal dir passes (nothing claimed yet)', async () => {
    await expect(assertNoSeqGap(join(dir, 'absent'), 'plan-x', 0)).resolves.toBeUndefined();
  });

  test('non-numeric seq suffixes are ignored, not crashes', async () => {
    await writeFile(join(dir, 'plan-x.seq.junk'), '', 'utf8');
    await expect(assertNoSeqGap(dir, 'plan-x', 0)).resolves.toBeUndefined();
  });
});

describe('foldOrderRuns', () => {
  const run = (
    runId: string,
    started: RunStartedJournalEvent,
    tail: JournalEvent[] = [],
  ): FoldRun => ({
    runId,
    events: [started, ...tail],
  });

  test('v1 runs order by at (ties by runId) and ALL precede v2 runs', () => {
    const v1Late = run('p--late--aa', runStarted({ runId: 'p--late--aa', at: AT_B }));
    const v1Early = run('p--early--bb', runStarted({ runId: 'p--early--bb', at: AT_A }));
    const v2 = run('p--v2--cc', runStarted({ runId: 'p--v2--cc', journalVersion: 2, seq: 1 }));
    const ordered = foldOrderRuns([v1Late, v2, v1Early]);
    expect(ordered.map((entry) => entry.runId)).toEqual([
      'p--early--bb',
      'p--late--aa',
      'p--v2--cc',
    ]);
  });

  test('v2 runs order by seq even when `at` is reversed by a fake clock', () => {
    const second = run(
      'p--second--aa',
      runStarted({ runId: 'p--second--aa', at: AT_A, journalVersion: 2, seq: 2 }),
    );
    const first = run(
      'p--first--bb',
      runStarted({ runId: 'p--first--bb', at: AT_B, journalVersion: 2, seq: 1 }),
    );
    const ordered = foldOrderRuns([second, first]);
    expect(ordered.map((entry) => entry.runId)).toEqual(['p--first--bb', 'p--second--aa']);
  });

  test('a v2 run without seq is corrupt (throws)', () => {
    const bad = run('p--bad--aa', runStarted({ runId: 'p--bad--aa', journalVersion: 2 }));
    expect(() => foldOrderRuns([bad])).toThrow(/no seq/);
  });

  test('duplicate seq across two v2 runs is corrupt (throws)', () => {
    const a = run('p--a--aa', runStarted({ runId: 'p--a--aa', journalVersion: 2, seq: 4 }));
    const b = run('p--b--bb', runStarted({ runId: 'p--b--bb', journalVersion: 2, seq: 4 }));
    expect(() => foldOrderRuns([a, b])).toThrow(/duplicate seq 4/);
  });

  test('a run with no run-started event throws', () => {
    const orphan: FoldRun = {
      runId: 'p--orphan--aa',
      events: [
        { type: 'job-started', runId: 'p--orphan--aa', at: AT_A, jobId: 'j', op: 'o', attempt: 1 },
      ],
    };
    expect(() => foldOrderRuns([orphan])).toThrow(/run-started/);
  });

  test('a SURVIVING run file whose line count disagrees with run-finished.eventCount is corrupt (comp 2)', () => {
    // A deleted line is the corruption the paired-line throws cannot see:
    // dropping a crashed dispatch's `reservation-opened` would silently
    // drop the run out of the reservation era (its full charge vanishes,
    // its quarantine never fires). The count makes omission as loud as
    // forgery. Three events journalled, two present → the reservation-opened
    // was deleted.
    const started = runStarted({ runId: 'p--short--aa', journalVersion: 2, seq: 1 });
    const finished: JournalEvent = {
      type: 'run-finished',
      runId: 'p--short--aa',
      at: AT_B,
      stoppedEarly: false,
      eventCount: 3,
    };
    const short: FoldRun = {
      runId: 'p--short--aa',
      events: [started, finished], // 2 ≠ 3 — a line went missing
    };
    expect(() => foldOrderRuns([short])).toThrow(/deleted from \(or inserted into\)/);
    // The honest shape folds: the count matches the present lines.
    const whole: FoldRun = {
      runId: 'p--whole--bb',
      events: [
        runStarted({ runId: 'p--whole--bb', journalVersion: 2, seq: 2 }),
        { type: 'job-started', runId: 'p--whole--bb', at: AT_A, jobId: 'j', op: 'o', attempt: 1 },
        { ...finished, runId: 'p--whole--bb', eventCount: 3 },
      ],
    };
    expect(() => foldOrderRuns([whole])).not.toThrow();
    // A torn TAIL (run-finished lost entirely — the crash windows) is not
    // checkable and not corrupt: no run-finished, no count, no throw.
    const torn: FoldRun = {
      runId: 'p--torn--cc',
      events: [runStarted({ runId: 'p--torn--cc', journalVersion: 2, seq: 3 })],
    };
    expect(() => foldOrderRuns([torn])).not.toThrow();
    // v1 runs carry no count — unchanged.
    const v1: FoldRun = {
      runId: 'p--v1--dd',
      events: [runStarted({ runId: 'p--v1--dd', at: AT_A })],
    };
    expect(() => foldOrderRuns([v1])).not.toThrow();
  });
});
