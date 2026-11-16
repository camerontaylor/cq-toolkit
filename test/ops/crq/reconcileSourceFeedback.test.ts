import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { ledgerCanonicalBytes, ledgerLoads } from '../../../src/policy/crq/ledger.js';
import {
  markFixedOutcome,
  publishSource,
  type FixedOutcomeEffects,
  type SourcePublishEffects,
  type SourceThread,
} from '../../../src/ops/crq/internal/reconcileSourceFeedback.js';
import { SourcePublicationFailed } from '../../../src/ops/crq/internal/reconcileFixRun.js';
import type {
  FindingInboxFiles,
  FindingPublication,
} from '../../../src/ops/review/internal/crq/findingInbox.js';

const FINDING = 'a'.repeat(64);
const REVIEW = 'b'.repeat(64);
const merge = 'a'.repeat(40);
const published = 'b'.repeat(40);
const ctx = { itemId: 'item-1', run: 'run-1' };

function obj(value: unknown): JsonObject {
  const v = parseJsonValue(JSON.stringify(value));
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
const plain = (v: JsonValue | undefined): unknown => toPlainJson(v ?? null);

class Files implements FindingInboxFiles {
  rows = new Map<string, Uint8Array>();
  writes = 0;
  constructor(row?: JsonObject) {
    if (row) this.rows.set(FINDING, ledgerCanonicalBytes(row));
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async readTriage(id: string): Promise<Uint8Array | null> {
    return this.rows.get(id) ?? null;
  }
  async writeTriage(id: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.rows.set(id, bytes);
  }
  current(): JsonObject {
    return ledgerLoads(this.rows.get(FINDING)!) as JsonObject;
  }
}
class Pub implements FindingPublication {
  events: JsonValue[] = [];
  async retained(): Promise<JsonValue[]> {
    return [...this.events];
  }
  async spool(v: JsonValue): Promise<string> {
    this.events.push(v);
    return (v as JsonObject).get('id') as string;
  }
}
const row = (): JsonObject =>
  obj({
    review_id: REVIEW,
    finding: { id: FINDING },
    canonical_id: FINDING,
    previous_event_id: null,
    status: 'delivered',
    receipt: { repair_task: 'crq-j1' },
  });
const verdicts = [{ job: 'crq-j1', verdict: 'FIXED', reason: 'worker says fixed' }];
const rec = (extra: Record<string, unknown> = {}): JsonObject =>
  obj({
    jobs: ['crq-j1'],
    state: 'published',
    fix_pr: { number: 42 },
    verdicts,
    publication: {
      head: published,
      commits: [published],
      target: 't',
      branch: 'b',
      open_pr: 7,
      source_resolutions: [],
    },
    ...extra,
  });

function outcome(over: { job?: Record<string, unknown>; files?: Files } = {}): {
  e: FixedOutcomeEffects;
  files: Files;
  pub: Pub;
} {
  const files = over.files ?? new Files(row());
  const pub = new Pub();
  return {
    files,
    pub,
    e: {
      files,
      publication: pub,
      readJob: async (id) => obj({ job: id, canonical_finding_id: FINDING, ...over.job }),
      maxFindingRetries: () => 2,
      now: () => '2026-11-15T00:00:00Z',
    },
  };
}

describe('markFixedOutcome', () => {
  test('writes a fixed event with the merge commit and the PR url', async () => {
    const { e, files, pub } = outcome({ job: { repair_base: 'c'.repeat(40) } });
    await markFixedOutcome(rec(), 'crq-j1', merge, 'https://x/pull/42', null, e);
    const event = pub.events[0] as JsonObject;
    const payload = event.get('payload') as JsonObject;
    expect(payload.get('action')).toBe('fixed');
    const evidence = plain(payload.get('evidence')) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      repair_task: 'crq-j1',
      reason: 'worker says fixed',
      fix_pr: 'https://x/pull/42',
      repair_base: 'c'.repeat(40),
      fixing_commit: merge,
      verification: 'worker says fixed',
    });
    expect(files.current().get('status')).toBe('fixed');
  });
  test('a job without a canonical finding id writes nothing', async () => {
    const { e, files, pub } = outcome({ job: { canonical_finding_id: null } });
    await markFixedOutcome(rec(), 'crq-j1', merge, 'u', null, e);
    expect(pub.events).toEqual([]);
    expect(files.writes).toBe(0);
  });
  test('a revalidation proof substitutes its reason', async () => {
    const { e, pub } = outcome();
    const proof = obj({ fixed_revalidation: { reason: 'revalidated by rereading' } });
    await markFixedOutcome(rec(), 'crq-j1', merge, 'u', proof, e);
    const evidence = ((pub.events[0] as JsonObject).get('payload') as JsonObject).get('evidence');
    expect(plain(evidence)).toMatchObject({
      reason: 'revalidated by rereading',
      verification: 'revalidated by rereading',
    });
  });
  test('an empty reason falls back to the verdict name', async () => {
    const { e, pub } = outcome();
    await markFixedOutcome(
      rec({ verdicts: [{ job: 'crq-j1', verdict: 'FIXED' }] }),
      'crq-j1',
      merge,
      'u',
      null,
      e,
    );
    const evidence = ((pub.events[0] as JsonObject).get('payload') as JsonObject).get('evidence');
    expect(plain(evidence)).toMatchObject({ reason: 'FIXED' });
  });
  test('a newer generation is preserved untouched', async () => {
    const files = new Files(
      obj({ ...(plain(row()) as object), receipt: { repair_task: 'crq-j9' } }),
    );
    const { e, pub } = outcome({ files });
    await markFixedOutcome(rec(), 'crq-j1', merge, 'u', null, e);
    expect(pub.events).toEqual([]);
    expect(files.writes).toBe(0);
  });
  test('an already recorded outcome is not written twice', async () => {
    const { e, files, pub } = outcome();
    await markFixedOutcome(rec(), 'crq-j1', merge, 'u', null, e);
    files.rows.set(FINDING, ledgerCanonicalBytes(row()));
    await markFixedOutcome(rec(), 'crq-j1', merge, 'u', null, e);
    expect(pub.events).toHaveLength(1);
  });
  test('a missing finding row is an error', async () => {
    const { e } = outcome({ files: new Files() });
    await expect(markFixedOutcome(rec(), 'crq-j1', merge, 'u', null, e)).rejects.toThrow(
      /row missing/,
    );
  });
  test('a revalidation without a reason is an error', async () => {
    const { e } = outcome();
    await expect(
      markFixedOutcome(rec(), 'crq-j1', merge, 'u', obj({ fixed_revalidation: {} }), e),
    ).rejects.toThrow(/no reason/);
  });
});

