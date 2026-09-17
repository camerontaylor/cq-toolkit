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
  makePlaybookDispatchOp,
  makePlaybookQuarantineListOp,
  makePlaybookRegisterOp,
  makePlaybookRegistry,
} from '../../../../src/ops/analyze/playbooks/registry.js';
import { makeQuarantineLedger } from '../../../../src/ops/analyze/playbooks/quarantine.js';

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

  test('verifier FAIL: quarantined with the reason; the report says applied-but-failed; next dispatch refuses', async () => {
    const h = harness(FIXTURE, 1, 'verify-tool: 2 mismatches\n');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // THE HONEST REPORT: the dispatch ran to a definitive verdict (the
    // regressionGate precedent) — ok with an unambiguous outcome
    // discriminator, the full evidence, and the quarantine state change.
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.outcome).toBe('verifier-failed');
    if (result.value.outcome !== 'verifier-failed') return;
    expect(result.value.quarantined).toBe(true);
    expect(result.value.verifierReason).toContain('exited 1');
    expect(result.value.verifierReason).toContain('2 mismatches');
    expect(result.value.plannedEdits).toBe(2);
    expect(result.value.record.outcome).toBe('verifier-failed');
    expect(result.value.record.quarantined).toBe(true);
    // The remediation WAS applied (honest) — and the ledger now holds the
    // record carrying the verifier's reason verbatim.
    expect(h.store.backing.get('src/a.ts')).toContain('fooBar');
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(true);
    expect(h.quarantine.reasonOf('fix-foo-bar')).toBe(result.value.verifierReason);
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

  test('verifier INDETERMINATE (null exit): honest indeterminate, NO quarantine, record rides detail as JSON', async () => {
    const h = harness(FIXTURE, null, 'timeout kill');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') return;
    expect(result.detail).toContain('NOT quarantined');
    expect(result.detail).toContain('unobservable');
    // The trace record is embedded as serialized JSON of the exported shape.
    const marker = 'Dispatch record: ';
    const at = result.detail.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    const record = JSON.parse(result.detail.slice(at + marker.length)) as {
      kind: string;
      outcome: string;
      quarantined: boolean;
      verifier: { verdict: string };
    };
    expect(record.kind).toBe('playbook-dispatch');
    expect(record.outcome).toBe('verifier-indeterminate');
    expect(record.quarantined).toBe(false);
    expect(record.verifier.verdict).toBe('indeterminate');
    // An unobservable verdict never punishes the playbook: the ledger is
    // untouched, and a re-dispatch RUNS (retry is the consumer's call).
    expect(h.quarantine.isQuarantined('fix-foo-bar')).toBe(false);
    const again = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(again.status).toBe('indeterminate');
    expect(h.run.scans).toHaveLength(2);
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
    expect(firstResult.status).toBe('ok');
    if (firstResult.status === 'ok' && firstResult.value.outcome === 'verifier-failed') {
      expect(firstResult.value.quarantined).toBe(true);
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
