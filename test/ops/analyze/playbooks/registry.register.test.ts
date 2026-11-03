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
  makePlaybookRegisterOp,
  makePlaybookRegistry,
} from '../../../../src/ops/analyze/playbooks/registry.js';
import { playbookOf } from './registry.helpers.js';

describe('makePlaybookRegistry + makePlaybookRegisterOp (registration refuses duplicates)', () => {
  test('register/get/list; duplicates throw; list is sorted by id', () => {
    const playbooks = makePlaybookRegistry();
    playbooks.register(playbookOf());
    const second = { ...playbookOf(), id: 'aaa-first' };
    playbooks.register(second);
    expect(playbooks.get('fix-foo-bar')?.id).toBe('fix-foo-bar');
    expect(playbooks.get('nope')).toBeUndefined();
    expect(playbooks.list().map((entry) => entry.id)).toEqual(['aaa-first', 'fix-foo-bar']);
    expect(() => playbooks.register(playbookOf())).toThrow(RangeError);
  });

  test('the register op: ok with the new total; a duplicate is a failed refusal', async () => {
    const playbooks = makePlaybookRegistry();
    const op = makePlaybookRegisterOp(playbooks);
    expect(await op({ playbook: playbookOf() })).toEqual({
      status: 'ok',
      value: { id: 'fix-foo-bar', total: 1 },
    });
    const refused = await op({ playbook: playbookOf() });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') {
      expect(refused.error).toContain('already registered');
    }
  });
});
