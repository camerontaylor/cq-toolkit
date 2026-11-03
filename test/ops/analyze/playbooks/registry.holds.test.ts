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
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  FIXTURE,
  approvedAuthority,
  dispatchEvidence,
  harness,
  playbookOf,
} from './registry.helpers.js';
import type { Harness } from './registry.helpers.js';

describe('workspace holds after a stranded rollback', () => {
  test('an engine partial write with a failed restore blocks redispatch with fresh approval', async () => {
    const h = harness(FIXTURE, 0);
    let writes = 0;
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => ({
        ...h.store,
        writeBytes: async (file, bytes) => {
          if (writes++ === 0) await h.store.writeBytes(file, bytes);
          throw new Error('offline simulated write/restore fault');
        },
      }),
      approval: approvedAuthority().authority,
    });
    const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] };
    const first = await dispatch(input);
    expect(first.status).toBe('failed');
    expect(writes).toBeGreaterThan(1);
    expect(h.store.backing.get('src/a.ts')).not.toBe(FIXTURE['src/a.ts']);
    expect(h.run.verifierCalls).toHaveLength(0);
    expect(h.quarantine.records()).toEqual([]);
    const retry = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: approvedAuthority().authority,
    });
    const scans = h.run.scans.length;
    expect((await retry(input)).status).toBe('needs-human');
    expect(h.run.scans).toHaveLength(scans);
    h.store.backing.set('src/a.ts', FIXTURE['src/a.ts']);
    expect((await retry(input)).status).toBe('ok');
    expect(h.run.verifierCalls).toHaveLength(1);
  });

  for (const exitCode of [null, 1]) {
    test(`verifier exit ${String(exitCode)} holds all playbooks until every stranded file is repaired`, async () => {
      const files = { ...FIXTURE, 'src/b.ts': 'const b = foo_bar;\n' };
      let landConcurrentWrite = true;
      let h: Harness;
      h = harness(files, exitCode, '', playbookOf(), () => {
        if (!landConcurrentWrite) return;
        h.store.backing.set('src/a.ts', 'const x = foo_bar; // concurrent edit\n');
        h.store.backing.set('src/b.ts', 'const b = foo_bar; // concurrent edit\n');
      });
      const input = { playbookId: 'fix-foo-bar', dir: '/ws', targets: Object.keys(files) };
      const first = await h.dispatch(input);
      expect(first.status).toBe(exitCode === null ? 'indeterminate' : 'failed');
      if (first.status !== 'indeterminate' && first.status !== 'failed') return;
      const evidence = dispatchEvidence(first.status === 'failed' ? first.error : first.detail);
      expect(evidence.restore.stranded.map(({ file }) => file)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(h.quarantine.isQuarantined(input.playbookId)).toBe(exitCode === 1);

      // A fresh factory and approval must still refuse; neither a spent nonce
      // nor playbook quarantine may be what prevents the second mutation.
      h.playbooks.register({ ...playbookOf(), id: 'other-playbook' });
      const dispatch = makePlaybookDispatchOp({
        playbooks: h.playbooks,
        quarantine: h.quarantine,
        run: h.run,
        storeFor: () => h.store,
        approval: approvedAuthority().authority,
      });
      const retry = { ...input, playbookId: 'other-playbook' };
      const scans = h.run.scans.length;
      const dirtyBytes = h.store.backing.get('src/a.ts');
      const blocked = await dispatch({ ...retry, dir: '/ws/./' });
      expect(blocked.status).toBe('needs-human');
      if (blocked.status === 'needs-human') expect(blocked.reason).toContain('stranded rollback');
      expect(h.run.scans).toHaveLength(scans);
      expect(h.run.verifierCalls).toHaveLength(1);
      expect(h.store.backing.get('src/a.ts')).toBe(dirtyBytes);

      // Read failures retain the hold, and retrying with no targets cannot
      // evade the outstanding file obligation.
      h.store.backing.delete('src/a.ts');
      expect((await dispatch({ ...retry, targets: [] })).status).toBe('needs-human');
      expect(h.run.scans).toHaveLength(scans);
      h.store.backing.set('src/a.ts', FIXTURE['src/a.ts']);
      expect((await dispatch(retry)).status).toBe('needs-human');
      expect(h.run.scans).toHaveLength(scans);
      h.store.backing.set('src/b.ts', files['src/b.ts']);
      landConcurrentWrite = false;
      h.setVerifierExit(0);
      expect(await dispatch(retry)).toMatchObject({ status: 'ok' });
      expect(h.run.scans.length).toBeGreaterThan(scans);
      expect(h.run.verifierCalls).toHaveLength(2);
      expect(h.quarantine.isQuarantined('other-playbook')).toBe(false);
    });
  }
});
