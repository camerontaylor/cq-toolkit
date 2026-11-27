/**
 * Replays the seeded Python 3.14 oracle (`apps/crq-python/backfill_harvest_effect_vectors.py`)
 * through the TS `backfillHarvest` effect. Python ran the real `backfill_runtime.harvest` with the
 * real classifier and cooldown; git, `state_event`, queue save, worktree cleanup, the outbox and
 * the inbox were stubbed to a call log, and are stubbed identically here. Every case must agree on
 * the returned string, the final queue, the call log and `review-event.json`, unless it is named
 * in `DEVIATIONS` with the TS behaviour that replaces Python's.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillHarvestEffect,
  UNBOUND_QUOTA_OUTCOME,
  UNSUPPORTED_SCOPE_MESSAGE,
} from '../../../src/adapters/crq/backfillHarvestEffect.js';
import { fileArtifactStore } from '../../../src/adapters/crq/findingStore.js';
import type { BackfillRepo } from '../../../src/policy/crq/backfillCompletion.js';
import { JsonNumber, JsonObject, toPlainJsonDeep } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';

interface Case {
  readonly name: string;
  readonly scenario: {
    raw: string;
    exit_code: number;
    drop: string[];
    configured: boolean;
    verified: boolean;
  };
  readonly input: {
    queue: Record<string, unknown>;
    meta: Record<string, unknown>;
    exit_doc: Record<string, unknown>;
  };
  readonly expected: {
    result: string | null;
    error: string | null;
    cls: Record<string, unknown>;
    queue: Record<string, unknown>;
    log: string[];
    review_event: boolean;
  };
}
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/crq-python/fixtures/crq-backfill-harvest-effect/cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { schema: string; cases: Case[] };

/**
 * Cases where TS answers differently on purpose: the thrown error's Python class and why.
 * `leadingSave` cases agree on everything except Python's extra `save` before the terminal.
 */
const DEVIATIONS: Record<string, { error: string; why: string }> = {
  'quota, string queue backoff is unusable': {
    error: 'IntegrityError',
    why: 'Python returns the unusable-cooldown retain string; the ops port reports it unhandled and the effect refuses',
  },
  'quota, negative queue backoff is unusable': {
    error: 'IntegrityError',
    why: 'same as the string backoff case',
  },
  'quota, unverified terminal retains ownership': {
    error: 'IntegrityError',
    why: 'Python returns the retain-ownership string; TS requires terminal proof and refuses',
  },
  'quota mixed with auth, unverified: pauses and retains': {
    error: 'IntegrityError',
    why: 'Python returns the retain-ownership string; TS requires terminal proof and refuses',
  },
  'generic failure, unverified terminal still terminal': {
    error: 'IntegrityError',
    why: 'Python finishes a plain failure unverified; TS requires terminal proof',
  },
  'counted completion, unverified terminal still completes': {
    error: 'IntegrityError',
    why: 'Python completes unverified; TS requires terminal proof',
  },
  'reservation owned by another item': {
    error: 'IntegrityError',
    why: 'Python returns the retain-ownership string; TS requires terminal proof and refuses',
  },
  'reservation bound to another run': {
    error: 'IntegrityError',
    why: 'Python returns the retain-ownership string; TS requires terminal proof and refuses',
  },
  'item run bound to another run': {
    error: 'IntegrityError',
    why: 'Python terminals as auth; TS refuses the identity mismatch',
  },
  'meta run id differs': {
    error: 'IntegrityError',
    why: 'Python trusts the passed meta; TS re-reads meta.json and refuses a mismatch',
  },
  'exit code differs from exit.json': {
    error: 'IntegrityError',
    why: 'Python trusts the passed exit code; TS checks it against exit.json',
  },
  'no reservation for the attempt': {
    error: 'TypeError',
    why: 'Python returns the unverified retain string; the ops port raises TypeError',
  },
  'exit.json lacks ended_at': {
    error: 'TypeError',
    why: 'Python KeyError; the ops port raises a typed LedgerTypeError',
  },
};
/** Python saves the new cooldown before the terminal; the ops port saves once, at the end. */
const LEADING_SAVE = new Set(['quota mixed with auth: pauses']);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const errorClass = (error: unknown): string => {
  const named = (error as { pythonError?: unknown }).pythonError;
  if (typeof named === 'string') return named;
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'FileNotFoundError';
  return `unmapped:${(error as Error).name}:${(error as Error).message}`;
};
const repo: BackfillRepo = {
  entries: () => new Map([['a', { blob: 'b'.repeat(40) }]]),
  changedIntervals: () => new Map(),
  changedPaths: () => [],
  retain: (target, revs) => target.put(new TextEncoder().encode(`bundle:${revs.join(' ')}`)),
  verifyReview: () => undefined,
};

