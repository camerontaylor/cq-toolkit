// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: the ExercisedScope
// capability is a real runtime capability.

import { describe, expect, test } from 'vitest';
import type { ExercisedScope } from '../../../src/ops/analyze/approval.js';
import {
  canonicalWorkspace,
  isExercisedScope,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import { grantingAuthority, OP, WORKSPACE } from './approvalFixtures.js';

// D1 (delta review): the scope brand is a RUNTIME symbol. `declare const
// ... : unique symbol` type-checked, emitted no binding, and threw
// `ReferenceError` at the mint — so every approved mutation would have
// faulted, and `tsc` said nothing. These pin that the brand and the live
// lifetime are real at runtime, not merely in the type system.
describe('the ExercisedScope capability is a real runtime capability', () => {
  test('a scope minted inside an approved mutation is LIVE and branded', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let seen: unknown;
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        seen = scope;
        // Liveness at the moment of use — this is the check that a
        // `declare const` brand would have made unreachable.
        expect(isExercisedScope(scope)).toBe(true);
        return 'written';
      },
    );
    expect(outcome.status).toBe('ok');
    // ...and NOT live once the section has settled and the lock released.
    expect(isExercisedScope(seen)).toBe(false);
  });

  test('a RETAINED scope is refused after its section ends — the brand outlives it, liveness does not', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let retained: unknown;
    await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        retained = scope;
        return 'written';
      },
    );
    // The brand still says "real scope"; only liveness has expired. A
    // brand-only check would happily honor this stale capability forever.
    expect(isExercisedScope(retained)).toBe(false);
  });

  test('a scope is RETIRED even when the write throws, so a failed section leaks no capability', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let captured: unknown;
    // The fault PROPAGATES out of withApprovedMutation (the lock is released
    // on the way out), so the assertion is on the promise, not on an awaited
    // result: awaiting first would throw here and never reach the retirement
    // check that is the actual subject of the test.
    await expect(
      withApprovedMutation(fixture.authority, fixture.subjectOf(['src/a.ts']), async (scope) => {
        captured = scope;
        throw new Error('the write faulted');
      }),
    ).rejects.toThrow('the write faulted');
    // ... and the scope captured on the way out is already dead.
    expect(isExercisedScope(captured)).toBe(false);
  });

  test('each section mints its OWN scope; a scope is never reused across sections', async () => {
    const minted: unknown[] = [];
    for (const attempt of [1, 2]) {
      // A DISTINCT subject per section, and therefore a distinct token. The
      // fixture's nonce is derived from the subject by design (ADR §5: one
      // token binds one op+inputs, and re-presenting it is the replay case),
      // so re-using one subject here would have the second section refused as
      // SPENT — the test would pass on the wrong count.
      const fixture = grantingAuthority({
        op: OP,
        workspace: WORKSPACE,
        targets: ['src/a.ts'],
        inputDigest: `sha256:section-${String(attempt)}`,
      });
      await withApprovedMutation(
        fixture.authority,
        fixture.subjectOf(['src/a.ts']),
        async (scope) => {
          minted.push(scope);
          return 'written';
        },
      );
    }
    expect(minted).toHaveLength(2);
    expect(minted[0]).not.toBe(minted[1]);
    for (const scope of minted) expect(isExercisedScope(scope)).toBe(false);
  });

  test('a scope carries the CANONICAL workspace and the approved targets it bounds', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let captured: ExercisedScope | undefined;
    await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        captured = scope;
        return 'written';
      },
    );
    // Captured before retirement, so these assert the mint's CONTENT.
    expect(captured?.op).toBe(OP);
    expect(captured?.targets).toEqual(['src/a.ts']);
    expect(captured?.workspace).toBe(canonicalWorkspace(WORKSPACE));
  });
});
