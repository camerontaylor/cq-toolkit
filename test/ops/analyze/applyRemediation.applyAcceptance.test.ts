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
// applyRemediation.sidecarContract.test.ts,
// applyRemediation.collidingClusterIds.test.ts,
// applyRemediation.storeRelativePaths.test.ts,
// applyRemediation.approvalBoundary.test.ts,
// applyRemediation.lockFaultTokenFate.test.ts and
// applyRemediation.helpers.ts.
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../src/ops/analyze/analysisStore.js';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import { contentDigest } from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { FailureSet } from '../../../src/ops/gates/index.js';
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

describe('applyRemediation acceptance: dry-run, collision block, honest apply', () => {
  test('a DRY RUN shows the diffs and the planned edit count and writes NOTHING (acceptance)', async () => {
    const store = memoryStore('/ws', {
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
    const store = memoryStore('/ws', {
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
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store)(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(2);
    const byFile = new Map(result.value.files.map((file) => [file.file, file]));
    expect(byFile.get('src/a.ts')?.edits).toBe(1);
    // The rooted store's write keys are resolved against the root, so the
    // caller-facing dir-relative path and the write key agree.
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/a.ts')) as Uint8Array).toString('utf8'),
    ).toBe('const fooBar = 1;\n');
    expect(byFile.get('src/b.ts')?.digestAfter).toBe(contentDigest('export const fooBar = 2;\n'));
    expect(store.written.size).toBe(2);
  });

  test('a write fault mid-apply names the files ALREADY written in their remediated form (T2)', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    // The store faults on the SECOND target, after the first is on disk
    // (a delegating wrapper — the underlying store keeps the real writes).
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        if (path === 'src/b.ts') {
          throw new AnalysisStoreError('analysis store: disk full on second write');
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(flaky)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/b.ts'");
      // F3: the first target was RESTORED (best-effort rollback), not stranded.
      expect(result.error).toContain('rolled back src/a.ts');
      expect(result.error).toContain('original bytes restored');
    }
    // The first target's ORIGINAL bytes are back on disk.
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/a.ts')) as Uint8Array).toString('utf8'),
    ).toBe('const foo_bar = 1;\n');
  });

  test('when the ROLLBACK itself faults, the already-written wording survives and names the rollback failure (F3)', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    // Faults on the second target's write AND on every subsequent restore.
    let writeCount = 0;
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        writeCount += 1;
        if (writeCount >= 2) {
          throw new AnalysisStoreError(`analysis store: disk full on write ${writeCount}`);
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(flaky)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/b.ts'");
      // src/b.ts is the FAULTED file (its restore failure is noted
      // separately); src/a.ts is the STRANDED already-written one.
      expect(result.error).toContain('rollback FAILED for src/a.ts');
      expect(result.error).toContain('restored: none');
      expect(result.error).toContain('already written (stranded): src/a.ts');
      expect(result.error).toContain('partial-write restore failed');
    }
    // The first write (src/a.ts remediated) landed before the fault and
    // could not be undone — the stranded state is named, not hidden.
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/a.ts')) as Uint8Array).toString('utf8'),
    ).toBe('const fooBar = 1;\n');
  });

  test('a target mutated between read and scan fails the apply — the offsets are stale, nothing written (R2-5)', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    // The runner performs the drift ITSELF at scan time (ast-grep re-reads
    // the file then): the analysis-time digest no longer matches.
    const driftOnScan: RunCheck = async () => {
      const raw: RawCheckOutput = { stdout: '[]', stderr: '', exitCode: 0 };
      await store.writeBytes('src/a.ts', Buffer.from('mutated mid-flight;\n', 'utf8'));
      return raw;
    };
    const result = await makeOp(store, driftOnScan)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('file changed during remediation planning');
      expect(result.error).toContain("'src/a.ts'");
      expect(result.error).toContain('nothing was written');
    }
    // The only write is the drift itself — never a remediation splice.
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/a.ts')) as Uint8Array).toString('utf8'),
    ).toBe('mutated mid-flight;\n');
  });

  test('a PARTIAL rollback states both lists: restored files AND stranded files (L3)', async () => {
    // Three targets; the store faults on c's first write, allows c's
    // restore, but faults b's restore — so a and c come back, b is stranded.
    const three = {
      'src/a.ts': 'foo_bar_a();\n',
      'src/b.ts': 'foo_bar_b();\n',
      'src/c.ts': 'foo_bar_c();\n',
    };
    const oneCluster = clusterErrors({
      tool: 'eslint',
      exitCode: 1,
      failures: [
        failureOf({ file: 'src/a.ts', line: 1, column: 1, message: 'same shape' }),
        failureOf({ file: 'src/b.ts', line: 1, column: 1, message: 'same shape' }),
        failureOf({ file: 'src/c.ts', line: 1, column: 1, message: 'same shape' }),
      ],
    });
    const store = memoryStore('/ws', {
      ...three,
      [SIDECAR_PATH]: sidecarTextFor(oneCluster, three),
    });
    const writeCounts = new Map<string, number>();
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        const count = (writeCounts.get(path) ?? 0) + 1;
        writeCounts.set(path, count);
        if (path === 'src/c.ts' && count === 1) {
          throw new AnalysisStoreError('analysis store: disk full on c');
        }
        if (path === 'src/b.ts' && count === 2) {
          throw new AnalysisStoreError('analysis store: disk full restoring b');
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(
      flaky,
      codemodRunner(three),
    )({
      ...baseInput(),
      clusterId: oneCluster.clusters[0]?.id ?? '',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/c.ts'");
      // BOTH lists, verbatim: b's restore failed (stranded), a's restore
      // succeeded (c's own partial-write restore also succeeded silently).
      expect(result.error).toContain('rollback FAILED for src/b.ts');
      expect(result.error).toContain('restored: src/a.ts');
      // Y1: a restored file is listed ONLY under restored — b (whose
      // restore failed) is the one stranded entry.
      expect(result.error).toContain('already written (stranded): src/b.ts');
      expect(result.error).not.toContain('stranded): src/a.ts');
    }
    // The verbatim on-disk state: a and c carry their ORIGINAL bytes; b
    // holds its remediated form (stranded, as stated).
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/a.ts')) as Uint8Array).toString('utf8'),
    ).toBe('foo_bar_a();\n');
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/c.ts')) as Uint8Array).toString('utf8'),
    ).toBe('foo_bar_c();\n');
    expect(
      Buffer.from(store.written.get(resolve('/ws', 'src/b.ts')) as Uint8Array).toString('utf8'),
    ).toBe('fooBar_b();\n');
  });

  test('a SPLICE fault on a later target happens in preflight: NOTHING written, no rollback needed (Y2)', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    // Valid offsets for the FIRST target, out-of-bounds offsets for the
    // SECOND — pre-Y2 the first file was written (and rolled back); with
    // the preflight the fault happens before any write.
    const mixedRunner: RunCheck = async () => ({
      stdout: JSON.stringify([
        {
          file: 'src/a.ts',
          replacement: 'fooBar',
          replacementOffsets: { start: 6, end: 13 },
        },
        {
          file: 'src/b.ts',
          replacement: 'fooBar',
          replacementOffsets: { start: 100, end: 200 },
        },
      ]),
      stderr: '',
      exitCode: 0,
    });
    const result = await makeOp(store, mixedRunner)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not apply the plan to 'src/b.ts'");
      // No rollback message: nothing had been written to roll back.
      expect(result.error).not.toContain('rolled back');
      expect(result.error).not.toContain('already written');
    }
    expect(store.written.size).toBe(0);
  });

  test('an EMPTY planned-edit set is the honest ok: zero counts plus the note — not a silent success', async () => {
    const store = memoryStore('/ws', {
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

  test('an EMPTY plan under dryRun stays a dry-run report, not an applied one', async () => {
    const store = memoryStore('/ws', {
      ...FIXTURE_FILES,
      [SIDECAR_PATH]: sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    });
    const result = await makeOp(store, codemodRunner({}))({ ...baseInput(), dryRun: true });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('dry-run');
    expect(result.value.plannedEdits).toBe(0);
    expect(store.written.size).toBe(0);
  });

  test('a cluster with ZERO target files short-circuits: honest empty ok, the runner is never invoked (M2)', async () => {
    // Every member failure carries file: null — nothing is addressable.
    const report = clusterErrors({
      tool: 'eslint',
      exitCode: 1,
      failures: [
        failureOf({ file: null, line: 1, column: 1, message: 'unattributed failure one' }),
        failureOf({ file: null, line: 2, column: 1, message: 'unattributed failure two' }),
      ],
    });
    const files = {
      [SIDECAR_PATH]: sidecarTextFor(report, {}),
    };
    const store = memoryStore('/ws', files);
    const probingRunner: RunCheck & { commands: unknown[] } = Object.assign(
      async () => {
        throw new Error('the scan must not run for a zero-target cluster');
      },
      { commands: [] },
    );
    for (const dryRun of [true, false]) {
      const result = await makeOp(
        store,
        probingRunner,
      )({
        ...baseInput(),
        clusterId: report.clusters[0]?.id ?? '',
        dryRun,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') continue;
      expect(result.value.mode).toBe(dryRun ? 'dry-run' : 'applied');
      expect(result.value.targets).toEqual([]);
      expect(result.value.plannedEdits).toBe(0);
      expect(result.value.files).toEqual([]);
      expect(result.value.note).toContain('no target files');
    }
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
    const store = memoryStore('/ws', { ...files, [SIDECAR_PATH]: sidecarTextFor(report, files) });
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
