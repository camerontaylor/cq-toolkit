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
import { makePlaybookQuarantineListOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import { makeQuarantineLedger } from '../../../../src/adapters/store/quarantine.js';

describe('makePlaybookQuarantineListOp (the read-only lane view)', () => {
  test('lists the live records, sorted, and mutates nothing', async () => {
    const ledger = makeQuarantineLedger();
    ledger.quarantine('b-playbook', 'r2');
    ledger.quarantine('a-playbook', 'r1');
    const op = makePlaybookQuarantineListOp(ledger);
    const result = await op({});
    expect(result).toEqual({
      status: 'ok',
      value: {
        records: [
          { playbookId: 'a-playbook', phase: 'verifier-failed', reason: 'r1' },
          { playbookId: 'b-playbook', phase: 'verifier-failed', reason: 'r2' },
        ],
      },
    });
    expect(ledger.isQuarantined('a-playbook')).toBe(true);
  });
});
