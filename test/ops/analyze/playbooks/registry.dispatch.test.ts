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
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { Playbook } from '../../../../src/ops/analyze/playbooks/format.js';
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  FIXTURE,
  RULE,
  approvedAuthority,
  dispatchEvidence,
  harness,
  playbookOf,
} from './registry.helpers.js';
import type { Harness } from './registry.helpers.js';

describe('makePlaybookDispatchOp (the acceptance flow, fail-closed at every step)', () => {
  test('an unknown playbook id fails naming the registered population', async () => {
    const h = harness(FIXTURE, 0);
    const result = await h.dispatch({
      playbookId: 'ghost',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("unknown playbook id 'ghost'");
      expect(result.error).toContain('fix-foo-bar');
    }
    expect(h.run.scans).toEqual([]);
    expect(h.run.verifierCalls).toEqual([]);
  });

  test('a quarantined playbook is refused BEFORE anything runs (needs-human)', async () => {
    const h = harness(FIXTURE, 0);
    h.quarantine.quarantine('fix-foo-bar', 'earlier verifier failure');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('never re-dispatched automatically');
      expect(result.reason).toContain('earlier verifier failure');
      expect(result.reason).toContain('explicit consumer action');
    }
    expect(h.run.scans).toEqual([]);
    expect(h.run.verifierCalls).toEqual([]);
  });

  test('verifier PASS: ok/verified, the fix landed on disk, the trace record rides value.record', async () => {
    const h = harness(FIXTURE, 0);
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.outcome).toBe('verified');
    expect(result.value.plannedEdits).toBe(2);
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.digestAfter).toBeDefined();
    expect(h.store.backing.get('src/a.ts')).toBe('const x = fooBar;\nconst y = fooBar;\n');
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(false);
    expect(result.value.record).toEqual({
      kind: 'playbook-dispatch',
      playbookId: 'fix-foo-bar',
      targets: ['src/a.ts'],
      plannedEdits: 2,
      unfixedMatches: 0,
      files: [{ file: 'src/a.ts', edits: 2, digestAfter: result.value.files[0]?.digestAfter }],
      verifier: { verdict: 'pass', exitCode: 0 },
      outcome: 'verified',
      quarantined: false,
    });
    // The engine received the playbook's rule SERIALIZED (JSON is a valid
    // YAML form) and the verifier command crossed the runner with the
    // op-boundary cwd default (the authored command omits cwd — see
    // playbookOf — so the dispatch fills it with the analysis dir). TWO
    // scans per dispatch since the preflight (option D): the dry-run
    // preflight first, then the apply — the same rule text both times.
    expect(h.run.scans).toHaveLength(2);
    expect((h.run.scans[0] as { args: string[] }).args[3]).toBe(JSON.stringify(RULE));
    expect((h.run.scans[1] as { args: string[] }).args[3]).toBe(JSON.stringify(RULE));
    expect(h.run.verifierCalls).toEqual([
      { command: 'verify-tool', args: ['check'], timeoutMs: 30_000, cwd: '/ws' },
    ]);
  });

  test('authored-optional verifier command fields are DISPATCH-DEFAULTED at the op boundary (cwd → input.dir; timeoutMs → 600_000); authored values pass through verbatim', async () => {
    // The authored asset omits BOTH optional fields (the format's
    // library-level optionals) — the dispatch op must fill them: an
    // omitted cwd would inherit the DISPATCHING process's cwd (a vacuous
    // pass against the wrong tree) and an omitted timeoutMs would run
    // uncapped. The fake runner asserts exactly what it received.
    const omitted = harness(FIXTURE, 0, '', {
      ...playbookOf(),
      verifier: { command: { command: 'verify-tool', args: ['check'] } },
    });
    const result = await omitted.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('ok');
    expect(omitted.run.verifierCalls).toHaveLength(1);
    expect(omitted.run.verifierCalls[0]).toEqual({
      command: 'verify-tool',
      args: ['check'],
      timeoutMs: 600_000,
      cwd: '/ws',
    });
    // And AUTHORED values are never overridden — cwd and timeout pass
    // through verbatim.
    const explicit = harness(FIXTURE, 0, '', {
      ...playbookOf(),
      verifier: {
        command: { command: 'verify-tool', args: ['check'], cwd: 'authored/ws', timeoutMs: 30_000 },
      },
    });
    await explicit.dispatch({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] });
    expect(explicit.run.verifierCalls).toEqual([
      { command: 'verify-tool', args: ['check'], timeoutMs: 30_000, cwd: 'authored/ws' },
    ]);
  });

  test('SNAPSHOT discipline: a caller mutation AFTER register cannot change what a later dispatch executes', async () => {
    // The harness registers the CALLER's playbook object; mutating it (and
    // the registered handle) afterwards must not touch what dispatch runs —
    // the registry stores deep copies. The playbook's rule is a private
    // CLONE of RULE so the mutation below cannot leak into other tests.
    const playbook: Playbook = { ...playbookOf(), rule: structuredClone(RULE) };
    const originalRuleJson = JSON.stringify(RULE);
    const h = harness(FIXTURE, 0, '', playbook);
    (playbook.rule as { rule: { pattern: string } }).rule.pattern = 'mutated_never';
    (playbook.rule as { fix: string }).fix = 'mutatedNever';
    playbook.verifier.command.command = 'mutated-never';
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The engine scanned with the REGISTERED rule (the original pattern,
    // serialized verbatim), not the mutated one — on both scans of the
    // dispatch (preflight, then apply).
    expect(h.run.scans).toHaveLength(2);
    expect((h.run.scans[0] as { args: string[] }).args[3]).toBe(originalRuleJson);
    expect((h.run.scans[1] as { args: string[] }).args[3]).toBe(originalRuleJson);
    // And the verifier command is the registered one.
    expect(h.run.verifierCalls).toEqual([
      { command: 'verify-tool', args: ['check'], timeoutMs: 30_000, cwd: '/ws' },
    ]);
    // The remediation still landed (the original fix).
    expect(h.store.backing.get('src/a.ts')).toBe('const x = fooBar;\nconst y = fooBar;\n');
  });

  test('verifier FAIL: quarantined with the reason; the edits are ROLLED BACK; the dispatch is `failed`; next dispatch refuses', async () => {
    const h = harness(FIXTURE, 1, 'verify-tool: 2 mismatches\n');
    const before = h.store.backing.get('src/a.ts');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // W4.3: a remediation that provably did not hold is a FAILED dispatch,
    // not an `ok` carrying a bad outcome. The status is what a plan step and
    // a summary line read, so it must not say "ok" here.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('the verifier FAILED');
    expect(result.error).toContain('exited 1');
    expect(result.error).toContain('2 mismatches');
    expect(result.error).toContain('QUARANTINED');
    // The evidence rides the error as serialized JSON (the taxonomy gives
    // `failed` no payload slot) — same trace cut the record always used.
    const evidence = dispatchEvidence(result.error);
    expect(evidence.outcome).toBe('verifier-failed');
    expect(evidence.quarantined).toBe(true);
    expect(evidence.verifierReason).toContain('exited 1');
    expect(evidence.plannedEdits).toBe(2);
    expect(evidence.record.outcome).toBe('verifier-failed');
    expect(evidence.record.quarantined).toBe(true);
    // STEP 5: the applied edits were rolled back, so the workspace is back
    // at its pre-dispatch bytes.
    expect(evidence.restore.restored).toEqual(['src/a.ts']);
    expect(evidence.restore.stranded).toEqual([]);
    expect(h.store.backing.get('src/a.ts')).toBe(before);
    expect(h.store.backing.get('src/a.ts')).toContain('foo_bar');
    // The ledger holds the record carrying the verifier's reason verbatim.
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(true);
    expect(h.quarantine.reasonOf('fix-foo-bar')).toBe(evidence.verifierReason);
    expect(h.quarantine.records()[0]?.phase).toBe('verifier-failed');
    // And the VERY NEXT dispatch is refused before anything runs.
    const refused = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(refused.status).toBe('needs-human');
    // The FIRST dispatch scanned twice (its preflight, then its apply); the
    // quarantined re-dispatch scanned NOTHING — the refusal precedes the
    // engine.
    expect(h.run.scans).toHaveLength(2);
  });

  test('verifier INDETERMINATE (null exit): honest indeterminate, NO quarantine, edits restored, evidence rides detail', async () => {
    const h = harness(FIXTURE, null, 'timeout kill');
    const before = h.store.backing.get('src/a.ts');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') return;
    expect(result.detail).toContain('NOT quarantined');
    expect(result.detail).toContain('unobservable');
    // The evidence is embedded as serialized JSON of the exported shape.
    const evidence = dispatchEvidence(result.detail);
    expect(evidence.record.kind).toBe('playbook-dispatch');
    expect(evidence.outcome).toBe('verifier-indeterminate');
    expect(evidence.quarantined).toBe(false);
    expect(evidence.record.verifier.verdict).toBe('indeterminate');
    // STEP 5 applies here too: an unobservable verdict is not a licence to
    // leave unverified edits on disk.
    expect(evidence.restore.restored).toEqual(['src/a.ts']);
    expect(h.store.backing.get('src/a.ts')).toBe(before);
    // An unobservable verdict never punishes the playbook: the ledger is
    // untouched, so the playbook is still dispatchable.
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(false);
    // ADR-0003 §5: a re-dispatch needs a FRESH approval. The first dispatch
    // consumed the token, and the workspace was restored, so this is a
    // clean retry — but it is refused until a human approves again. This is
    // the "a job that did not finish ok needs a fresh token" rule, and it
    // is the reason the old "do NOT blindly re-dispatch" warning is gone:
    // nothing is on disk, and nothing proceeds without a new approval.
    const again = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(again.status).toBe('needs-human');
    expect(again.status === 'needs-human' ? again.reason : '').toContain('already consumed');
    // THREE scans: the first dispatch's preflight + apply, PLUS the replay's
    // own preflight — the preflight runs before exercise, and only the
    // ledger (consulted at exercise) knows the nonce is spent, so a
    // spent-token replay costs one read-only dry-run scan before the
    // refusal. No write, no spend.
    expect(h.run.scans).toHaveLength(3);
    // ...and WITH a fresh approval the retry runs and reaches the verifier
    // again — the playbook was never quarantined.
    const approved = harness(FIXTURE, null, 'timeout kill');
    const retried = await approved.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(retried.status).toBe('indeterminate');
    expect(approved.run.scans).toHaveLength(2);
  });

  test('an engine collision fails the dispatch; the ledger is untouched (the playbook did not fail its verifier)', async () => {
    const h = harness(FIXTURE, 0);
    // A scripted scan reporting two OVERLAPPING matches blocks the whole
    // apply before anything is written.
    h.run = Object.assign(
      async (cmd: Parameters<RunCheck>[0]): Promise<RawCheckOutput> => {
        if (cmd.command === 'ast-grep') {
          return {
            stdout: JSON.stringify([
              {
                file: 'src/a.ts',
                replacement: 'fooBar',
                replacementOffsets: { start: 10, end: 17 },
              },
              {
                file: 'src/a.ts',
                replacement: 'fooBar',
                replacementOffsets: { start: 14, end: 21 },
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      { scans: [], verifierCalls: [] },
    ) as Harness['run'];
    const failing = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: approvedAuthority().authority,
    });
    const result = await failing({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('collision');
    }
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(false);
    expect(h.store.backing.get('src/a.ts')).toBe(FIXTURE['src/a.ts']);
  });
});
