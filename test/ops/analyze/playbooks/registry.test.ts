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
import { describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import type { Playbook } from '../../../../src/ops/analyze/playbooks/format.js';
import {
  DispatchInFlightError,
  makePlaybookDispatchOp,
  makePlaybookQuarantineListOp,
  makePlaybookRegisterOp,
  makePlaybookRegistry,
} from '../../../../src/ops/analyze/playbooks/registry.js';
import { makeQuarantineLedger } from '../../../../src/ops/analyze/playbooks/quarantine.js';
import type {
  ApprovalAuthority,
  ApprovalState,
  ApprovalStateReader,
  InspectableNonceLedger,
  MutationLocks,
} from '../../../../src/ops/analyze/approval.js';
import type { PlaybookDispatchUnverified } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  makeApprovalAuthority,
  makeInMemoryNonceLedger,
  makeProcessLocalMutationLocks,
} from '../../../../src/ops/analyze/approval.js';

/**
 * Parse the dispatch EVIDENCE the non-ok statuses carry as serialized JSON
 * (the frozen OpResult taxonomy gives `failed`/`indeterminate` no payload
 * slot). The marker is in the op's own prose, so a test that finds no
 * evidence fails loudly here instead of on a null deref later.
 */
function dispatchEvidence(text: string): PlaybookDispatchUnverified {
  const marker = 'Dispatch evidence: ';
  const at = text.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(at + marker.length)) as PlaybookDispatchUnverified;
}

/**
 * The W4.3 authority the dispatch suite runs under: a REAL
 * `ApprovalAuthority` (the same code the op calls) with the run's verified
 * approvals answering for every subject, so these tests stay about the
 * dispatch FLOW. The approval boundary itself — deny-all refusal, single
 * use, the state re-check, O-5/O-6 — is pinned in
 * test/ops/analyze/approval.test.ts and, at the op level, in the two W4.3
 * describes at the end of this file.
 */
function approvedAuthority(readState?: ApprovalStateReader): {
  authority: ApprovalAuthority;
  ledger: InspectableNonceLedger;
} {
  const ledger = makeInMemoryNonceLedger();
  // The state the "signed" claim carries. It must MATCH what the state
  // reader below reports, or admission refuses on the kernel-to-admission
  // comparison — which is the point of the field.
  const approvedState: ApprovalState = {
    workspace: '/ws',
    headSha: 'head-at-approval',
    treeClean: true,
  };
  const authority = makeApprovalAuthority({
    // The nonce is DERIVED FROM THE SUBJECT, exactly as a real verified
    // token's nonce is bound to one op+inputs: two different playbooks get
    // two different tokens, while a re-dispatch of the SAME playbook over
    // the SAME inputs re-presents the SAME (now spent) token.
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({
          nonce: `nonce-${subject.op}-${subject.inputDigest.slice(0, 12)}`,
          state: { ...approvedState, workspace: subject.workspace },
        }),
    },
    ledger,
    locks: makeProcessLocalMutationLocks(),
    readState: readState ?? { read: () => Promise.resolve(approvedState) },
  });
  return { authority, ledger };
}

/** The consumer rule as a JSON object (the playbook format's rule field). */
const RULE = {
  id: 'fix-foo-bar',
  language: 'ts',
  rule: { pattern: 'foo_bar' },
  fix: 'fooBar',
};

/** A minimal valid playbook (the harness's scripted runner owns the verifier exit). */
function playbookOf(): Playbook {
  return {
    schemaVersion: 1,
    id: 'fix-foo-bar',
    description: 'rename foo_bar to fooBar',
    rule: RULE,
    verifier: {
      command: { command: 'verify-tool', args: ['check'], timeoutMs: 30_000 },
    },
  };
}

/**
 * An in-memory store sharing its backing map with the caller, so the
 * scripted ast-grep runner computes its byte offsets against the SAME
 * bytes the codemod op reads (the freshness anchor holds).
 */
