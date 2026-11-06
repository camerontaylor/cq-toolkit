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
import { describe, expect, test, vi } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  FIXTURE,
  approvedAuthority,
  dispatchEvidence,
  harness,
  playbookOf,
} from './registry.helpers.js';
import type { Harness } from './registry.helpers.js';

describe('makePlaybookDispatchOp (the acceptance flow, fail-closed at every step)', () => {
  test('the preflight catches a scan fault BEFORE the spend: the dispatch fails with the token UNSPENT, and the SAME token then dispatches cleanly (the #258 owner ruling, option D)', async () => {
    const h = harness(FIXTURE, 0);
    const { authority, ledger } = approvedAuthority();
    // The first ast-grep scan answers GARBAGE (unparsable, exit 0): the
    // dry-run preflight refuses before the nonce is exercised, so only ONE
    // scan runs — the apply and the verifier never do.
    let scanMode: 'garbage' | 'healthy' = 'garbage';
    const inner = h.run;
    const flaky = Object.assign(
      async (cmd: Parameters<RunCheck>[0]): Promise<RawCheckOutput> => {
        if (cmd.command === 'ast-grep' && scanMode === 'garbage') {
          return { stdout: 'not json at all', stderr: '', exitCode: 0 };
        }
        return inner(cmd);
      },
      { scans: [], verifierCalls: [] },
    ) as Harness['run'];
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: flaky,
      storeFor: () => h.store,
      approval: authority,
    });
    const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] };
    const refused = await dispatch(input);
    // The engine-fault shape (`failed` — the playbook did not fail its
    // verifier), naming the preflight and the UNSPENT nonce.
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') {
      expect(refused.error).toContain('preflight');
      expect(refused.error).toContain('UNSPENT');
    }
    expect(h.run.verifierCalls).toHaveLength(0);
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(false);
    expect(h.store.backing.get('src/a.ts')).toBe(FIXTURE['src/a.ts']);
    // THE load-bearing assertion: the refused dispatch burned NOTHING, so
    // the same authority — the same token for the same subject — dispatches
    // cleanly once the scan is healthy.
    expect(ledger.spent()).toBe(0);
    scanMode = 'healthy';
    const retried = await dispatch(input);
    expect(retried.status).toBe('ok');
    expect(ledger.spent()).toBe(1);
  });

  test('a containment fault fails closed before any subprocess runs', async () => {
    const h = harness(FIXTURE, 0);
    const failing = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => {
        throw new AnalysisStoreError("analysis store: root does not resolve — '/missing'");
      },
      approval: approvedAuthority().authority,
    });
    const result = await failing({
      playbookId: 'fix-foo-bar',
      dir: '/missing',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('root does not resolve');
    }
    expect(h.run.scans).toEqual([]);
  });

  test('after an explicit unquarantine the playbook is dispatchable again (and only then)', async () => {
    const h = harness(FIXTURE, 1);
    // Each dispatch is a SEPARATE operator action and needs its OWN token.
    // The fixture derives a nonce from the subject by design (ADR §5: one
    // token binds one op+inputs, and re-presenting it is the replay case), so
    // re-using one authority across three dispatches would have #2 and #3
    // refused as SPENT — before the quarantine or the in-flight check — and
    // the test would prove nothing about the unquarantine. The registry (and
    // therefore the quarantine and in-flight state) is still shared.
    const dispatchFresh = () =>
      makePlaybookDispatchOp({
        playbooks: h.playbooks,
        quarantine: h.quarantine,
        run: h.run,
        storeFor: () => h.store,
        approval: approvedAuthority().authority,
      });
    const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] };
    await dispatchFresh()(input);
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(true);
    expect((await dispatchFresh()(input)).status).toBe('needs-human');
    // THE explicit consumer action — nothing in the codebase calls this.
    h.quarantine.unquarantine('fix-foo-bar');
    // The verifier now PASSES, so `ok` means what the test says it means: the
    // dispatch ran end to end. Before the W4.3 rollback fix, this assertion
    // passed only because the rollback left the applied bytes behind, so the
    // re-dispatch matched nothing and short-circuited — a green test resting
    // on a broken rollback.
    h.setVerifierExit(0);
    const again = await dispatchFresh()(input);
    expect(again.status).toBe('ok');
  });

  test('a duplicate dispatch of an IN-FLIGHT playbook is rejected immediately (needs-human, no engine, no verifier); after settle, a new dispatch proceeds through the quarantine check', async () => {
    const h = harness(FIXTURE, 1); // the verifier exits 1 → quarantine
    // Defer the FIRST dispatch's verifier: the gated runner parks every
    // non-ast-grep (verifier) command on `gate` until released.
    let releaseVerifier: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const gatedRun: RunCheck = async (cmd) => {
      if (cmd.command !== 'ast-grep') await gate;
      return h.run(cmd);
    };
    const serialized = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: gatedRun,
      storeFor: () => h.store,
      approval: approvedAuthority().authority,
    });
    const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] };
    // Both dispatches START concurrently; the first parks at the verifier.
    const first = serialized(input);
    const duplicate = serialized(input);
    // The duplicate is refused IMMEDIATELY — while the first is still
    // unsettled — WITHOUT running the engine or a verifier. (Queueing would
    // re-apply the rule once the in-flight dispatch PASSED; rejection is
    // unconditional.) One scan: only the in-flight dispatch's.
    const rejected = await duplicate;
    expect(rejected.status).toBe('needs-human');
    if (rejected.status === 'needs-human') {
      expect(rejected.reason).toContain('already in flight');
      expect(rejected.reason).toContain('re-apply the rule');
      expect(rejected.reason).toContain('re-dispatch deliberately');
    }
    // The duplicate invoked NO verifier: #1 is parked at the gate, and the
    // duplicate never reached one either.
    expect(h.run.verifierCalls).toHaveLength(0);
    // Settle the in-flight dispatch (fail → quarantine). Its slot frees,
    // and a NEW dispatch proceeds normally — through the quarantine check,
    // which now refuses on the RECORD (a different refusal than the
    // in-flight one).
    releaseVerifier?.();
    const firstResult = await first;
    // TWO scans for the whole pair — the in-flight dispatch's preflight and
    // its apply — counted only now that both have settled: the duplicate's
    // refusal resolves before #1 has necessarily reached its own scan (the
    // approval/lock boundary puts real awaits between the two dispatches),
    // so asserting exact counts at that earlier point would be measuring
    // scheduling order, not the duplicate's behaviour. The DUPLICATE
    // contributed neither: it was refused before the registry lookup.
    expect(h.run.scans).toHaveLength(2);
    expect(firstResult.status).toBe('failed');
    if (firstResult.status === 'failed') {
      expect(dispatchEvidence(firstResult.error).quarantined).toBe(true);
    }
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(true);
    expect(h.run.verifierCalls).toHaveLength(1); // only the in-flight dispatch's verifier ever ran
    const later = await serialized(input);
    expect(later.status).toBe('needs-human');
    if (later.status === 'needs-human') {
      expect(later.reason).toContain('never re-dispatched automatically');
    }
    expect(h.run.scans).toHaveLength(2);
  }, 15_000);

  test('DIFFERENT playbooks stay unserialized: B dispatches (engine runs) while A is in flight', async () => {
    const h = harness(FIXTURE, 0); // verifiers pass
    let releaseVerifier: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const gatedRun: RunCheck = async (cmd) => {
      if (cmd.command !== 'ast-grep') await gate;
      return h.run(cmd);
    };
    // A second playbook over the same fixture — a different id, so its
    // dispatch slot is its own.
    h.playbooks.register({
      ...playbookOf(),
      id: 'pb-second',
      rule: { id: 'fix-foo-bar-2', language: 'ts', rule: { pattern: 'foo_bar' }, fix: 'fooBar' },
    });
    const serialized = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: gatedRun,
      storeFor: () => h.store,
      approval: approvedAuthority().authority,
    });
    const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] };
    const a = serialized(input); // in flight (its verifier will park)
    const b = serialized({ ...input, playbookId: 'pb-second' });
    // Wait until B's engine has run — it must: different ids never block.
    // FOUR scans at the window: each dispatch runs its preflight and its
    // apply (2 × 2), both parked at their verifiers by the gate. Condition-
    // based rather than a fixed sleep, which could expire under CI load
    // before the four scans completed.
    await vi.waitFor(() => expect(h.run.scans).toHaveLength(4));
    releaseVerifier?.();
    expect((await a).status).toBe('ok');
    expect((await b).status).toBe('ok');
  }, 15_000);
});
