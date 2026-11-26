import { describe, expect, test } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  processRepairItem,
  RepairItemShapeError,
  sortFindings,
  type RepairItemEffects,
} from '../../../src/ops/crq/internal/repairItemLoop.js';
import { RUNNER_DISABLED } from '../../../src/ops/crq/internal/repairPassGates.js';

const obj = (...entries: [string, JsonValue][]): JsonObject => new JsonObject(entries);
const FID = 'a'.repeat(64);
const FID2 = 'b'.repeat(64);

function job(
  id: string,
  options: {
    run?: string;
    severity?: string;
    base?: string;
    item?: string;
    omitBase?: boolean;
    canonical?: JsonValue;
  } = {},
): JsonObject {
  const entries: [string, JsonValue][] = [
    ['job', id],
    ['item', options.item ?? 'pr1-merged'],
    ['run', options.run ?? 'r1'],
  ];
  if (!options.omitBase) entries.push(['repair_base', options.base ?? 'b'.repeat(40)]);
  entries.push(['finding', obj(['severity', options.severity ?? 'major'])]);
  if (options.canonical !== undefined) entries.push(['canonical_finding_id', options.canonical]);
  return new JsonObject(entries);
}

const ids = (jobs: readonly JsonObject[]): string[] =>
  jobs.map((entry) => String(entry.get('job')));
const delivered = (task: string): string =>
  JSON.stringify({ status: 'delivered', receipt: { repair_task: task } });

interface Script {
  /** Sticky script of `runnerDisabled()` samples (last repeats). */
  disabled?: boolean[];
  blocked?: boolean[];
  paused?: (string | null)[];
  rows?: Record<string, string | undefined>;
  pending?: Record<string, boolean>;
  existing?: Set<string>;
  addStatus?: number;
  results?: Record<string, JsonObject | (() => JsonObject)>;
}

function harness(script: Script = {}) {
  const log: string[] = [];
  const narrated: string[] = [];
  const processed: { job: string; base: JsonValue | undefined; worktree: string }[] = [];
  const added: { path: string; base: string }[] = [];
  const rowReads: string[] = [];
  let refusals = 0;
  const sample = <T>(values: readonly T[], index: number): T =>
    values[Math.min(index, values.length - 1)] as T;
  const counters = { disabled: 0, blocked: 0, paused: 0 };
  const effects: RepairItemEffects = {
    runnerDisabled: async () => {
      log.push('disabled?');
      return sample(script.disabled ?? [false], counters.disabled++);
    },
    narrate: (message) => narrated.push(message),
    blocked: () => {
      log.push('blocked?');
      return sample(script.blocked ?? [false], counters.blocked++);
    },
    dispatchPaused: async () => {
      log.push('paused?');
      return sample(script.paused ?? [null], counters.paused++);
    },
    readTriageRow: async (id) => {
      rowReads.push(id);
      return script.rows?.[id];
    },
    pending: async (id) => script.pending?.[id] ?? true,
    worktreePath: (name) => `/wt/${name}`,
    worktreeExists: async (path) => script.existing?.has(path) ?? false,
    addWorktree: async (path, base) => {
      added.push({ path, base });
      return script.addStatus ?? 0;
    },
    process: async (entry, worktree) => {
      const id = String(entry.get('job'));
      log.push(`process ${id}`);
      processed.push({ job: id, base: entry.get('repair_base'), worktree });
      const scripted = script.results?.[id];
      if (scripted === undefined) return obj(['verdict', 'FAILED']);
      return typeof scripted === 'function' ? scripted() : scripted;
    },
  };
  return {
    effects,
    log,
    narrated,
    processed,
    added,
    rowReads,
    context: { publishRefusal: () => void (refusals += 1) },
    refusals: () => refusals,
  };
}

const fixed = (...commits: string[]): JsonObject => obj(['verdict', 'FIXED'], ['commits', commits]);