async function replay(c: Case, shape_?: (queue: { items: unknown[] }) => Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'backfill-harvest-effect-'));
  dirs.push(root);
  const state = join(root, 'state');
  const rdir = join(state, 'runs', 'r');
  const durable = join(root, 'durable');
  await mkdir(rdir, { recursive: true });
  const files: Record<string, string | Buffer> = {
    'review.ndjson': Buffer.from(c.scenario.raw, 'hex'),
    'exit.json': JSON.stringify(c.input.exit_doc),
    'meta.json': JSON.stringify(c.input.meta),
  };
  for (const [name, data] of Object.entries(files))
    if (!c.scenario.drop.includes(name)) await writeFile(join(rdir, name), data);
  if (c.scenario.configured)
    await writeFile(
      join(state, 'backfill-rollout.json'),
      JSON.stringify({
        enabled: true,
        durable_artifact_root: durable,
        runner_identity: 'crq-runner-app',
        operational_ruling: 'x',
        no_live_run_verification: 'x',
        owner_branch_ruleset_evidence: 'x',
        publisher_spool: { ssh_alias: 'publisher@127.0.0.1', ssh_key: '/fixture/key' },
      }),
    );
  const log: string[] = [];
  const shape = (value: unknown): string => {
    const plain = toPlainJsonDeep(value) as {
      event_type: string;
      source_key: string;
      payload: { outcome: string; findings: unknown[]; artifacts: unknown[] };
    };
    return [
      plain.event_type,
      plain.source_key,
      plain.payload.outcome,
      `findings=${plain.payload.findings.length}`,
      `artifacts=${plain.payload.artifacts.length}`,
    ].join(' ');
  };
  const queue = structuredClone(c.input.queue) as { items: Record<string, unknown>[] };
  const item = shape_ ? shape_(queue) : (queue.items[0] as Record<string, unknown>);
  const effect = backfillHarvestEffect({
    stateRoot: state,
    durableRoot: durable,
    store: fileArtifactStore(durable),
    repo,
    publication: {
      spool: async (value) => {
        log.push(`spool ${shape(value)}`);
        return 'spooled';
      },
    },
    inbox: {
      ingest: async (value) => {
        log.push(`ingest ${shape(value)}`);
      },
    },
    stateEvent: async (q, it, at, reason) => {
      log.push(`event ${at} ${reason}`);
      const prior = q.get('stub_events');
      const row = new JsonObject([
        ['at', at],
        ['reason', reason],
        ['state', String(it.get('state'))],
      ]);
      return withObjectKeys(q, [['stub_events', [...(Array.isArray(prior) ? prior : []), row]]]);
    },
    saveQueue: async () => {
      log.push('save');
    },
    cleanup: async (meta) => {
      log.push(`cleanup ${String(meta.get('worktree'))} ${String(meta.get('wt_branch'))}`);
    },
    defaultBackoffMinutes: 7,
  });
  let result: string | null | undefined;
  let error: string | null = null;
  try {
    result = await effect(
      queue as never,
      item as never,
      'r',
      structuredClone(c.input.meta) as never,
      structuredClone(c.expected.cls) as never,
      c.scenario.exit_code,
      c.scenario.verified,
    );
  } catch (thrown) {
    error = errorClass(thrown);
  }
  const reviewEvent = existsSync(join(rdir, 'review-event.json'));
  return {
    result,
    error,
    log: log.map((l) => l.replaceAll(root, '/T')),
    queue,
    item,
    reviewEvent,
    rdir,
  };
}