function feedback(
  over: Partial<SourcePublishEffects> & {
    journal?: JsonObject | null;
    threads?: Record<string, SourceThread>;
    comments?: Set<string>;
    jobs?: Record<string, Record<string, unknown>>;
  } = {},
): { e: SourcePublishEffects; log: string[] } {
  const log: string[] = [];
  const { journal = null, threads = {}, comments = new Set<string>(), jobs = {}, ...rest } = over;
  const e: SourcePublishEffects = {
    canonical: {
      readJob: async (id) => obj({ job: id, canonical_finding_id: FINDING }),
      triageExists: async () => true,
      currentFixedEvent: async () => 'ev-1',
      isAncestor: async () => true,
    },
    evidence: {
      git: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
      readJob: async (id) => obj({ job: id, item: ctx.itemId, run: ctx.run, finding: {} }),
      readTriage: async () => null,
      resolveTarget: async () => 'd'.repeat(40),
      ensureCommit: async () => true,
    },
    git: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
    readSavedJournal: async () => journal,
    prInfo: async () => info(),
    readJob: async (id) => obj({ job: id, pr: 7, ...jobs[id] }),
    writeJournal: async (first, p) => {
      log.push(`journal:${first}:${JSON.stringify(plain(p.get('source_resolutions')))}`);
    },
    hasSourceComment: async (_pr, marker) => comments.has(marker),
    postSourceComment: async (_f, id) => {
      log.push(`comment:${id}`);
    },
    sourceThread: async (job) => threads[job.get('job') as string] ?? { kind: 'none' },
    resolveSourceThread: async (_f, id, thread) => {
      log.push(`resolve:${id}:${thread}`);
      return true;
    },
    ...rest,
  };
  return { e, log };
}
const info = (): JsonObject =>
  obj({ number: 42, state: 'MERGED', headRefOid: published, mergeCommit: { oid: merge } });