describe('sortFindings (finding_order)', () => {
  test('critical/major before minor, then run, then numeric finding number', () => {
    const jobs = [
      job('crq-run2-F1', { run: 'run2' }),
      job('crq-run1-F10', { run: 'run1' }),
      job('crq-run1-F2', { run: 'run1' }),
      job('crq-run1-F1', { run: 'run1', severity: 'minor' }),
      job('crq-run0-F9', { run: 'run0', severity: 'minor' }),
    ];
    sortFindings(jobs);
    expect(ids(jobs)).toEqual([
      'crq-run1-F2',
      'crq-run1-F10',
      'crq-run2-F1',
      'crq-run0-F9',
      'crq-run1-F1',
    ]);
  });

  test('backfill jobs without an -F suffix sort as number 0 and equal keys stay stable', () => {
    const jobs = [
      job('crq-backfill-b', { run: 'r' }),
      job('crq-r-F1', { run: 'r' }),
      job('crq-backfill-a', { run: 'r' }),
      job('crq-r-Fx', { run: 'r' }),
    ];
    sortFindings(jobs);
    expect(ids(jobs)).toEqual(['crq-backfill-b', 'crq-backfill-a', 'crq-r-Fx', 'crq-r-F1']);
  });

  test('only the last -F splits and the digits are not truncated', () => {
    const jobs = [job('crq-x-F2-F10', { run: 'r' }), job('crq-x-F2-F9', { run: 'r' })];
    sortFindings(jobs);
    expect(ids(jobs)).toEqual(['crq-x-F2-F9', 'crq-x-F2-F10']);
  });

  test('runs compare by code point, not UTF-16 unit', () => {
    const jobs = [job('crq-a-F1', { run: '\u{1F600}' }), job('crq-b-F1', { run: '～' })];
    sortFindings(jobs);
    expect(ids(jobs)).toEqual(['crq-b-F1', 'crq-a-F1']);
  });

  test('keys are computed for a single job, so a malformed one raises alone', () => {
    expect(() => sortFindings([obj(['job', 'crq-r-F1'])])).toThrow(/run/);
    expect(() => sortFindings([obj(['job', 'crq-r-F1'], ['run', 'r'], ['finding', 'x'])])).toThrow(
      RepairItemShapeError,
    );
    // A missing finding is `{}`, not an error.
    expect(() => sortFindings([obj(['job', 'crq-r-F1'], ['run', 'r'])])).not.toThrow();
  });

  test('runs that are not strings cannot be ordered against each other', () => {
    const jobs = [
      obj(['job', 'crq-a-F1'], ['run', JsonNumber.int(1)]),
      obj(['job', 'crq-b-F1'], ['run', 'r']),
    ];
    expect(() => sortFindings(jobs)).toThrow(RepairItemShapeError);
  });
});

