// Port of `client_health.record` / `advisory`: the durable discovery-health streak and the
// bounded, marker-keyed advisory issue (open, reopen, close, ambiguous-create recovery).
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_MAX_CALLS,
  HEALTH_MARKER,
  HEALTH_TITLE,
  HealthAdvisoryError,
  pythonErrorName,
  recordClientHealth,
  type ClientHealthEffects,
} from '../../../src/ops/crq/clientHealthRecord.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (v: JsonValue | undefined): unknown => (v === undefined ? undefined : toPlainJson(v));
const SHA = 'a'.repeat(40);

type Forge = (args: string[]) => unknown;

interface Harness {
  readonly effects: ClientHealthEffects;
  readonly saves: JsonObject[];
  readonly calls: string[][];
  readonly timeouts: number[];
}

function harness(
  forge: Forge = () => [],
  options: { threshold?: JsonValue; budget?: ForgeBudget } = {},
): Harness {
  const saves: JsonObject[] = [];
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const effects: ClientHealthEffects = {
    saveQueue: (queue) => {
      saves.push(queue);
    },
    iso: () => '2026-11-20T00:00:00Z',
    checkoutSha: () => SHA,
    repo: 'o/r',
    incompleteTicksThreshold: options.threshold,
    forgeJson: (args, { timeoutSeconds }) => {
      calls.push(args);
      timeouts.push(timeoutSeconds);
      const answer = forge(args);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(parseJsonValue(JSON.stringify(answer)));
    },
    ...(options.budget === undefined ? {} : { newBudget: () => options.budget as ForgeBudget }),
  };
  return { effects, saves, calls, timeouts };
}

const forgeError = (pythonError: string, message = pythonError): Error =>
  new HealthAdvisoryError(pythonError, message);

const queueOf = (
  health: Record<string, unknown>,
  merged: Record<string, unknown> | undefined = { complete: false },
): JsonObject =>
  doc({ client_health: health, ...(merged === undefined ? {} : { merged_discovery: merged }) });

const healthOf = (queue: JsonObject): Record<string, unknown> =>
  plain(queue.get('client_health')) as Record<string, unknown>;

