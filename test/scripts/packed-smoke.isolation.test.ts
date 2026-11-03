// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the child
// TMPDIR isolation contract (#608): the smoke's consumer prefix lives under the
// test's own root, never the shared system temp.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupScratch,
  installFakeNpm,
  makeTarball,
  runSmoke,
  scratch,
} from './packed-smoke.helpers.js';

afterEach(cleanupScratch);

describe('packed-smoke failure paths', () => {
  it('pins the child smoke TMPDIR to the test root, isolated from the system temp (#608)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate');
    // Plant a foreign cq-packed-consumer-* leftover in the SHARED system
    // temp, as an interrupted run would: this test's own cleanup verdict
    // must stay independent of it. The leftover is its OWN mkdtemp result —
    // a unique path nothing else owns — so cleanup removes only what this
    // test created, never pre-existing content.
    const sharedTmp = realpathSync(tmpdir());
    const foreign = realpathSync(
      mkdtempSync(join(sharedTmp, 'cq-packed-consumer-foreign-leftover-')),
    );
    try {
      const out = join(dir, 'summary.json');
      const result = runSmoke([`--tarball=${tarball}`, `--out=${out}`, '--timeout-ms=20000'], {
        fakeBinDir: fake,
        tempRoot: dir,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(out)).toBe(true);
      // The child's prefix was created INSIDE the test root, not the shared
      // temp, and was cleaned up there.
      expect(readdirSync(dir).some((name) => name.startsWith('cq-packed-consumer-'))).toBe(false);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});