describe('processRepairItem admission order', () => {
  test('a disabled marker wins over blackout and pause and publishes a refusal', async () => {
    const h = harness({ disabled: [true], blocked: [true], paused: ['until'] });
    const outcome = await processRepairItem([job('crq-r-F1')], h.context, h.effects);
    expect(outcome).toBe('runner-disabled');
    expect(h.narrated).toEqual([`${RUNNER_DISABLED}: job crq-r-F1 not admitted`]);
    expect(h.refusals()).toBe(1);
    expect(h.log).toEqual(['disabled?']);
    expect(h.processed).toEqual([]);
  });

  test('the blackout stops the item quietly before the pause is consulted', async () => {
    const h = harness({ blocked: [true], paused: ['until'] });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBeNull();
    expect(h.log).toEqual(['disabled?', 'blocked?']);
    expect(h.refusals()).toBe(0);
    expect(h.narrated).toEqual([]);
  });

  test('a live pause returns rate-limit before any worktree or model work', async () => {
    const h = harness({ paused: ['2999-01-01T00:00:00Z'] });
    const outcome = await processRepairItem([job('crq-r-F1')], h.context, h.effects);
    expect(outcome).toBe('rate-limit');
    expect(h.log).toEqual(['disabled?', 'blocked?', 'paused?']);
    expect(h.added).toEqual([]);
    expect(h.processed).toEqual([]);
  });

  test('a marker written between serial jobs stops the rest after the in-flight job finishes', async () => {
    const h = harness({ disabled: [false, true], results: { 'crq-r-F1': fixed('c1') } });
    const outcome = await processRepairItem(
      [job('crq-r-F2'), job('crq-r-F1'), job('crq-r-F3')],
      h.context,
      h.effects,
    );
    expect(outcome).toBe('runner-disabled');
    expect(ids(h.processed.map((p) => obj(['job', p.job])))).toEqual(['crq-r-F1']);
    expect(h.narrated).toEqual([`${RUNNER_DISABLED}: job crq-r-F2 not admitted`]);
    expect(h.refusals()).toBe(1);
  });

  test('a blackout that opens after a job lets that job finish and starts no more', async () => {
    const h = harness({ blocked: [false, true] });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBeNull();
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1']);
  });

  test('every admission samples the gates afresh, in order, for each job', async () => {
    const h = harness();
    await processRepairItem([job('crq-r-F1'), job('crq-r-F2')], h.context, h.effects);
    expect(h.log).toEqual([
      'disabled?',
      'blocked?',
      'paused?',
      'process crq-r-F1',
      'paused?',
      'disabled?',
      'blocked?',
      'paused?',
      'process crq-r-F2',
      'paused?',
    ]);
  });

  test('jobs run in finding order, whatever order the drain handed them over', async () => {
    const h = harness();
    await processRepairItem(
      [job('crq-r-F1', { severity: 'minor' }), job('crq-r-F10'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F2', 'crq-r-F10', 'crq-r-F1']);
  });
});

describe('canonical delivery', () => {
  test('a legacy job without canonical_finding_id never reads a row', async () => {
    const h = harness();
    await processRepairItem([job('crq-r-F1')], h.context, h.effects);
    expect(h.rowReads).toEqual([]);
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1']);
  });

  test('a row delivered to this task runs', async () => {
    const h = harness({ rows: { [FID]: delivered('crq-r-F1') } });
    await processRepairItem([job('crq-r-F1', { canonical: FID })], h.context, h.effects);
    expect(h.rowReads).toEqual([FID]);
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1']);
  });

  test.each([
    [
      'delivered to another task',
      { [FID]: delivered('crq-other-F1') },
      'canonical finding is not delivered to this repair task',
    ],
    [
      'not delivered',
      { [FID]: JSON.stringify({ status: 'queued', receipt: {} }) },
      'canonical finding is not delivered to this repair task',
    ],
    ['unreadable', {}, 'canonical delivery state unavailable'],
    ['not JSON', { [FID]: '{' }, 'canonical delivery state unavailable'],
  ])('a row %s skips only that job and the next job runs', async (_name, rows, reason) => {
    const h = harness({ rows: { ...rows, [FID2]: delivered('crq-r-F2') } });
    const outcome = await processRepairItem(
      [job('crq-r-F1', { canonical: FID }), job('crq-r-F2', { canonical: FID2 })],
      h.context,
      h.effects,
    );
    expect(outcome).toBeNull();
    expect(h.narrated).toEqual([`repair crq-r-F1: skipped: ${reason}`]);
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F2']);
    expect(h.added.map((a) => a.path)).toEqual(['/wt/crq-repair-pr1-merged-crq-r-F2']);
  });

  test.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['short', 'a'.repeat(63)],
    ['path traversal', '../../etc/passwd'],
    ['trailing newline', `${'a'.repeat(64)}\n`],
    ['not a string', JsonNumber.int(7)],
    ['null', null],
  ] as const)('an invalid identity (%s) is refused without reading a row', async (_name, bad) => {
    const h = harness();
    await processRepairItem([job('crq-r-F1', { canonical: bad })], h.context, h.effects);
    expect(h.rowReads).toEqual([]);
    expect(h.narrated).toEqual(['repair crq-r-F1: skipped: invalid canonical finding identity']);
    expect(h.processed).toEqual([]);
  });

  test('a skipped job never contributes to base chaining and starts no worktree', async () => {
    const h = harness({
      rows: { [FID]: delivered('someone-else'), [FID2]: delivered('crq-r-F2') },
      results: { 'crq-r-F2': fixed('c2') },
    });
    await processRepairItem(
      [job('crq-r-F1', { canonical: FID }), job('crq-r-F2', { canonical: FID2 }), job('crq-r-F3')],
      h.context,
      h.effects,
    );
    expect(h.processed.map((p) => [p.job, p.base])).toEqual([
      ['crq-r-F2', 'b'.repeat(40)],
      ['crq-r-F3', 'c2'],
    ]);
  });

  test('the gates run before delivery, so a pause beats a delivery skip', async () => {
    const h = harness({ paused: ['until'], rows: {} });
    const outcome = await processRepairItem(
      [job('crq-r-F1', { canonical: FID })],
      h.context,
      h.effects,
    );
    expect(outcome).toBe('rate-limit');
    expect(h.rowReads).toEqual([]);
    expect(h.narrated).toEqual([]);
  });
});

describe('base chaining', () => {
  test('a FIXED job hands its last commit to the next job of the same run', async () => {
    const h = harness({ results: { 'crq-r-F1': fixed('c1', 'c2') } });
    await processRepairItem(
      [job('crq-r-F2'), job('crq-r-F1'), job('crq-r-F3')],
      h.context,
      h.effects,
    );
    expect(h.processed.map((p) => [p.job, p.base])).toEqual([
      ['crq-r-F1', 'b'.repeat(40)],
      ['crq-r-F2', 'c2'],
      // F2 did not fix anything; the run's tip stays the last FIXED commit.
      ['crq-r-F3', 'c2'],
    ]);
  });

  test('F3 keeps chaining from F1 when F2 did not fix anything', async () => {
    const h = harness({
      results: { 'crq-r-F1': fixed('c1'), 'crq-r-F2': obj(['verdict', 'UNCHANGED']) },
    });
    await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2'), job('crq-r-F3')],
      h.context,
      h.effects,
    );
    expect(h.processed.map((p) => p.base)).toEqual(['b'.repeat(40), 'c1', 'c1']);
  });

  test('chains are per run: another run keeps its own base', async () => {
    const h = harness({ results: { 'crq-a-F1': fixed('ca') } });
    await processRepairItem(
      [
        job('crq-a-F1', { run: 'a', base: '1'.repeat(40) }),
        job('crq-a-F2', { run: 'a', base: '1'.repeat(40) }),
        job('crq-b-F1', { run: 'b', base: '2'.repeat(40) }),
      ],
      h.context,
      h.effects,
    );
    expect(h.processed.map((p) => [p.job, p.base])).toEqual([
      ['crq-a-F1', '1'.repeat(40)],
      ['crq-a-F2', 'ca'],
      ['crq-b-F1', '2'.repeat(40)],
    ]);
  });

  test('the chained base is what the worktree is created from and what the caller sees', async () => {
    const jobs = [job('crq-r-F1'), job('crq-r-F2')];
    const h = harness({ results: { 'crq-r-F1': fixed('tip') } });
    await processRepairItem(jobs, h.context, h.effects);
    expect(h.added).toEqual([
      { path: '/wt/crq-repair-pr1-merged-crq-r-F1', base: 'b'.repeat(40) },
      { path: '/wt/crq-repair-pr1-merged-crq-r-F2', base: 'tip' },
    ]);
    expect(jobs.map((entry) => entry.get('repair_base'))).toEqual(['b'.repeat(40), 'tip']);
    // Key position is preserved when the base is replaced.
    expect(jobs[1]!.entries.map(([key]) => key)).toEqual([
      'job',
      'item',
      'run',
      'repair_base',
      'finding',
    ]);
  });

  test('a FIXED result without a commit is a shape error, not a silent no-chain', async () => {
    const h = harness({ results: { 'crq-r-F1': obj(['verdict', 'FIXED'], ['commits', []]) } });
    await expect(processRepairItem([job('crq-r-F1')], h.context, h.effects)).rejects.toThrow(
      /IndexError/,
    );
    const g = harness({ results: { 'crq-r-F1': obj(['verdict', 'FIXED']) } });
    await expect(processRepairItem([job('crq-r-F1')], g.context, g.effects)).rejects.toThrow(
      /commits/,
    );
  });
});