function memoryStore(files: Record<string, string>): AnalyzeFileStore & {
  backing: Map<string, string>;
} {
  const backing = new Map<string, string>(Object.entries(files));
  return {
    backing,
    readBytes: async (path) => {
      const text = backing.get(path);
      if (text === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Buffer.from(text, 'utf8');
    },
    readText: async (path) => {
      const bytes = await (async () => {
        const text = backing.get(path);
        if (text === undefined) throw new AnalysisStoreError(`analysis store: '${path}' missing`);
        return Buffer.from(text, 'utf8');
      })();
      return Buffer.from(bytes).toString('utf8');
    },
    writeBytes: async (path, bytes) => {
      backing.set(path, Buffer.from(bytes).toString('utf8'));
    },
    isDirectory: async () => true,
  };
}

interface Harness {
  run: RunCheck & { scans: unknown[]; verifierCalls: unknown[] };
  store: AnalyzeFileStore & { backing: Map<string, string> };
  quarantine: ReturnType<typeof makeQuarantineLedger>;
  playbooks: ReturnType<typeof makePlaybookRegistry>;
  dispatch: ReturnType<typeof makePlaybookDispatchOp>;
}

/**
 * The full dispatch harness: one registered playbook over `files`, a
 * scripted runner that answers `ast-grep` scans with the correct wire-shape
 * match objects for RULE's pattern (computed against the store's live
 * bytes) and every other command with `verifierExit` (+ optional output).
 * The registered playbook defaults to {@link playbookOf} and can be
 * overridden (the verifier-timeout boundary test swaps in a playbook whose
 * command omits `timeoutMs`).
 */
function harness(
  files: Record<string, string>,
  verifierExit: number | null,
  verifierOutput = '',
  playbook: Playbook = playbookOf(),
): Harness {
  const run = (async (cmd: Parameters<RunCheck>[0]): Promise<RawCheckOutput> => {
    if (cmd.command === 'ast-grep') {
      run.scans.push(cmd);
      const separator = cmd.args.indexOf('--');
      const targets = cmd.args.slice(separator + 1);
      const matches: object[] = [];
      for (const file of targets) {
        const text = store.backing.get(file) ?? '';
        let index = text.indexOf('foo_bar');
        while (index !== -1) {
          matches.push({
            file,
            ruleId: 'fix-foo-bar',
            severity: 'hint',
            replacement: 'fooBar',
            replacementOffsets: { start: index, end: index + 'foo_bar'.length },
          });
          index = text.indexOf('foo_bar', index + 1);
        }
      }
      return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
    }
    run.verifierCalls.push(cmd);
    return { stdout: '', stderr: verifierOutput, exitCode: verifierExit };
  }) as Harness['run'];
  run.scans = [];
  run.verifierCalls = [];
  const store = memoryStore(files);
  const quarantine = makeQuarantineLedger();
  const playbooks = makePlaybookRegistry();
  const dispatch = makePlaybookDispatchOp({
    playbooks,
    quarantine,
    run,
    storeFor: () => store,
    approval: approvedAuthority().authority,
  });
  playbooks.register(playbook);
  return { run, store, quarantine, playbooks, dispatch };
}

const FIXTURE = { 'src/a.ts': 'const x = foo_bar;\nconst y = foo_bar;\n' };

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
    // playbookOf — so the dispatch fills it with the analysis dir).
    expect(h.run.scans).toHaveLength(1);
    expect((h.run.scans[0] as { args: string[] }).args[3]).toBe(JSON.stringify(RULE));
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
    // serialized verbatim), not the mutated one.
    expect(h.run.scans).toHaveLength(1);
    expect((h.run.scans[0] as { args: string[] }).args[3]).toBe(originalRuleJson);
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
    expect(h.run.scans).toHaveLength(1); // no second scan happened
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
    expect(h.run.scans).toHaveLength(1);
    // ...and WITH a fresh approval the retry runs and reaches the verifier
    // again — the playbook was never quarantined.
    const approved = harness(FIXTURE, null, 'timeout kill');
    const retried = await approved.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(retried.status).toBe('indeterminate');
    expect(approved.run.scans).toHaveLength(1);
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
    await h.dispatch({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] });
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(true);
    expect(
      (await h.dispatch({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] })).status,
    ).toBe('needs-human');
    // THE explicit consumer action — nothing in the codebase calls this.
    h.quarantine.unquarantine('fix-foo-bar');
    const again = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
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
    expect(h.run.scans).toHaveLength(1);
    expect(h.run.verifierCalls).toHaveLength(0); // #1 parked pre-record; #2 never invoked one
    // Settle the in-flight dispatch (fail → quarantine). Its slot frees,
    // and a NEW dispatch proceeds normally — through the quarantine check,
    // which now refuses on the RECORD (a different refusal than the
    // in-flight one).
    releaseVerifier?.();
    const firstResult = await first;
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
    expect(h.run.scans).toHaveLength(1);
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
    // A window for B's engine to run — it must: different ids never block.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.run.scans).toHaveLength(2);
    releaseVerifier?.();
    expect((await a).status).toBe('ok');
    expect((await b).status).toBe('ok');
  }, 15_000);
});

