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
// six subject test files in this directory and a shared fixture module:
// applyRemediation.collidingClusterIds.test.ts,
// applyRemediation.storeRelativePaths.test.ts,
// applyRemediation.applyAcceptance.test.ts,
// applyRemediation.approvalBoundary.test.ts,
// applyRemediation.lockFaultTokenFate.test.ts and
// applyRemediation.helpers.ts.
import { describe, expect, test } from 'vitest';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import {
  renderAnalysisReport,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';
import {
  FIXTURE_FILES,
  SIDECAR_PATH,
  baseInput,
  codemodRunner,
  failureOf,
  fixtureReport,
  makeOp,
  memoryStore,
  sidecarTextFor,
} from './applyRemediation.helpers.js';

describe('applyRemediation acceptance: fail-closed sidecar contract', () => {
  test('a MISSING sidecar fails with a clear error (acceptance: missing sidecar → clear error)', async () => {
    const store = memoryStore('/ws', FIXTURE_FILES); // no sidecar in it
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('failed closed');
      expect(result.error).toContain(SIDECAR_PATH);
      expect(result.error).toContain('missing, unreadable, or invalid');
    }
  });

  test('a corrupt sidecar (wrong version, drifted report) fails closed through the strict parse', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: '{"schemaVersion": 99, "report": {}, "evidence": []}',
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('expected schemaVersion 2');
    }
    const drifted = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: serializeAnalysisSidecar(
        renderAnalysisReport(fixtureReport()).sidecar,
      ).replace('"clusters"', '"clusterz"'),
    });
    const driftedResult = await makeOp(drifted)(baseInput());
    expect(driftedResult.status).toBe('failed');
  });

  test('a STALE sidecar (any target drifted since analysis) fails naming the file and both digests', async () => {
    const driftedFiles = { ...FIXTURE_FILES, 'src/b.ts': 'export const foo_bar = 3;\n' };
    const store = memoryStore('/ws', {
      ...driftedFiles,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store, codemodRunner(driftedFiles))(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('stale sidecar');
      expect(result.error).toContain("'src/b.ts'");
      expect(result.error).toContain('changed since analysis');
      expect(result.error).toContain('re-run');
    }
  });

  test('an EVIDENCE-FREE sidecar is an apply fault naming the uncovered cluster (M2: absence never disables staleness)', async () => {
    // A hand-built or pure-core sidecar with evidence: [] must fail closed —
    // with no coverage contract it would silently skip ALL staleness
    // checking while targets derive from cluster.failures.
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: serializeAnalysisSidecar(renderAnalysisReport(fixtureReport()).sidecar),
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('failed closed');
      expect(result.error).toContain('evidence does not cover cluster');
      expect(result.error).toContain(fixtureReport().clusters[0]?.id ?? '');
    }
  });

  test('a DELETED target is stale too (nothing to re-digest is still drift)', async () => {
    const store = memoryStore('/ws', {
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('stale sidecar');
      expect(result.error).toContain('no longer readable');
    }
  });

  test('missing approval (or clusterId) REFUSES as needs-human, naming the required shape', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const op = makeOp(store);
    const { approved: _approved, ...needsApproval } = baseInput();
    void _approved;
    for (const approved of [undefined, false]) {
      const result = await op({
        ...needsApproval,
        ...(approved === undefined ? {} : { approved }),
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('never auto-applied');
        expect(result.reason).toContain('{ clusterId: "<id>", approved: true }');
      }
    }
    const { clusterId: _clusterId, ...noClusterInput } = baseInput();
    void _clusterId;
    const noCluster = await op(noClusterInput);
    expect(noCluster.status).toBe('needs-human');
  });

  test('stale is WHOLE-SIDECAR: a NON-remediated cluster’s target drift fails the apply (L5 cross-cluster pin)', async () => {
    // Two single-member clusters on different files; only cluster A is
    // requested, but cluster B's target drifted — the apply must refuse:
    // trusting the un-drifted parts of a drifted snapshot is exactly how
    // wrong edits slip past.
    const first = failureOf({ file: 'src/a.ts', line: 5, column: 1, message: 'alpha one' });
    const second = failureOf({ file: 'src/b.ts', line: 9, column: 3, message: 'beta two' });
    const report = clusterErrors({
      tool: 'eslint',
      exitCode: 1,
      failures: [first, second],
    });
    expect(report.clusters).toHaveLength(2);
    const driftedFiles = { ...FIXTURE_FILES, 'src/b.ts': 'export const foo_bar = 99;\n' };
    const store = memoryStore('/ws', {
      ...driftedFiles,
      [SIDECAR_PATH]: sidecarTextFor(report, FIXTURE_FILES),
    });
    const clusterA = report.clusters.find(
      (cluster) => (cluster.failures[0] as CheckFailure).file === 'src/a.ts',
    );
    const result = await makeOp(
      store,
      codemodRunner(driftedFiles),
    )({
      ...baseInput(),
      clusterId: (clusterA as NonNullable<typeof clusterA>).id,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('stale sidecar');
      expect(result.error).toContain("'src/b.ts'");
    }
  });

  test('the pinned order: staleness is checked BEFORE approval, and approval BEFORE any scan', async () => {
    const staleStore = memoryStore('/ws', {
      ...FIXTURE_FILES,
      'src/b.ts': 'export const foo_bar = 3;\n',
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const { approved: _drop, ...unapprovedInput } = baseInput();
    void _drop;
    const staleResult = await makeOp(staleStore)(unapprovedInput);
    // Stale (step 2) fires before the approval refusal (step 3).
    expect(staleResult.status).toBe('failed');
    // A valid sidecar + missing approval runs NO scan (the runner would
    // fail the op if it were invoked — this fake's content has no matches,
    // so a scan would have produced the honest empty ok instead).
    const cleanStore = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const refusingRunner: RunCheck & { commands: unknown[] } = Object.assign(
      async () => {
        throw new Error('the scan must not run before approval');
      },
      { commands: [] },
    );
    const refused = await makeOp(cleanStore, refusingRunner)(unapprovedInput);
    expect(refused.status).toBe('needs-human');
  });

  test('an approved but UNKNOWN clusterId is `failed`, listing the ids the sidecar carries', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store)({ ...baseInput(), clusterId: '00000000' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("unknown cluster id '00000000'");
      expect(result.error).toContain(fixtureReport().clusters[0]?.id ?? '');
    }
  });
});