describe('worktree handling', () => {
  test('a pending job without a worktree gets one added from its base', async () => {
    const h = harness();
    await processRepairItem([job('crq-r-F1')], h.context, h.effects);
    expect(h.added).toEqual([{ path: '/wt/crq-repair-pr1-merged-crq-r-F1', base: 'b'.repeat(40) }]);
    expect(h.processed[0]!.worktree).toBe('/wt/crq-repair-pr1-merged-crq-r-F1');
  });

  test('an existing worktree is reused and a finished job gets none', async () => {
    const h = harness({
      existing: new Set(['/wt/crq-repair-pr1-merged-crq-r-F1']),
      pending: { 'crq-r-F2': false },
    });
    await processRepairItem([job('crq-r-F1'), job('crq-r-F2')], h.context, h.effects);
    expect(h.added).toEqual([]);
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1', 'crq-r-F2']);
  });

  test('a failed worktree add aborts the item before any process call', async () => {
    const h = harness({ addStatus: 128 });
    await expect(processRepairItem([job('crq-r-F1')], h.context, h.effects)).rejects.toThrow(
      'repair worktree creation failed',
    );
    expect(h.processed).toEqual([]);
  });
});

describe('retry and pause after a job', () => {
  test('a truthy retry_after stops the item with no outcome and starts no later job', async () => {
    const h = harness({
      results: { 'crq-r-F1': obj(['verdict', 'FAILED'], ['retry_after', '2999-01-01T00:00:00Z']) },
    });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBeNull();
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1']);
  });

  test.each([
    ['null', null],
    ['empty string', ''],
    ['zero', JsonNumber.int(0)],
    ['false', false],
    ['empty list', [] as JsonValue[]],
  ] as const)('a falsy retry_after (%s) does not stop the item', async (_name, value) => {
    const h = harness({
      results: { 'crq-r-F1': obj(['verdict', 'FAILED'], ['retry_after', value]) },
    });
    await processRepairItem([job('crq-r-F1'), job('crq-r-F2')], h.context, h.effects);
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1', 'crq-r-F2']);
  });

  test('a deferred FIXED result does not chain: retry_after is checked first', async () => {
    const h = harness({
      results: { 'crq-r-F1': obj(['verdict', 'FIXED'], ['commits', ['c1']], ['retry_after', 'x']) },
    });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBeNull();
    expect(h.processed).toHaveLength(1);
  });

  test('a pause written by the job returns rate-limit even though the job deferred', async () => {
    const h = harness({
      paused: [null, 'until'],
      results: { 'crq-r-F1': obj(['verdict', 'FAILED'], ['retry_after', '2999-01-01T00:00:00Z']) },
    });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBe('rate-limit');
    expect(h.processed).toHaveLength(1);
  });

  test('a pause after a FIXED job still ends the pass before the result is inspected', async () => {
    const h = harness({
      paused: [null, 'until'],
      // No verdict at all: the pause check precedes every read of the result.
      results: { 'crq-r-F1': obj() },
    });
    const outcome = await processRepairItem(
      [job('crq-r-F1'), job('crq-r-F2')],
      h.context,
      h.effects,
    );
    expect(outcome).toBe('rate-limit');
  });

  test('a result with no verdict and no retry_after is a shape error', async () => {
    const h = harness({ results: { 'crq-r-F1': obj() } });
    await expect(processRepairItem([job('crq-r-F1')], h.context, h.effects)).rejects.toThrow(
      /verdict/,
    );
  });
});

