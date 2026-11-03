// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the install
// leg and required-artifact failures.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupScratch,
  expectNoLeftoverPrefixes,
  installFakeNpm,
  makeTarball,
  runSmoke,
  scratch,
} from './packed-smoke.helpers.js';

afterEach(cleanupScratch);

describe('packed-smoke failure paths', () => {
  it('fails with the install leg named when npm install exits nonzero, and cleans up the prefix', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'fail');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'install' failed");
    expect(result.stderr).toContain('exited 3');
    expectNoLeftoverPrefixes(dir);
  });

  it('fails when the installed tree is missing a required artifact, and names it', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-strip-patterns');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required artifacts');
    expect(result.stderr).toContain('policy/denylist/patterns.yml');
    expectNoLeftoverPrefixes(dir);
  });
});
