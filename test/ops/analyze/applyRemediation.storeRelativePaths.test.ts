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
// applyRemediation.applyAcceptance.test.ts,
// applyRemediation.approvalBoundary.test.ts,
// applyRemediation.lockFaultTokenFate.test.ts and
// applyRemediation.helpers.ts.
import { resolve, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  FIXTURE_FILES,
  approvedAuthority,
  baseInput,
  codemodRunner,
  fixtureReport,
  makeOp,
  memoryStore,
  sidecarTextFor,
} from './applyRemediation.helpers.js';

describe('applyRemediation store-relative path discipline (M1 regressions)', () => {
  test('a RELATIVE sidecarPath with a NESTED dir component (no input.dir): the store is rooted at its dirname and reads the basename', async () => {
    // Pre-M1 the op passed the FULL sidecarPath to a store rooted at
    // dirname(sidecarPath): the read resolved to
    // 'ws/reports/ws/reports/analysis-….json' and failed — or, with lenient
    // fakes, silently read nothing. The store-relative form is the basename.
    const root = 'ws/reports';
    const sidecarPath = `${root}/analysis-deadbeef.sidecar.json`;
    const files = {
      'src/a.ts': FIXTURE_FILES['src/a.ts'] as string,
      'src/b.ts': FIXTURE_FILES['src/b.ts'] as string,
      'analysis-deadbeef.sidecar.json': sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    };
    const store = memoryStore(root, files);
    const result = await makeOp(
      store,
      codemodRunner(FIXTURE_FILES),
      // The op's workspace is the RESOLVED nested root, not '/ws', so the
      // state reader has to report that same workspace. The default reader is
      // pinned to '/ws'; leaving it in place would have admission refuse the
      // (correct) approval on the kernel-to-admission state comparison, and
      // the test would be measuring the state binding rather than path
      // discipline.
      approvedAuthority({
        read: () =>
          Promise.resolve({
            workspace: resolve(root),
            headSha: 'head-at-approval',
            treeClean: true,
          }),
      }).authority,
    )({
      ...baseInput(),
      sidecarPath,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(2);
    // The writes landed inside the nested root, anchored on the RESOLVED
    // root: every key is under it, and NONE of them re-enters a 'ws'
    // segment below it (the double-root signature '…/ws/reports/ws/…' that
    // a root-joined write path would produce).
    const rootAbs = resolve(root);
    expect(store.written.get(resolve(root, 'src/a.ts'))).toBeDefined();
    expect(
      [...store.written.keys()].every(
        (key) => key.startsWith(`${rootAbs}${sep}`) && !key.includes(`${rootAbs}${sep}ws${sep}`),
      ),
    ).toBe(true);
  });

  test('an EXPLICIT input.dir keeps working with a nested sidecar: addressed relative to dir', async () => {
    // dir given → the store is rooted at dir and the sidecar (in a nested
    // reports/ directory under it) must be addressed relative to dir.
    const files = {
      'src/a.ts': FIXTURE_FILES['src/a.ts'] as string,
      'src/b.ts': FIXTURE_FILES['src/b.ts'] as string,
      'reports/analysis-deadbeef.sidecar.json': sidecarTextFor(fixtureReport(), FIXTURE_FILES),
    };
    const store = memoryStore('/ws', files);
    const result = await makeOp(
      store,
      codemodRunner(FIXTURE_FILES),
    )({
      ...baseInput(),
      sidecarPath: '/ws/reports/analysis-deadbeef.sidecar.json',
      dir: '/ws',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(2);
    expect(store.written.get(resolve('/ws', 'src/b.ts'))).toBeDefined();
  });
});