describe('withDispatch (the direct SDK slot path)', () => {
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

// W4.3, second review — the RESTORE is a mutation too. The first version
// released the mutation lock when the engine call returned and then wrote
// the pre-apply bytes back after the verifier, so a concurrent approved
// dispatch of ANOTHER playbook could land in that window and have its edit
// silently overwritten by this one's rollback. These are the regressions for
// that lost update: the conflicting file is reported STRANDED and left alone.
describe('W4.3 the rollback is conditional and locked (no lost update)', () => {
  const CONCURRENT_EDIT = 'const x = fooBar;\nconst y = fooBar;\n// playbook B also ran\n';

  function harnessWhereVerifierLandsAConcurrentWrite(
    files: Record<string, string>,
    verifierExit: number | null,
  ): Harness {
    const h = harness(files, verifierExit);
    // The scripted runner answers the verifier command. Landing a second
    // playbook's edit THERE is the real interleaving: B's apply commits
    // while A is between its own write and its rollback.
    const inner = h.run;
    h.run = Object.assign(
      async (cmd: Parameters<RunCheck>[0]): Promise<RawCheckOutput> => {
        if (cmd.command !== 'ast-grep') h.store.backing.set('src/a.ts', CONCURRENT_EDIT);
        return inner(cmd);
      },
      { scans: [], verifierCalls: [] },
    ) as Harness['run'];
    return h;
  }

  test('a concurrent writer between the apply and the rollback is NOT clobbered: STRANDED, bytes intact', async () => {
    const h = harnessWhereVerifierLandsAConcurrentWrite(FIXTURE, 1);
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // Still a failed dispatch — the verifier verdict is unchanged by what
    // happened to the file afterwards.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // THE assertion: nothing was restored, because the file no longer holds
    // what THIS dispatch wrote.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded).toHaveLength(1);
    expect(evidence.restore.stranded[0]?.file).toBe('src/a.ts');
    expect(evidence.restore.stranded[0]?.error).toContain('another writer changed this file');
    expect(evidence.restore.stranded[0]?.error).toContain('NOT restored');
    // B's edit survived — the lost update the first version of this restore
    // would have caused.
    expect(h.store.backing.get('src/a.ts')).toBe(CONCURRENT_EDIT);
    // And the prose does NOT claim the workspace is back at pre-dispatch.
    expect(result.error).toContain('STRANDED');
    expect(result.error).toContain('NOT at its pre-dispatch state');
  });

  test('POSITIVE CONTROL: with no concurrent writer the same path restores fully', async () => {
    const h = harness(FIXTURE, 1);
    const before = h.store.backing.get('src/a.ts');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    expect(evidence.restore.restored).toEqual(['src/a.ts']);
    expect(evidence.restore.stranded).toEqual([]);
    expect(h.store.backing.get('src/a.ts')).toBe(before);
  });

  test('the restore runs INSIDE the mutation lock, so two rollbacks cannot interleave', async () => {
    const h = harness(FIXTURE, 1);
    const events: string[] = [];
    const locks = makeProcessLocalMutationLocks();
    const inner = locks.forWorkspace('/ws');
    let held = 0;
    let maxHeld = 0;
    const instrumented = {
      forWorkspace: () => ({
        withLock: async <T>(fn: () => T | Promise<T>): Promise<T> =>
          inner.withLock(async () => {
            held += 1;
            maxHeld = Math.max(maxHeld, held);
            events.push(`lock:${held}`);
            try {
              return await fn();
            } finally {
              held -= 1;
              events.push(`unlock:${held + 1}`);
            }
          }),
      }),
    };
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (s) =>
          Promise.resolve({
            nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: instrumented,
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: authority,
    });
    await dispatch({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] });
    // TWO critical sections: the apply (exercise + engine) and the restore.
    // The first version had ONE — the restore ran outside the lock, which is
    // the whole bug.
    expect(events.filter((entry) => entry.startsWith('lock:'))).toHaveLength(2);
    expect(maxHeld).toBe(1);
  });
});

// A LOCK FAULT IS A RESULT, NOT AN EXCEPTION. The mutation lock is a real
// filesystem primitive and it throws in three ordinary ways — the waiter
// budget is exhausted, the release fails, or the artifact is compromised
// while held. Before this, any of those rejected straight out of the op
// with no OpResult and, worse, no evidence: the applied edits were already
// on disk and the caller learned nothing about them.
describe('a lock fault during the rollback is reported, never thrown', () => {
  /**
   * Locks that fault the way the real git mutex can — at acquire, or after
   * the section ran — but ONLY ON THE SECOND SECTION.
   *
   * That "second only" is the point: the dispatch takes the mutation lock
   * TWICE, once for the approved apply and once for the rollback. A fixture
   * that faults on every acquisition fails the FIRST one, so the verifier
   * never runs and the test asserts nothing about the rollback it claims to
   * cover. The first section must therefore succeed, and every test below
   * asserts the verifier ran, which is what proves the rollback was reached
   * at all.
   */
  function faultingLocks(mode: 'acquire' | 'release'): {
    locks: MutationLocks;
    sections: () => number;
  } {
    const real = makeProcessLocalMutationLocks();
    let taken = 0;
    return {
      sections: () => taken,
      locks: {
        forWorkspace: (workspace: string) => {
          const inner = real.forWorkspace(workspace);
          return {
            withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
              taken += 1;
              if (taken === 1) return inner.withLock(fn);
              if (mode === 'acquire') {
                throw new Error(
                  "git-mutex: could not acquire '/state/mutation-abc.lock' — still held after the waiter budget",
                );
              }
              // The compromise-after-the-fact case: the section RAN (and its
              // result is discarded, because a compromised section proves
              // nothing), then the primitive reported the fault.
              await inner.withLock(fn);
              throw new Error('git-mutex: lock was compromised while held');
            },
          };
        },
      },
    };
  }

  test('a lock fault at ACQUIRE strands every applied file and still returns failed', async () => {
    const h = harness(FIXTURE, 1);
    const { locks, sections } = faultingLocks('acquire');
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: makeApprovalAuthority({
        approvals: {
          verifiedFor: (s) =>
            Promise.resolve({
              nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
              state: { workspace: '/ws', headSha: 'head', treeClean: true },
            }),
        },
        ledger: makeInMemoryNonceLedger(),
        locks,
        readState: {
          read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
        },
      }),
    });
    const result = await dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // PROOF THE ROLLBACK WAS REACHED: the apply took the first section
    // (healthy), the verifier really ran, and only the SECOND section — the
    // rollback's — faulted. A fixture that faulted section one would fail
    // here and never get this far.
    expect(sections()).toBe(2);
    expect(h.run.verifierCalls).toHaveLength(1);
    // No throw escaped: the op produced a result.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // NOTHING is claimed as restored, and the reason names the lock fault.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded).toHaveLength(1);
    expect(evidence.restore.stranded[0]?.file).toBe('src/a.ts');
    expect(evidence.restore.stranded[0]?.error).toContain('mutation lock faulted');
    expect(evidence.restore.stranded[0]?.error).toContain('waiter budget');
    // The playbook is still quarantined — the verdict did not change.
    expect(evidence.quarantined).toBe(true);
  });

  test('a lock fault AFTER the section ran claims nothing as restored (exclusivity is unproven)', async () => {
    const h = harness(FIXTURE, 1);
    const { locks, sections } = faultingLocks('release');
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: makeApprovalAuthority({
        approvals: {
          verifiedFor: (s) =>
            Promise.resolve({
              nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
              state: { workspace: '/ws', headSha: 'head', treeClean: true },
            }),
        },
        ledger: makeInMemoryNonceLedger(),
        locks,
        readState: {
          read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
        },
      }),
    });
    const result = await dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // Same proof: the apply's section was healthy, the verifier ran, and the
    // rollback's section is the one that faulted.
    expect(sections()).toBe(2);
    expect(h.run.verifierCalls).toHaveLength(1);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // The restore body DID run, but a compromised section proves no
    // exclusivity, so the bytes must not be reported as a clean rollback.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded[0]?.error).toContain('compromised');
    expect(result.error).not.toContain('rolled back to their pre-dispatch bytes');
  });

  test('POSITIVE CONTROL: with healthy locks the same path still restores fully', async () => {
    const h = harness(FIXTURE, 1);
    const before = h.store.backing.get('src/a.ts');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    expect(evidence.restore.restored).toEqual(['src/a.ts']);
    expect(evidence.restore.stranded).toEqual([]);
    expect(h.store.backing.get('src/a.ts')).toBe(before);
  });
});