const plainProof = { proof: obj({ published_head: published }), projected: false };

describe('publishSource', () => {
  test('comments, resolves the thread and journals each FIXED job', async () => {
    const { e, log } = feedback({ threads: { 'crq-j1': { kind: 'found', id: 'T1' } } });
    const out = await publishSource(ctx, rec(), info(), plainProof, merge, e);
    expect(out.pending).toBe(false);
    expect(log).toEqual(['comment:crq-j1', 'resolve:crq-j1:T1', 'journal:crq-j1:["crq-j1"]']);
    expect(plain((out.publication as JsonObject).get('source_resolutions'))).toEqual(['crq-j1']);
  });
  test('an existing comment is not posted again', async () => {
    const { e, log } = feedback({ comments: new Set(['<!-- crq-repair-source:crq-j1 -->']) });
    await publishSource(ctx, rec(), info(), plainProof, merge, e);
    expect(log).toEqual(['journal:crq-j1:["crq-j1"]']);
  });
  test('a threadless job (no source PR) is skipped, not journalled', async () => {
    const { e, log } = feedback({ jobs: { 'crq-j1': { pr: null } } });
    const out = await publishSource(ctx, rec(), info(), plainProof, merge, e);
    expect(log).toEqual([]);
    expect(out.pending).toBe(false);
    expect(plain((out.publication as JsonObject).get('source_resolutions'))).toEqual([]);
  });
  test('a job already in the journal is skipped', async () => {
    const r = rec();
    const done = obj({
      ...(plain(r) as object),
      publication: { ...(plain(r.get('publication')) as object), source_resolutions: ['crq-j1'] },
    });
    const { e, log } = feedback();
    await publishSource(ctx, done, info(), plainProof, merge, e);
    expect(log).toEqual([]);
  });
  test('a lagging GraphQL thread is pending and not journalled, and later jobs still run', async () => {
    const two = rec({
      jobs: ['crq-j1', 'crq-j2'],
      verdicts: [
        { job: 'crq-j1', verdict: 'FIXED' },
        { job: 'crq-j2', verdict: 'FIXED' },
      ],
    });
    const { e, log } = feedback({ threads: { 'crq-j1': { kind: 'pending' } } });
    const out = await publishSource(ctx, two, info(), plainProof, merge, e);
    expect(out.pending).toBe(true);
    expect(log).toEqual(['comment:crq-j1', 'comment:crq-j2', 'journal:crq-j1:["crq-j2"]']);
  });
  test('an unconfirmed resolution carries the publication latched so far', async () => {
    const two = rec({
      jobs: ['crq-j1', 'crq-j2'],
      verdicts: [
        { job: 'crq-j1', verdict: 'FIXED' },
        { job: 'crq-j2', verdict: 'FIXED' },
      ],
    });
    const { e } = feedback({
      threads: { 'crq-j2': { kind: 'found', id: 'T2' } },
      resolveSourceThread: async () => false,
    });
    const error: unknown = await publishSource(ctx, two, info(), plainProof, merge, e).catch(
      (x: unknown) => x,
    );
    if (!(error instanceof SourcePublicationFailed)) throw new Error('wrong error');
    expect(error.message).toBe('source thread resolution unconfirmed');
    expect(plain((error.publication as JsonObject).get('source_resolutions'))).toEqual(['crq-j1']);
  });
  test('no publication means nothing to publish', async () => {
    const { e, log } = feedback();
    const out = await publishSource(ctx, rec({ publication: null }), info(), plainProof, merge, e);
    expect(out).toEqual({ pending: false });
    expect(log).toEqual([]);
  });
  test('a projected proof that changed is refused before any feedback', async () => {
    const { e, log } = feedback({
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: FINDING }),
        triageExists: async () => true,
        currentFixedEvent: async () => 'ev-2',
        isAncestor: async () => true,
      },
    });
    const proof = {
      projected: true,
      proof: obj({
        published_head: published,
        actual_head: published,
        canonical_fixed_events: { 'crq-j1': 'ev-1' },
      }),
    };
    await expect(publishSource(ctx, rec(), info(), proof, merge, e)).rejects.toThrow(
      /canonical fixed finding changed before source feedback/,
    );
    expect(log).toEqual([]);
  });
  test('a projected proof that still holds publishes', async () => {
    const { e, log } = feedback();
    const proof = {
      projected: true,
      proof: obj({
        published_head: published,
        actual_head: published,
        canonical_fixed_events: { 'crq-j1': 'ev-1' },
      }),
    };
    await publishSource(ctx, rec(), info(), proof, merge, e);
    expect(log).toContain('comment:crq-j1');
  });
});

