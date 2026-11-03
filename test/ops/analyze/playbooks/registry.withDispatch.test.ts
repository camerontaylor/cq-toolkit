// Analyze lane G3 — test evidence for the playbook registry + dispatch:
// the acceptance flow end to end over INJECTED runners and stores (no
// ast-grep binary, no real fs). Pinned here: register refuses duplicates;
// an unknown id fails naming the population; a QUARANTINED playbook is
// refused before anything runs (needs-human — lifting is explicit); a
// verifier PASS verifies; a verifier FAIL writes the quarantine record and
// the dispatch honestly reports remediation-applied-but-verifier-failed;
// an INDETERMINATE verifier is honest indeterminate, quarantines NOTHING,
// and still returns the trace record; the engine's own faults (collision,
// containment) fail closed without touching the ledger.
//
// Split provenance: test/ops/analyze/playbooks/registry.test.ts was split into
// registry.register.test.ts, registry.dispatch.test.ts,
// registry.dispatch-faults.test.ts, registry.withDispatch.test.ts,
// registry.holds.test.ts, registry.hold-identity.test.ts,
// registry.quarantine-list.test.ts, registry.rollback.test.ts,
// registry.lock-fault.test.ts and registry.approved-apply.test.ts; shared
// fixtures live in registry.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  DispatchInFlightError,
  makePlaybookRegistry,
} from '../../../../src/ops/analyze/playbooks/registry.js';
import { DispatchInFlightError as PublicDispatchInFlightError } from '../../../../src/ops/analyze/playbooks/index.js';

describe('withDispatch (the direct SDK slot path)', () => {
  test('the public barrel exposes the same error class thrown by the registry', async () => {
    expect(PublicDispatchInFlightError).toBe(DispatchInFlightError);
    const registry = makePlaybookRegistry();
    await registry.withDispatch('pb', async () => {
      await expect(registry.withDispatch('pb', async () => 'duplicate')).rejects.toBeInstanceOf(
        PublicDispatchInFlightError,
      );
    });
  });
  test('the slot frees BEFORE the caller continuation: a sequential second dispatch never sees DispatchInFlightError', async () => {
    const playbooks = makePlaybookRegistry();
    // Await the FIRST promise, then dispatch again through the SAME
    // registry — the direct SDK shape (no op wrapper). Pre-fix, the
    // free-slot reaction lost the microtask race against the caller's
    // continuation and this second call threw DispatchInFlightError.
    const first = await playbooks.withDispatch('pb', async () => 'one');
    expect(first).toBe('one');
    const second = await playbooks.withDispatch('pb', async () => 'two');
    expect(second).toBe('two');
    // ...and a third, proving the slot keeps cycling.
    expect(await playbooks.withDispatch('pb', async () => 'three')).toBe('three');
  });

  test('the outcome and rejection ride verbatim; the slot frees after a rejection too', async () => {
    const playbooks = makePlaybookRegistry();
    const payload = { edits: 2 };
    expect(await playbooks.withDispatch('pb', async () => payload)).toBe(payload);
    await expect(
      playbooks.withDispatch('pb', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    // The rejection freed the slot: the next dispatch proceeds normally.
    expect(await playbooks.withDispatch('pb', async () => 'after-rejection')).toBe(
      'after-rejection',
    );
  });

  test('different ids stay independent slots', async () => {
    const playbooks = makePlaybookRegistry();
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = playbooks.withDispatch('a', () => gateA.then(() => 'a'));
    // B is a different id — it proceeds while A is parked in flight.
    const b = await playbooks.withDispatch('b', async () => 'b');
    expect(b).toBe('b');
    releaseA?.();
    expect(await a).toBe('a');
  });

  test('a task that SYNCHRONOUSLY re-enters withDispatch for its own id is refused in flight — the nested call never runs, the outer completes normally', async () => {
    const playbooks = makePlaybookRegistry();
    const nested: unknown[] = [];
    // The outer task re-enters for the SAME id BEFORE returning its
    // promise. Pre-fix the slot was installed only after task() returned,
    // so the nested dispatch double-ran and its slot overwrote the outer's.
    const outer = await playbooks.withDispatch('pb', () => {
      void playbooks
        .withDispatch('pb', async () => 'nested')
        .catch((err: unknown) => {
          nested.push(err);
        });
      return Promise.resolve('outer');
    });
    expect(outer).toBe('outer');
    expect(nested).toHaveLength(1);
    expect(nested[0]).toBeInstanceOf(DispatchInFlightError);
    // The slot freed with the outer: a follow-up dispatch proceeds.
    expect(await playbooks.withDispatch('pb', async () => 'after')).toBe('after');
  });
});
