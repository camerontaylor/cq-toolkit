import { describe, expect, test } from 'vitest';
import { observeOpenPrs } from '../../src/selfhost/merge-recheck.js';
import { readSettleState } from '../../src/selfhost/state-branch.js';
import {
  LATER,
  SHA_A,
  T0,
  flagValue,
  forgeDeps,
  makeForge,
  okRes,
  prSpec,
  seedObservation,
} from './merge-recheck.helpers.js';

describe('observeOpenPrs', () => {
  test('isolates a failing PR, prunes closed PRs, and writes once', async () => {
    const forge = makeForge({ 1: prSpec(), 2: prSpec({ head: SHA_A }), 3: prSpec() });
    await seedObservation(forge, [1, 2, 3]);
    // PR 3 closed (dropped from the open list); PR 2's read now fails.
    forge.hook = (args) =>
      args[1] === 'graphql' && flagValue(args, 'pr') === '2'
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    forge.prs.set(4, prSpec({ state: 'CLOSED' }));
    forge.log.length = 0;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1, 2, 4]);
    expect(result.observed).toEqual([1]);
    expect(result.skipped).toEqual([
      { pr: 2, reason: 'fetch failed: gh exit 1: gh: Server Error (HTTP 502)' },
      { pr: 4, reason: 'not open' },
    ]);
    expect(result.write?.ok).toBe(true);
    expect(forge.log.filter((entry) => entry.startsWith('state:PATCH'))).toHaveLength(1);
    const { state } = await readSettleState(forgeDeps(forge));
    expect(Object.keys(state.prs).sort()).toEqual(['1', '2']);
    // PR 1's same-tuple observation is NOT appended (the prune alone made
    // the write material); the T0 anchor stands.
    expect(state.prs['1']?.observations).toEqual([
      { observedAt: new Date(T0).toISOString(), by: 'self-merge-prs:observe' },
    ]);
  });

  test('a pass with only same-tuple observations makes NO state-branch write', async () => {
    const forge = makeForge({ 1: prSpec(), 2: prSpec({ head: SHA_A }) });
    await seedObservation(forge, [1, 2]);
    forge.log.length = 0;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1, 2]);
    expect(result).toEqual({ observed: [1, 2], skipped: [], discarded: [], write: null });
    expect(forge.log.filter((entry) => /^state:(POST|PATCH)/.test(entry))).toEqual([]);
  });

  test('a moved head resets its record and is written; discarded reasons surface', async () => {
    const forge = makeForge({ 1: prSpec() });
    await seedObservation(forge, [1]);
    forge.prs.set(1, prSpec({ head: SHA_A }));
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1]);
    expect(result.write?.ok).toBe(true);
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['1']?.tuple.head).toBe(SHA_A);
    expect(state.prs['1']?.observations).toHaveLength(1);

    // A foreign ledger is discarded on read; the reason rides the result.
    const foreign = makeForge({ 1: prSpec() });
    foreign.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? okRes({ object: { sha: 'e'.repeat(40) } })
        : (args[1] ?? '').includes('contents/')
          ? okRes({ encoding: 'base64', content: Buffer.from('{"version":9}').toString('base64') })
          : undefined;
    const discardedRun = await observeOpenPrs({ ...forgeDeps(foreign), nowMs: () => T0 }, [1]);
    expect(discardedRun.discarded).toEqual(['settle state version 9 is not 1']);
  });

  test('a state-branch read failure is reported, never thrown; empty input writes nothing', async () => {
    const forge = makeForge({ 1: prSpec() });
    forge.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, [1]);
    expect(result.observed).toEqual([]);
    expect(result.write).toMatchObject({ ok: false });
    expect(await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, [])).toEqual({
      observed: [],
      skipped: [],
      discarded: [],
      write: null,
    });
  });
});
