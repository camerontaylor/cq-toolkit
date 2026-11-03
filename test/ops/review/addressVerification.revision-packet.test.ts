// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import { CHECK_ORDER, HEAD, makePacket, namesOf } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('unpinned revision identity yields uncertain', () => {
    const shortHead = makePacket();
    (shortHead.metadata as { revision: { head: string } }).revision.head = 'deadbeef';
    const short = verifyClosureEvidence(shortHead);
    expect(short.verdict).toBe('uncertain');
    expect(short.reason).toBe('unpinned-revision');
    expect(namesOf(short)).toEqual(CHECK_ORDER.slice(0, 2));

    const identical = verifyClosureEvidence(
      makePacket({ metadata: { revision: { head: HEAD, parent: HEAD } } }),
    );
    expect(identical.verdict).toBe('uncertain');
    expect(identical.reason).toBe('unpinned-revision');
  });

  test('missing revision metadata is unavailable evidence at packet-complete', () => {
    const packet = makePacket();
    (packet.metadata as { revision?: unknown }).revision = undefined;
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.revision).toBeUndefined();
  });

  test('malformed packet fields stop at packet-complete', () => {
    const packet = makePacket();
    delete (packet as { task?: string }).task;
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('task missing');
  });
});