describe('malformed input', () => {
  test('an empty job list is an IndexError, not a quiet no-op', async () => {
    const h = harness();
    await expect(processRepairItem([], h.context, h.effects)).rejects.toThrow(RepairItemShapeError);
  });

  test('the item comes from the first job before the sort, not the sorted first job', async () => {
    const h = harness();
    await processRepairItem(
      [job('crq-r-F2', { item: 'input-first' }), job('crq-r-F1', { item: 'sorted-first' })],
      h.context,
      h.effects,
    );
    // F1 sorts ahead of F2, yet both worktrees are named for jobs[0]['item'] as read pre-sort.
    expect(h.processed.map((p) => [p.job, p.worktree])).toEqual([
      ['crq-r-F1', '/wt/crq-repair-input-first-crq-r-F1'],
      ['crq-r-F2', '/wt/crq-repair-input-first-crq-r-F2'],
    ]);
  });

  test('repair_base is read eagerly: a job without it fails even when its run has a chained tip', async () => {
    const h = harness({ results: { 'crq-r-F1': fixed('tip') } });
    await expect(
      processRepairItem(
        [job('crq-r-F1'), job('crq-r-F2', { omitBase: true })],
        h.context,
        h.effects,
      ),
    ).rejects.toThrow("KeyError: 'repair_base'");
    // The first job ran and chained; only the second tripped on its own missing key.
    expect(h.processed.map((p) => p.job)).toEqual(['crq-r-F1']);
  });
});