describe('backfillHarvest effect: seeded Python differential', () => {
  it('reads the fixture it was generated against', () => {
    expect(fixture.schema).toBe('cq.crq-backfill-harvest-effect-vector/v1');
    expect(fixture.cases.length).toBeGreaterThan(30);
    for (const name of [...Object.keys(DEVIATIONS), ...LEADING_SAVE])
      expect(fixture.cases.some((c) => c.name === name)).toBe(true);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const got = await replay(c);
      const deviation = DEVIATIONS[c.name];
      if (deviation) {
        expect(got.error, deviation.why).toBe(deviation.error);
        return;
      }
      expect(got.error).toBe(c.expected.error);
      if (c.expected.error !== null) return;
      expect(got.result).toBe(c.expected.result);
      const wantLog = LEADING_SAVE.has(c.name) ? c.expected.log.slice(1) : c.expected.log;
      if (LEADING_SAVE.has(c.name)) expect(c.expected.log[0]).toBe('save');
      expect(got.log).toEqual(wantLog);
      expect(got.reviewEvent).toBe(c.expected.review_event);
      const final = JSON.parse(JSON.stringify(toPlainJsonDeep(got.queue))) as {
        items: Array<Record<string, unknown>>;
      };
      // The attempt row is Python's caller's job (`harvest_review`); the ops port appends it too and
      // the TS caller only appends when absent, so compare the end state without it.
      for (const row of final.items) {
        const attempts = (row.attempts as Array<Record<string, unknown>> | undefined) ?? [];
        const own = attempts.filter((a) => a.run_id === 'r');
        const prior = ((c.input.queue.items as Array<Record<string, unknown>>)[0]?.attempts ??
          []) as unknown[];
        if (
          own.length > 0 &&
          !(prior as Array<Record<string, unknown>>).some((a) => a.run_id === 'r')
        ) {
          expect(own).toHaveLength(1);
          expect(own[0]?.outcome).toBe(c.expected.cls.outcome);
          row.attempts = attempts.filter((a) => a.run_id !== 'r');
          if ((row.attempts as unknown[]).length === 0) delete row.attempts;
        }
        if ('publication_event_id' in row) {
          expect(String(row.publication_event_id)).toMatch(/^[0-9a-f]{64}$/);
          row.publication_event_id = 'EVENT';
        }
      }
      expect(final).toEqual(c.expected.queue);
      // The caller keeps using `item`: it is still the queue's own object.
      expect(got.queue.items[0]).toBe(got.item);
    });
  }
});

describe('backfillHarvest effect: documented constants', () => {
  it('names the unbound arms', () => {
    expect(UNSUPPORTED_SCOPE_MESSAGE).toBe(
      'backfill terminal unverified scope; quarantine and retain evidence',
    );
    expect(UNBOUND_QUOTA_OUTCOME).toMatch(/quota failure/);
  });
});

describe('backfillHarvest effect: queue write-back', () => {
  const base = fixture.cases.find((c) => c.name === 'generic failure');
  const pick = (): Case => {
    const found = base ?? fixture.cases.find((c) => c.expected.result === 'backfill pending');
    if (!found) throw new Error('no pending case in the fixture');
    return found;
  };

  it('keeps null and numeric items slots and still syncs the caller queue', async () => {
    const got = await replay(pick(), (queue) => {
      queue.items.push(null, JsonNumber.int(7), { id: 'other', kind: 'review' });
      return queue.items[0] as Record<string, unknown>;
    });
    expect(got.error).toBeNull();
    expect(got.result).toBe(pick().expected.result);
    expect(got.queue.items[1]).toBeNull();
    // A retained number is a JsonNumber instance, not a record: it must not be emptied.
    expect(got.queue.items[2]).toBeInstanceOf(JsonNumber);
    expect((got.queue.items[2] as unknown as JsonNumber).integer).toBe(7n);
    expect(got.queue.items[0]).toBe(got.item);
    expect(got.log).toEqual(pick().expected.log);
  });

  it('refuses an item that is not in the queue before any effect runs', async () => {
    const got = await replay(pick(), () => ({ id: 'stray' }));
    expect(got.error).toBe('IntegrityError');
    expect(got.log).toEqual([]);
  });
});
