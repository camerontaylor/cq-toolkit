// Analyze lane G2 — test evidence for the sidecar contract: the four
// acceptance behaviors (missing sidecar → clear error; missing approval →
// needs-human refusal; overlapping planned edits → the whole apply blocked;
// dry-run shows the diffs and writes nothing), the stale-sidecar detection
// (analysis-time digests vs current bytes), the unknown-cluster fault, the
// empty-plan honesty, and the PINNED order of operations (staleness is
// checked before approval; approval before any scan). The sidecar under
// test is the real render op's output format; the runner and store are
// injected fakes — no ast-grep binary, no real fs.
//
// Split provenance: test/ops/analyze/applyRemediation.test.ts was split into
// six subject test files in this directory and this shared-fixture module:
// applyRemediation.sidecarContract.test.ts, .collidingClusterIds.test.ts,
// .storeRelativePaths.test.ts, .applyAcceptance.test.ts,
// .approvalBoundary.test.ts and .lockFaultTokenFate.test.ts.
import { resolve } from 'node:path';
import type { RawCheckOutput, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { InspectableNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import type {
  ApprovalAuthority,
  ApprovalState,
  ApprovalStateReader,
} from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../src/ops/analyze/analysisStore.js';
import { makeApplyRemediation } from '../../../src/ops/analyze/applyRemediation.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import {
  contentDigest,
  renderAnalysisReport,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';

export function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'no-unused-vars',
    message: "'x' is defined but never used",
    severity: 'error',
    ...overrides,
  };
}

/** The fixture report: one two-member cluster over src/a.ts + src/b.ts. */
export function fixtureReport(): ClusterErrorsReport {
  return clusterErrors({
    tool: 'eslint',
    exitCode: 1,
    failures: [
      failureOf({
        file: 'src/a.ts',
        line: 5,
        column: 1,
        message: "'a' is assigned a value but never used",
      }),
      failureOf({
        file: 'src/b.ts',
        line: 9,
        column: 3,
        message: "'b' is assigned a value but never used",
      }),
    ],
  });
}

/** The sidecar the render op would publish for `report`, serialized. */
export function sidecarTextFor(
  report: ClusterErrorsReport,
  fileContents: Record<string, string>,
): string {
  const evidence = report.clusters.map((cluster) => ({
    clusterId: cluster.id,
    signature: cluster.signature,
    targets: [
      ...new Set(
        cluster.failures
          .map((failure) => failure.file)
          .filter((file): file is string => file !== null),
      ),
    ]
      .sort()
      .map((file) => ({ file, digest: contentDigest(fileContents[file] as string) })),
  }));
  return serializeAnalysisSidecar(renderAnalysisReport(report, { evidence }).sidecar);
}

/**
 * In-memory store ROOTED at a directory, resolving paths exactly like the
 * real pathAnalysisFileStore (resolve(root, path), cwd-anchored for
 * relative roots) — this is what catches store-relative path discipline
 * regressions: the pre-M1 op handed the store the FULL sidecarPath while
 * its store was rooted at dirname(sidecarPath), so the read resolved to
 * root/root/… and failed closed only by accident of the fixture shape.
 */
export function memoryStore(
  root: string,
  files: Record<string, string>,
): AnalyzeFileStore & {
  written: Map<string, Uint8Array>;
} {
  const backing = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, text]) => [resolve(root, path), Buffer.from(text, 'utf8')]),
  );
  const written = new Map<string, Uint8Array>();
  return {
    written,
    readBytes: async (path) => {
      const bytes = backing.get(resolve(root, path));
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Uint8Array.from(bytes);
    },
    readText: async (path) => {
      const bytes = backing.get(resolve(root, path));
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Buffer.from(bytes).toString('utf8');
    },
    writeBytes: async (path, bytes) => {
      const copy = Uint8Array.from(bytes);
      const key = resolve(root, path);
      written.set(key, copy);
      backing.set(key, copy);
    },
    isDirectory: async () => true,
  };
}

/**
 * A fake ast-grep runner: reports one `foo_bar` → `fooBar` fix per match in
 * the CURRENT content it is handed at construction (the test's stand-in for
 * the shape-match — offsets are computed against those bytes).
 */
export function codemodRunner(
  fileContents: Record<string, string>,
): RunCheck & { commands: unknown[] } {
  const matches: object[] = [];
  for (const [file, text] of Object.entries(fileContents)) {
    for (
      let index = text.indexOf('foo_bar');
      index !== -1;
      index = text.indexOf('foo_bar', index + 1)
    ) {
      matches.push({
        file,
        replacement: 'fooBar',
        replacementOffsets: { start: index, end: index + 'foo_bar'.length },
      });
    }
  }
  const runner = async (): Promise<RawCheckOutput> => ({
    stdout: JSON.stringify(matches),
    stderr: '',
    exitCode: 0,
  });
  runner.commands = [] as unknown[];
  return runner as RunCheck & { commands: unknown[] };
}

export const FIXTURE_FILES: Record<string, string> = {
  'src/a.ts': 'const foo_bar = 1;\n',
  'src/b.ts': 'export const foo_bar = 2;\n',
};
export const SIDECAR_PATH = '/ws/analysis-deadbeef.sidecar.json';

/**
 * The W4.3 authority this suite's apply-path tests run under: a REAL
 * `ApprovalAuthority` (same code the op calls) over an in-memory nonce
 * ledger and process-local locks, with the run's verified approvals
 * answering for every subject. The tests below are about the op's
 * remediation behavior GIVEN an approved subject; subject binding,
 * single-use and the state re-check are pinned directly in the approval
 * test split (test/ops/analyze/withApprovedMutation.test.ts and its
 * subject siblings), and the DENIAL cases below deliberately use the
 * shipped deny-all default instead.
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
    // Derived from the subject, as a real verified token's nonce is bound
    // to one op+inputs: identical inputs re-present the same (spent) token,
    // changed inputs are a different subject with no token at all.
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({
          nonce: `nonce-${subject.op}-${subject.inputDigest.slice(0, 12)}`,
          state: { ...approvedState, workspace: resolve(subject.workspace) },
        }),
    },
    ledger,
    locks: makeProcessLocalMutationLocks(),
    readState: readState ?? { read: () => Promise.resolve(approvedState) },
  });
  return { authority, ledger };
}

export function makeOp(
  store: AnalyzeFileStore,
  run: RunCheck = codemodRunner(FIXTURE_FILES),
  authority: ApprovalAuthority = approvedAuthority().authority,
) {
  return makeApplyRemediation(() => store, run, authority);
}

export function baseInput(): {
  sidecarPath: string;
  clusterId: string;
  approved: true;
  rule: string;
  dryRun: boolean;
} {
  return {
    sidecarPath: SIDECAR_PATH,
    clusterId: fixtureReport().clusters[0]?.id ?? '',
    approved: true,
    rule: 'id: rename\nlanguage: ts\nrule:\n  pattern: foo_bar',
    dryRun: false,
  };
}

export function approvedStore(): AnalyzeFileStore & { written: Map<string, Uint8Array> } {
  return memoryStore('/ws', {
    ...FIXTURE_FILES,
    [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
  });
}
