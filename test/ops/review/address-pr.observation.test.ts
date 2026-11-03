// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its composition base-witness and observation-stream tests.
// The shared phase-one orchestration world lives in address-pr.helpers.ts.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readObservations } from '../../../src/kernel/observation.js';
import { initial, world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test('PR composition never records the coordination checkout HEAD as its base', async () => {
    const w = await world();
    try {
      const result = await w.run();
      const report = result.status === 'ok' ? result.value : result.report!;
      // P3-5: without a caller-asserted PR head there is no witnessable base,
      // so the surface records null/unavailable — never the coordination
      // checkout's HEAD (a different repository state this run never starts
      // from).
      expect(report.observation?.baseSha).toBeNull();
      expect(report.observation?.persistence).toBe('unavailable');
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).toContain('base witness unavailable');
      // A null base has no schema-valid composition header: no stream opens.
      await expect(lstat(join(w.root, 'journal', 'observations'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await w.cleanup();
    }
  });

  test('a verified caller-asserted PR head becomes the base and opens exactly one stream', async () => {
    // (a) The verified-OID branch: `git rev-parse --verify <oid>^{commit}`
    // confirms the caller-asserted head, so the composition records it as
    // the base witness AND — because a real SHA makes the header schema
    // valid — opens the one stream a whole run (rounds and plans included)
    // shares.
    const w = await world(false, { expectedHead: initial });
    try {
      const result = await w.run();
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.observation?.baseSha).toBe(initial);
      expect(report.observation?.persistence).toBe('durable');
      expect(report.observation?.status).toBe('durable');
      const streams = await readObservations(join(w.root, 'journal'));
      expect(streams).toHaveLength(1);
      expect(streams[0]?.events[0]?.type).toBe('composition-started');
    } finally {
      await w.cleanup();
    }
  });

  test('an unverifiable caller-asserted head opens no stream and leaves the verdict unchanged', async () => {
    // (b) The unknown-OID branch: the clone names the asserted head but does
    // not contain its object, so the witness probe fails while every string
    // path (admission, worktree guard) still agrees. The surface records
    // null/unavailable/indeterminate, no stream opens, and — because an
    // observation PRE-FLIGHT failure never decides the run — the verdict is
    // exactly the one the same world reaches with no asserted head at all.
    const unknown = 'e'.repeat(40);
    const control = await world();
    const w = await world(false, { expectedHead: unknown, missingHeadObject: true });
    try {
      const expected = await control.run();
      const result = await w.run();
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.observation?.baseSha).toBeNull();
      expect(report.observation?.persistence).toBe('unavailable');
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).toContain('base witness unavailable');
      expect(await readObservations(join(w.root, 'journal'))).toHaveLength(0);
      expect(result.status).toBe(expected.status);
      const controlReport = expected.status === 'ok' ? expected.value : expected.report!;
      expect(report.findings.map((finding) => finding.status)).toEqual(
        controlReport.findings.map((finding) => finding.status),
      );
    } finally {
      await w.cleanup();
      await control.cleanup();
    }
  });
});