describe('recordClientHealth: the durable observation', () => {
  it('retains the last observation and logs a skip when discovery did not run', async () => {
    const h = harness();
    const result = await recordClientHealth(
      queueOf({ complete: false, incomplete_ticks: 2 }),
      false,
      h.effects,
    );
    expect(result.log).toEqual(['health advisory skipped: discovery not run']);
    expect(healthOf(result.queue)).toMatchObject({
      complete: false,
      incomplete_ticks: 2,
      sha: SHA,
      completed_at: '2026-11-20T00:00:00Z',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('skips when discovery ran but reported no completeness', async () => {
    const h = harness();
    const result = await recordClientHealth(queueOf({}, {}), true, h.effects);
    expect(result.log).toEqual(['health advisory skipped: discovery not run']);
    expect(healthOf(result.queue).complete).toBeNull();
  });

  it('creates the health block when the queue has none', async () => {
    const h = harness();
    const result = await recordClientHealth(doc({}), false, h.effects);
    expect(healthOf(result.queue)).toMatchObject({ complete: null, sha: SHA });
  });

  it('counts an incomplete tick below the threshold without touching the forge', async () => {
    const h = harness();
    const result = await recordClientHealth(queueOf({ incomplete_ticks: 0 }), true, h.effects);
    expect(healthOf(result.queue)).toMatchObject({ complete: false, incomplete_ticks: 1 });
    expect(result.log).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('resets the streak when discovery completes', async () => {
    const h = harness();
    const result = await recordClientHealth(
      queueOf({ incomplete_ticks: 2 }, { complete: true }),
      true,
      h.effects,
    );
    expect(healthOf(result.queue)).toMatchObject({ complete: true, incomplete_ticks: 0 });
  });

  it('treats a partitioned complete drain as incomplete', async () => {
    const h = harness();
    const result = await recordClientHealth(
      queueOf({ incomplete_ticks: 0 }, { complete: true, span: 4 }),
      true,
      h.effects,
    );
    expect(healthOf(result.queue)).toMatchObject({ complete: false, incomplete_ticks: 1 });
  });

  it('caps the streak at one million', async () => {
    const h = harness();
    const result = await recordClientHealth(
      queueOf({
        incomplete_ticks: 1_000_000,
        issue_open: true,
        issue_number: 4,
        issue_ticks: 1_000_000,
      }),
      true,
      h.effects,
    );
    expect(healthOf(result.queue).incomplete_ticks).toBe(1_000_000);
    expect(h.calls).toHaveLength(0);
  });

  it('keeps a float streak a float', async () => {
    const start = queueOf({ incomplete_ticks: 0 });
    const withFloat = new JsonObject([
      ...start.entries.filter(([key]) => key !== 'client_health'),
      ['client_health', new JsonObject([['incomplete_ticks', JsonNumber.float(1)]])],
    ]);
    const result = await recordClientHealth(withFloat, true, harness().effects);
    const streak = (result.queue.get('client_health') as JsonObject).get('incomplete_ticks');
    expect(streak).toBeInstanceOf(JsonNumber);
    expect((streak as JsonNumber).kind).toBe('float');
  });

  it('refuses a non-object health block as an AttributeError', async () => {
    await expect(
      recordClientHealth(doc({ client_health: 5 }), true, harness().effects),
    ).rejects.toMatchObject({ pythonError: 'AttributeError' });
  });
});

describe('recordClientHealth: opening the advisory issue', () => {
  const atThreshold = () => queueOf({ incomplete_ticks: 2 });

  it('lists, records the intent to open, then creates the issue', async () => {
    const h = harness((args) => (args[0] === 'issue' ? [] : { number: 9 }));
    const result = await recordClientHealth(atThreshold(), true, h.effects);
    expect(h.calls[0]).toEqual([
      'issue',
      'list',
      '--repo',
      'o/r',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,body',
    ]);
    expect(h.calls[1]?.slice(0, 2)).toEqual(['api', 'repos/o/r/issues']);
    expect(h.calls[1]).toContain(`title=${HEALTH_TITLE}`);
    expect(h.calls[1]?.at(-1)).toBe(
      `body=${HEALTH_MARKER}\nDiscovery incomplete for 3 ticks. Advisory only.`,
    );
    // The opening marker is durable before the create call can go ambiguous.
    expect(healthOf(h.saves[0] as JsonObject).opening).toBe(true);
    expect(healthOf(result.queue)).toMatchObject({
      issue_open: true,
      issue_number: 9,
      opening: false,
      issue_ticks: 3,
      recovery_commented: false,
    });
    expect(result.log).toEqual([]);
  });

  it('adopts the existing marked issue and reopens it instead of creating another', async () => {
    const h = harness((args) =>
      args[0] === 'issue'
        ? [
            { number: 1, title: 'other', body: HEALTH_MARKER },
            { number: 2, title: HEALTH_TITLE, body: 'no marker' },
            { number: 3, title: HEALTH_TITLE, body: `x ${HEALTH_MARKER}` },
          ]
        : {},
    );
    const result = await recordClientHealth(atThreshold(), true, h.effects);
    expect(h.calls[1]?.slice(0, 5)).toEqual(['api', 'repos/o/r/issues/3', '-X', 'PATCH', '-f']);
    expect(h.calls[1]).toContain('state=open');
    expect(healthOf(result.queue)).toMatchObject({ issue_number: 3, issue_open: true });
  });

  it('keeps the opening marker after an ambiguous create (timeout) and reports it', async () => {
    const h = harness((args) => (args[0] === 'issue' ? [] : forgeError('TimeoutExpired')));
    const result = await recordClientHealth(atThreshold(), true, h.effects);
    expect(result.log).toEqual([
      'health advisory skipped or failed: TimeoutExpired',
      'health advisory: opening marker unresolved',
    ]);
    expect(healthOf(result.queue).opening).toBe(true);
  });

  it('clears the opening marker after a definite create failure', async () => {
    const h = harness((args) => (args[0] === 'issue' ? [] : forgeError('CalledProcessError')));
    const result = await recordClientHealth(atThreshold(), true, h.effects);
    expect(result.log).toEqual(['health advisory skipped or failed: CalledProcessError']);
    expect(healthOf(result.queue).opening).toBe(false);
    expect(healthOf(h.saves[h.saves.length - 1] as JsonObject).opening).toBe(false);
  });

  it('resolves a stale opening marker from the list before deciding', async () => {
    const h = harness(() => []);
    const start = queueOf({ incomplete_ticks: 0, opening: true });
    const result = await recordClientHealth(start, true, h.effects);
    expect(result.log).toEqual([
      'health advisory: opening marker unresolved; confirming list found no issue, marker cleared',
    ]);
    expect(healthOf(result.queue)).toMatchObject({ opening: false, issue_number: null });
  });

  it('honours a configured threshold and ignores an out-of-range one', async () => {
    const low = harness(() => [], { threshold: JsonNumber.int(1) });
    await recordClientHealth(queueOf({ incomplete_ticks: 0 }), true, low.effects);
    expect(low.calls.length).toBeGreaterThan(0);
    const bad = harness(() => [], { threshold: JsonNumber.int(0) });
    await recordClientHealth(queueOf({ incomplete_ticks: 0 }), true, bad.effects);
    expect(bad.calls).toHaveLength(0);
  });

  it('stops at the advisory budget with a RuntimeError', async () => {
    const budget = new ForgeBudget({ requests: 1, seconds: 10 });
    const h = harness((args) => (args[0] === 'issue' ? [] : { number: 9 }), { budget });
    const result = await recordClientHealth(atThreshold(), true, h.effects);
    expect(h.calls).toHaveLength(1);
    expect(result.log[0]).toBe('health advisory skipped or failed: RuntimeError');
    expect(ADVISORY_MAX_CALLS).toBe(3);
  });

  it('passes the budget take as each call timeout', async () => {
    const h = harness((args) => (args[0] === 'issue' ? [] : { number: 9 }));
    await recordClientHealth(atThreshold(), true, h.effects);
    expect(h.timeouts).toHaveLength(2);
    for (const seconds of h.timeouts) {
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(10);
    }
  });
});

describe('recordClientHealth: updating and closing', () => {
  it('re-patches an open issue only when the tick count crosses another threshold multiple', async () => {
    const quiet = harness();
    await recordClientHealth(
      queueOf({ incomplete_ticks: 3, issue_open: true, issue_number: 9, issue_ticks: 3 }),
      true,
      quiet.effects,
    );
    expect(quiet.calls).toHaveLength(0);
    const due = harness();
    const result = await recordClientHealth(
      queueOf({ incomplete_ticks: 5, issue_open: true, issue_number: 9, issue_ticks: 3 }),
      true,
      due.effects,
    );
    expect(due.calls).toHaveLength(1);
    expect(due.calls[0]?.slice(0, 4)).toEqual(['api', 'repos/o/r/issues/9', '-X', 'PATCH']);
    expect(due.calls[0]?.at(-1)).toContain('Discovery incomplete for 6 ticks');
    expect(healthOf(result.queue).issue_ticks).toBe(6);
  });

  it('comments once that discovery recovered, then closes the issue', async () => {
    const h = harness();
    const result = await recordClientHealth(
      queueOf(
        { incomplete_ticks: 5, issue_open: true, issue_number: 9, issue_ticks: 5 },
        { complete: true },
      ),
      true,
      h.effects,
    );
    expect(h.calls).toEqual([
      [
        'api',
        'repos/o/r/issues/9/comments',
        '-f',
        `body=${HEALTH_MARKER}\nDiscovery complete again.`,
      ],
      ['api', 'repos/o/r/issues/9', '-X', 'PATCH', '-f', 'state=closed'],
    ]);
    expect(healthOf(result.queue)).toMatchObject({
      issue_open: false,
      recovery_commented: true,
      incomplete_ticks: 0,
    });
  });

  it('does not repeat the recovery comment when it was already posted', async () => {
    const h = harness();
    await recordClientHealth(
      queueOf(
        {
          incomplete_ticks: 5,
          issue_open: true,
          issue_number: 9,
          issue_ticks: 5,
          recovery_commented: true,
        },
        { complete: true },
      ),
      true,
      h.effects,
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain('state=closed');
  });
});

describe('pythonErrorName', () => {
  it('prefers the carried Python class, then the JS name, then Exception', () => {
    expect(pythonErrorName(new HealthAdvisoryError('KeyError', "'x'"))).toBe('KeyError');
    expect(pythonErrorName(new TypeError('t'))).toBe('TypeError');
    expect(pythonErrorName('str')).toBe('Exception');
  });
});
