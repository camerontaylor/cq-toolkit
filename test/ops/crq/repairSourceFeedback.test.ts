import { describe, expect, test } from 'vitest';
import { findingDigest } from '../../../src/policy/crq/repairBinding.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  publishRepairSourceFeedback,
  recordFixedRevalidation,
  type RepairSourceFeedbackEffects,
  type RepairSourceFeedbackInput,
} from '../../../src/ops/crq/internal/repairSourceFeedback.js';

const merge = 'a'.repeat(40),
  published = 'b'.repeat(40),
  actual = 'c'.repeat(40),
  target = 'd'.repeat(40);
function object(value: unknown): JsonObject {
  const v = parseJsonValue(JSON.stringify(value));
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
function fixture(): {
  input: RepairSourceFeedbackInput;
  effects: RepairSourceFeedbackEffects;
  calls: string[];
} {
  const calls: string[] = [];
  const pr = object({
    number: 42,
    state: 'MERGED',
    headRefOid: actual,
    mergeCommit: { oid: merge },
  });
  const publication = {
    identity: object({ head: published, commits: [published], target, branch: 'fix', open_pr: 42 }),
    sourceResolutions: [] as string[],
  };
  const job = object({
    job: 'crq-job-1',
    item: 'item-1',
    run: 'run-1',
    pr: 12,
    finding: { path: 'src/a.ts' },
  });
  const input: RepairSourceFeedbackInput = {
    jobs: [{ id: 'crq-job-1', job, sourcePr: 12 }],
    itemId: 'item-1',
    state: 'published',
    fixMerged: false,
    run: 'run-1',
    merge,
    target,
    prNumber: pr.get('number')!,
    pr,
    publication,
    mergeHead: { published, actual, commits: [published], anchors: ['src/a.ts'] },
  };
  const effects: RepairSourceFeedbackEffects = {
    git: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
    currentFixedEvent: async () => {
      calls.push('event');
      return 'event-1';
    },
    readPr: async () => {
      calls.push('pr');
      return pr;
    },
    readJournal: async () => {
      calls.push('journal');
      return publication;
    },
    readJob: async () => job,
    readTriage: async () => null,
    resolveTarget: async () => target,
    ensureCommit: async () => true,
    markFixed: async () => {
      calls.push('mark');
    },
    writeJournal: async () => {
      calls.push('write');
    },
    hasSourceComment: async () => {
      calls.push('has');
      return false;
    },
    postSourceComment: async () => {
      calls.push('post');
    },
    sourceThread: async () => {
      calls.push('thread');
      return { kind: 'found', id: 'thread' };
    },
    resolveSourceThread: async () => {
      calls.push('resolve');
      return true;
    },
  };
  return { input, effects, calls };
}
describe('proof-gated source feedback', () => {
  test('rechecks terminal truth before feedback without creating an outcome', async () => {
    const { input, effects, calls } = fixture();
    expect((await publishRepairSourceFeedback(input, effects)).kind).toBe('complete');
    expect(calls).toEqual([
      'event',
      'journal',
      'event',
      'has',
      'post',
      'thread',
      'resolve',
      'write',
    ]);
  });
  test('refuses a changed terminal event before any source effect', async () => {
    const { input, effects, calls } = fixture();
    let count = 0;
    effects.currentFixedEvent = async () => (++count === 1 ? 'old' : 'new');
    await expect(publishRepairSourceFeedback(input, effects)).rejects.toThrow(
      'changed before source feedback',
    );
    expect(calls).not.toContain('post');
    expect(calls).not.toContain('write');
  });
  test('revalidates the journal and PR before outcome and feedback', async () => {
    const f = fixture();
    const evidence: JsonValue = object({
      job: 'crq-job-1',
      item: 'item-1',
      run: 'run-1',
      finding_sha256: findingDigest(f.input.jobs[0]!.job.get('finding')!),
      pr: 42,
      published_head: published,
      actual_head: actual,
      merge_commit: merge,
      source_sha: target,
      sources: { 'src/a.ts': { published: null, actual: null, current: null } },
      verdict: 'fixed',
      reviewer: 'reviewer',
      reason: 'revalidated: fixed',
    });
    const publication = { ...f.input.publication, fixedRevalidation: evidence };
    const input = { ...f.input, publication };
    f.effects.currentFixedEvent = async () => null;
    f.effects.readJournal = async () => {
      f.calls.push('journal');
      return publication;
    };
    f.effects.readPr = async () =>
      object({
        number: 42,
        state: 'MERGED',
        headRefOid: 'e'.repeat(40),
        mergeCommit: { oid: merge },
      });
    await expect(publishRepairSourceFeedback(input, f.effects)).rejects.toThrow('PR changed');
    expect(f.calls).not.toContain('mark');
    expect(f.calls).not.toContain('post');
  });
  test('reobserves semantic proof and checks terminal truth after marking fixed', async () => {
    const f = fixture();
    const evidence = object({
      job: 'crq-job-1',
      item: 'item-1',
      run: 'run-1',
      finding_sha256: findingDigest(f.input.jobs[0]!.job.get('finding')!),
      pr: 42,
      published_head: published,
      actual_head: actual,
      merge_commit: merge,
      source_sha: target,
      sources: { 'src/a.ts': { published: null, actual: null, current: null } },
      verdict: 'fixed',
      reviewer: 'reviewer',
      reason: 'revalidated: fixed',
    });
    const publication = { ...f.input.publication, fixedRevalidation: evidence };
    let marked = false;
    f.effects.currentFixedEvent = async () => (marked ? 'terminal' : null);
    f.effects.markFixed = async () => {
      marked = true;
      f.calls.push('mark');
    };
    f.effects.readJournal = async () => {
      f.calls.push('journal');
      return publication;
    };
    const result = await publishRepairSourceFeedback({ ...f.input, publication }, f.effects);
    expect(result.kind).toBe('complete');
    expect(f.calls.filter((v) => v === 'journal')).toHaveLength(3);
    expect(f.calls.filter((v) => v === 'pr')).toHaveLength(2);
    expect(f.calls.indexOf('mark')).toBeLessThan(f.calls.indexOf('post'));
  });
  test('refuses stale semantic source evidence before outcome', async () => {
    const f = fixture();
    const evidence = object({
      job: 'crq-job-1',
      item: 'item-1',
      run: 'run-1',
      finding_sha256: findingDigest(f.input.jobs[0]!.job.get('finding')!),
      pr: 42,
      published_head: published,
      actual_head: actual,
      merge_commit: merge,
      source_sha: 'e'.repeat(40),
      sources: { 'src/a.ts': { published: null, actual: null, current: null } },
      verdict: 'fixed',
      reviewer: 'reviewer',
      reason: 'revalidated: fixed',
    });
    const publication = { ...f.input.publication, fixedRevalidation: evidence };
    f.effects.currentFixedEvent = async () => null;
    f.effects.readJournal = async () => publication;
    await expect(
      publishRepairSourceFeedback({ ...f.input, publication }, f.effects),
    ).rejects.toThrow('binding changed');
    expect(f.calls).not.toContain('mark');
    expect(f.calls).not.toContain('post');
  });
  test('leaves REST-visible source thread pending without journaling completion', async () => {
    const f = fixture();
    f.effects.sourceThread = async () => ({ kind: 'pending' });
    expect((await publishRepairSourceFeedback(f.input, f.effects)).kind).toBe('pending');
    expect(f.calls).toContain('post');
    expect(f.calls).not.toContain('write');
  });
  test('a pending source thread does not block resolving later jobs', async () => {
    const f = fixture();
    const second = object({
      job: 'crq-job-2',
      item: 'item-1',
      run: 'run-1',
      pr: 13,
      finding: { path: 'src/a.ts' },
    });
    const input = {
      ...f.input,
      jobs: [...f.input.jobs, { id: 'crq-job-2', job: second, sourcePr: 13 }],
    };
    const readFirst = f.effects.readJob;
    f.effects.readJob = async (id) => (id === 'crq-job-2' ? second : readFirst(id));
    const resolved: string[] = [];
    const written: string[][] = [];
    f.effects.sourceThread = async (job) =>
      job.get('job') === 'crq-job-1' ? { kind: 'pending' } : { kind: 'found', id: 'thread-2' };
    f.effects.resolveSourceThread = async (id) => {
      resolved.push(id);
      return true;
    };
    f.effects.writeJournal = async (p) => {
      written.push([...p.sourceResolutions]);
    };
    const result = await publishRepairSourceFeedback(input, f.effects);
    expect(result.kind).toBe('pending');
    expect(resolved).toEqual(['thread-2']);
    expect(written).toEqual([['crq-job-2']]);
    if (result.kind === 'pending')
      expect(result.publication.sourceResolutions).toEqual(['crq-job-2']);
  });
  test('refuses a journal identity change and a merge outside target', async () => {
    const f = fixture();
    f.effects.readJournal = async () => ({
      ...f.input.publication,
      identity: object({ head: 'changed' }),
    });
    await expect(publishRepairSourceFeedback(f.input, f.effects)).rejects.toThrow(
      'journal identity',
    );
    const g = fixture();
    const effects: RepairSourceFeedbackEffects = {
      ...g.effects,
      git: async (args) => ({ args, code: 1, stdout: new Uint8Array(), stderr: '' }),
    };
    await expect(publishRepairSourceFeedback(g.input, effects)).rejects.toThrow('not in target');
  });
});

describe('record fixed revalidation', () => {
  test('writes only after semantic validation and two matching PR reads', async () => {
    const f = fixture();
    const evidence = object({
      job: 'crq-job-1',
      item: 'item-1',
      run: 'run-1',
      finding_sha256: findingDigest(f.input.jobs[0]!.job.get('finding')!),
      pr: 42,
      published_head: published,
      actual_head: actual,
      merge_commit: merge,
      source_sha: target,
      sources: { 'src/a.ts': { published: null, actual: null, current: null } },
      verdict: 'fixed',
      reviewer: 'reviewer',
      reason: 'verified',
    });
    const saved = await recordFixedRevalidation(f.input, evidence, f.effects);
    expect(saved.fixedRevalidation).toBe(evidence);
    expect(f.calls).toEqual(['journal', 'pr', 'pr', 'journal', 'write']);
    const g = fixture();
    let reads = 0;
    g.effects.readPr = async () =>
      ++reads === 1 ? g.input.pr : object({ number: 42, state: 'CLOSED' });
    await expect(recordFixedRevalidation(g.input, evidence, g.effects)).rejects.toThrow(
      'PR changed',
    );
    expect(g.calls).not.toContain('write');
  });
});
