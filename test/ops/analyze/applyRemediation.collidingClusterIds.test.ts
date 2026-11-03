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
// applyRemediation.storeRelativePaths.test.ts,
// applyRemediation.applyAcceptance.test.ts,
// applyRemediation.approvalBoundary.test.ts,
// applyRemediation.lockFaultTokenFate.test.ts and
// applyRemediation.helpers.ts.
import { describe, expect, test } from 'vitest';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';
import {
  SIDECAR_PATH,
  baseInput,
  codemodRunner,
  failureOf,
  makeOp,
  memoryStore,
  sidecarTextFor,
} from './applyRemediation.helpers.js';

describe('colliding cluster ids: the signature disambiguator (F2)', () => {
  // The G1-pinned FNV collision: two distinct signatures share one 32-bit id.
  const collidingReport = clusterErrors({
    tool: 'eslint',
    exitCode: 1,
    failures: [
      failureOf({ file: 'src/a.ts', ruleId: 'r', message: 'tjivlzyj' }),
      failureOf({ file: 'src/b.ts', ruleId: 'r', message: 'qcmqx' }),
    ],
  });
  const files = { 'src/a.ts': 'foo_bar();\n', 'src/b.ts': 'foo_bar();\n' };
  const [clusterA, clusterB] = collidingReport.clusters;

  test('WITHOUT the disambiguator an ambiguous id is a failed fault naming it', async () => {
    const store = memoryStore('/ws', {
      ...files,
      [SIDECAR_PATH]: sidecarTextFor(collidingReport, files),
    });
    const result = await makeOp(
      store,
      codemodRunner(files),
    )({
      ...baseInput(),
      clusterId: clusterA?.id ?? '',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(`ambiguous cluster id '${clusterA?.id}'`);
      expect(result.error).toContain('pass the cluster');
      expect(result.error).toContain('signature');
    }
    expect(store.written.size).toBe(0);
  });

  test('WITH the signature each colliding cluster applies independently', async () => {
    // A runner scoped like the real ast-grep: only the REQUESTED files'
    // matches come back (the scan is invoked with targets, not both files).
    const contents: Record<string, string> = files;
    const scopedRunner: RunCheck = async (cmd) => {
      const requested = cmd.args.slice(cmd.args.indexOf('--') + 1);
      const matches: object[] = [];
      for (const file of requested) {
        const text = contents[file] as string;
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
      return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
    };
    for (const cluster of [clusterA, clusterB]) {
      const freshStore = memoryStore('/ws', {
        ...files,
        [SIDECAR_PATH]: sidecarTextFor(collidingReport, files),
      });
      const result = await makeOp(
        freshStore,
        scopedRunner,
      )({
        ...baseInput(),
        clusterId: cluster?.id ?? '',
        signature: cluster?.signature ?? '',
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.value.mode !== 'applied') continue;
      // Each cluster's evidence targets only its own member file.
      const failure = (cluster?.failures[0] ?? null) as CheckFailure | null;
      expect(result.value.targets).toEqual(failure === null ? [] : [failure.file as string]);
      expect(result.value.clusterId).toBe(cluster === undefined ? '' : cluster.id);
    }
  });

  test('a WRONG disambiguating signature is a fault listing the id signatures', async () => {
    const store = memoryStore('/ws', {
      ...files,
      [SIDECAR_PATH]: sidecarTextFor(collidingReport, files),
    });
    const result = await makeOp(
      store,
      codemodRunner(files),
    )({
      ...baseInput(),
      clusterId: clusterA?.id ?? '',
      signature: 'no-match',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("no cluster with id '" + (clusterA?.id ?? '') + "'");
      expect(result.error).toContain(clusterA?.signature ?? '');
      expect(result.error).toContain(clusterB?.signature ?? '');
    }
  });
});
