// Split provenance: test/ops/analyze/playbooks/registry.test.ts was split into
// registry.register.test.ts, registry.dispatch.test.ts,
// registry.dispatch-faults.test.ts, registry.withDispatch.test.ts,
// registry.holds.test.ts, registry.hold-identity.test.ts,
// registry.quarantine-list.test.ts, registry.rollback.test.ts,
// registry.lock-fault.test.ts and registry.approved-apply.test.ts. The
// fixtures below are shared by the registry test files.
import { expect } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import type { Playbook } from '../../../../src/ops/analyze/playbooks/format.js';
import {
  makePlaybookDispatchOp,
  makePlaybookRegistry,
} from '../../../../src/ops/analyze/playbooks/registry.js';
import { makeQuarantineLedger } from '../../../../src/adapters/store/quarantine.js';
import type { InspectableNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import type {
  ApprovalAuthority,
  ApprovalState,
  ApprovalStateReader,
} from '../../../../src/ops/analyze/approval.js';
import type { PlaybookDispatchUnverified } from '../../../../src/ops/analyze/playbooks/registry.js';
import { makeInMemoryNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../../src/ops/analyze/approval.js';

/**
 * Parse the dispatch EVIDENCE the non-ok statuses carry as serialized JSON
 * (the frozen OpResult taxonomy gives `failed`/`indeterminate` no payload
 * slot). The marker is in the op's own prose, so a test that finds no
 * evidence fails loudly here instead of on a null deref later.
 */
export function dispatchEvidence(text: string): PlaybookDispatchUnverified {
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
 * use, the state re-check, O-5/O-6 — is pinned in the approval test split
 * (test/ops/analyze/withApprovedMutation.test.ts and its subject siblings)
 * and, at the op level, in the W4.3 describes of registry.rollback.test.ts,
 * registry.lock-fault.test.ts and registry.approved-apply.test.ts.
 */
export function approvedAuthority(readState?: ApprovalStateReader): {
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
export const RULE = {
  id: 'fix-foo-bar',
  language: 'ts',
  rule: { pattern: 'foo_bar' },
  fix: 'fooBar',
};

/** A minimal valid playbook (the harness's scripted runner owns the verifier exit). */
export function playbookOf(): Playbook {
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
export function memoryStore(files: Record<string, string>): AnalyzeFileStore & {
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

export interface Harness {
  run: RunCheck & { scans: unknown[]; verifierCalls: unknown[] };
  store: AnalyzeFileStore & { backing: Map<string, string> };
  quarantine: ReturnType<typeof makeQuarantineLedger>;
  playbooks: ReturnType<typeof makePlaybookRegistry>;
  dispatch: ReturnType<typeof makePlaybookDispatchOp>;
  /**
   * Re-point the scripted verifier at a different exit code. A dispatch whose
   * verifier is scripted to fail ALWAYS reports `failed`, so a test that wants
   * to observe a later PASS has to be able to change the verdict between
   * dispatches — the alternative (asserting `ok` while the verifier still
   * exits 1) only passes if the engine matched nothing at all, which proves
   * the opposite of what the test claims.
   */
  setVerifierExit: (exitCode: number | null, output?: string) => void;
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
export function harness(
  files: Record<string, string>,
  initialVerifierExit: number | null,
  initialVerifierOutput = '',
  playbook: Playbook = playbookOf(),
  beforeVerifierCommand: () => void = () => {},
): Harness {
  let verifierExit = initialVerifierExit;
  let verifierOutput = initialVerifierOutput;
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
    // The seam a concurrent-writer test uses: landing a second playbook's
    // edit HERE is the real interleaving (B's apply commits while A is
    // between its own write and its rollback). It has to run inside the
    // runner the dispatch op actually holds — mutating `harness.run`
    // afterwards would rebind a field the op already captured, and the
    // "concurrent" write would never happen.
    beforeVerifierCommand();
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
  return {
    run,
    store,
    quarantine,
    playbooks,
    dispatch,
    setVerifierExit: (exitCode, output = '') => {
      verifierExit = exitCode;
      verifierOutput = output;
    },
  };
}

export const FIXTURE = { 'src/a.ts': 'const x = foo_bar;\nconst y = foo_bar;\n' };