describe('publishSource revalidation', () => {
  const evidence = { reason: 'r' };
  const proof = { proof: obj({ fixed_revalidation: evidence }), projected: false };
  const journal = (extra: Record<string, unknown> = {}): JsonObject =>
    obj({
      head: published,
      commits: [published],
      target: 't',
      branch: 'b',
      open_pr: 7,
      source_resolutions: ['crq-j0'],
      fixed_revalidation: evidence,
      ...extra,
    });
  const withEvidence = (): JsonObject =>
    rec({
      publication: {
        head: published,
        commits: [published],
        target: 't',
        branch: 'b',
        open_pr: 7,
        source_resolutions: [],
        fixed_revalidation: evidence,
      },
    });

  test('with no terminal truth the revalidation is re-validated against the fresh PR', async () => {
    const calls: string[] = [];
    const { e, log } = feedback({
      journal: journal(),
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: FINDING }),
        triageExists: async () => true,
        currentFixedEvent: async () => null,
        isAncestor: async () => true,
      },
      prInfo: async (n) => {
        calls.push(JSON.stringify(plain(n)));
        return info();
      },
    });
    const out = await publishSource(ctx, withEvidence(), info(), proof, merge, e).catch(
      (x: unknown) => x,
    );
    // The fixture evidence is not a real revalidation, so validation refuses it, and
    // that refusal is a plain error: nothing is latched and no feedback went out.
    expect(calls).toEqual(['42']);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBeInstanceOf(SourcePublicationFailed);
    expect(log).toEqual([]);
  });
  test('a journal whose revalidation changed is refused', async () => {
    const { e } = feedback({ journal: journal({ fixed_revalidation: { reason: 'other' } }) });
    await expect(publishSource(ctx, withEvidence(), info(), proof, merge, e)).rejects.toThrow(
      /fixed revalidation changed before source feedback/,
    );
  });
  test('a missing journal is refused', async () => {
    const { e } = feedback({ journal: null });
    await expect(publishSource(ctx, withEvidence(), info(), proof, merge, e)).rejects.toThrow(
      /publication journal missing/,
    );
  });
  test('terminal truth with a changed PR is refused', async () => {
    const { e } = feedback({
      journal: journal(),
      prInfo: async () => obj({ number: 42, state: 'MERGED', headRefOid: 'e'.repeat(40) }),
    });
    await expect(publishSource(ctx, withEvidence(), info(), proof, merge, e)).rejects.toThrow(
      /repair PR changed during revalidation/,
    );
  });
  test('terminal truth with an unchanged PR adopts the journal publication', async () => {
    const { e, log } = feedback({
      journal: journal(),
      jobs: { 'crq-j1': { pr: null } },
    });
    // Canonical rows exist, so terminal is non-null and no revalidation is re-validated.
    const out = await publishSource(ctx, withEvidence(), info(), proof, merge, e);
    expect(plain((out.publication as JsonObject).get('source_resolutions'))).toEqual(['crq-j0']);
    expect(log).toEqual([]);
  });
});
