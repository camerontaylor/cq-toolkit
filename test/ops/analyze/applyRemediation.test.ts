// Analyze lane G2 — test evidence for the sidecar contract: the four
// acceptance behaviors (missing sidecar → clear error; missing approval →
// needs-human refusal; overlapping planned edits → the whole apply blocked;
// dry-run shows the diffs and writes nothing), the stale-sidecar detection
// (analysis-time digests vs current bytes), the unknown-cluster fault, the
// empty-plan honesty, and the PINNED order of operations (staleness is
// checked before approval; approval before any scan). The sidecar under
// test is the real render op's output format; the runner and store are
// injected fakes — no ast-grep binary, no real fs.
import { describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../src/ops/analyze/analysisStore.js';
import { makeApplyRemediation } from '../../../src/ops/analyze/applyRemediation.js';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import {
  contentDigest,
  renderAnalysisReport,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
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
function fixtureReport(): ClusterErrorsReport {
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
function sidecarTextFor(report: ClusterErrorsReport, fileContents: Record<string, string>): string {
  const evidence = report.clusters.map((cluster) => ({
    clusterId: cluster.id,
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
 * In-memory store over the fixture workspace (same idiom as the codemod
 * tests), recording writes.
 */
function memoryStore(files: Record<string, string>): AnalyzeFileStore & {
  written: Map<string, Uint8Array>;
} {
  const backing = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, text]) => [path, Buffer.from(text, 'utf8')]),
  );
  const written = new Map<string, Uint8Array>();
  return {
    written,
    readBytes: async (path) => {
      const bytes = backing.get(path);
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Uint8Array.from(bytes);
    },
    readText: async (path) => {
      const bytes = backing.get(path);
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Buffer.from(bytes).toString('utf8');
    },
    writeBytes: async (path, bytes) => {
      const copy = Uint8Array.from(bytes);
      written.set(path, copy);
      backing.set(path, copy);
    },
    isDirectory: async () => true,
  };
}

/**
 * A fake ast-grep runner: reports one `foo_bar` → `fooBar` fix per match in
 * the CURRENT content it is handed at construction (the test's stand-in for
 * the shape-match — offsets are computed against those bytes).
 */
function codemodRunner(fileContents: Record<string, string>): RunCheck & { commands: unknown[] } {
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

const FIXTURE_FILES: Record<string, string> = {
  'src/a.ts': 'const foo_bar = 1;\n',
  'src/b.ts': 'export const foo_bar = 2;\n',
};
const SIDECAR_PATH = '/ws/analysis-deadbeef.sidecar.json';

function makeOp(store: AnalyzeFileStore, run: RunCheck = codemodRunner(FIXTURE_FILES)) {
  return makeApplyRemediation(() => store, run);
}

function baseInput(): {
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

describe('applyRemediation acceptance: fail-closed sidecar contract', () => {
  test('a MISSING sidecar fails with a clear error (acceptance: missing sidecar → clear error)', async () => {
    const store = memoryStore(FIXTURE_FILES); // no sidecar in it
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('failed closed');
      expect(result.error).toContain(SIDECAR_PATH);
      expect(result.error).toContain('missing, unreadable, or invalid');
    }
  });

  test('a corrupt sidecar (wrong version, drifted report) fails closed through the strict parse', async () => {
    const store = memoryStore({
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: '{"schemaVersion": 2, "report": {}, "evidence": []}',
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('expected schemaVersion 1');
    }
    const drifted = memoryStore({
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
    const store = memoryStore({
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

  test('a DELETED target is stale too (nothing to re-digest is still drift)', async () => {
    const store = memoryStore({
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
    const store = memoryStore({
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

  test('the pinned order: staleness is checked BEFORE approval, and approval BEFORE any scan', async () => {
    const staleStore = memoryStore({
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
    const cleanStore = memoryStore({
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
    const store = memoryStore({
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

describe('applyRemediation acceptance: dry-run, collision block, honest apply', () => {
  test('a DRY RUN shows the diffs and the planned edit count and writes NOTHING (acceptance)', async () => {
    const store = memoryStore({
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store)({ ...baseInput(), dryRun: true });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('dry-run');
    expect(result.value.clusterId).toBe(fixtureReport().clusters[0]?.id);
    expect(result.value.targets).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.value.plannedEdits).toBe(2);
    expect(result.value.files.map((file) => file.diff)).toEqual([
      expect.stringContaining('-const foo_bar = 1;'),
      expect.stringContaining('+export const fooBar = 2;'),
    ]);
    expect(store.written.size).toBe(0);
    // The dry-run is STILL part of the remediation decision path: even a
    // preview of a named cluster refuses without the explicit approval (the
    // sidecar-free codemod op is the un-gated preview surface, not this one).
    const { approved: _dropDry, ...dryNoApproval } = baseInput();
    void _dropDry;
    const unapproved = await makeOp(store)({ ...dryNoApproval, dryRun: true });
    expect(unapproved.status).toBe('needs-human');
    expect(store.written.size).toBe(0);
  });

  test('a COLLISION in the planned edits blocks the whole apply (acceptance)', async () => {
    const store = memoryStore({
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const collidingRunner: RunCheck = async () => ({
      stdout: JSON.stringify([
        { file: 'src/a.ts', replacement: 'one', replacementOffsets: { start: 0, end: 10 } },
        { file: 'src/a.ts', replacement: 'two', replacementOffsets: { start: 5, end: 15 } },
      ]),
      stderr: '',
      exitCode: 0,
    });
    const result = await makeOp(store, collidingRunner)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('collision');
      expect(result.error).toContain('blocked');
    }
    expect(store.written.size).toBe(0);
  });

  test('the HAPPY PATH applies the cluster remediation and reports per-file results with after-digests', async () => {
    const store = memoryStore({
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(2);
    const byFile = new Map(result.value.files.map((file) => [file.file, file]));
    expect(byFile.get('src/a.ts')?.edits).toBe(1);
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'const fooBar = 1;\n',
    );
    expect(byFile.get('src/b.ts')?.digestAfter).toBe(contentDigest('export const fooBar = 2;\n'));
    expect(store.written.size).toBe(2);
  });

  test('an EMPTY planned-edit set is the honest ok: zero counts plus the note — not a silent success', async () => {
    const store = memoryStore({
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store, codemodRunner({}))(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(0);
    expect(result.value.note).toContain('nothing matched');
    expect(store.written.size).toBe(0);
  });

  test('the cluster targets are the member files (deduped, sorted); noise is never a target', async () => {
    // A report with two members in ONE file plus ledger noise in another.
    const noiseFailure = failureOf({
      file: 'src/noise.ts',
      ruleId: 'no-console',
      message: 'Unexpected console statement.',
    });
    const set: FailureSet = {
      tool: 'eslint',
      exitCode: 1,
      failures: [
        failureOf({ file: 'src/shared.ts', line: 1, column: 1 }),
        failureOf({ file: 'src/shared.ts', line: 8, column: 3 }),
        noiseFailure,
      ],
    };
    const noiseSignature = clusterSignature(noiseFailure, 'eslint');
    const report = clusterErrors(set, {
      entries: [{ signature: noiseSignature, count: 2 }],
      knownNoise: [noiseSignature],
      needsHuman: [],
    });
    const files = { 'src/shared.ts': 'foo_bar();\nfoo_bar();\n' };
    const store = memoryStore({ ...files, [SIDECAR_PATH]: sidecarTextFor(report, files) });
    const result = await makeOp(
      store,
      codemodRunner(files),
    )({
      ...baseInput(),
      clusterId: report.clusters[0]?.id ?? '',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.targets).toEqual(['src/shared.ts']);
      expect(JSON.stringify(result.value)).not.toContain('src/noise.ts');
    }
  });
});
