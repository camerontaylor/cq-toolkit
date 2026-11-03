// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the installed
// integrity-provenance contract: hidden lockfile, legacy package.json fallback,
// honest null, and a malformed lockfile.
import { readFileSync } from 'node:fs';
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

describe('packed-smoke installed integrity provenance', () => {
  function summaryFor(behavior: Parameters<typeof installFakeNpm>[1]): {
    integrity: string | null;
    status: number | null;
    stderr: string;
  } {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), behavior);
    const out = join(dir, 'summary.json');
    const result = runSmoke([`--tarball=${tarball}`, `--out=${out}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expectNoLeftoverPrefixes(dir);
    const summary = JSON.parse(readFileSync(out, 'utf8')) as {
      installed: { integrity: string | null };
    };
    return { integrity: summary.installed.integrity, status: result.status, stderr: result.stderr };
  }

  it('reads integrity from the hidden npm lockfile entry for PKG_DIR', () => {
    // Covered end-to-end above; pinned here as the provenance contract.
    expect(summaryFor('populate')).toMatchObject({ integrity: 'sha512-fixture', status: 0 });
  });

  it('reports null when no install source records integrity', () => {
    const summary = summaryFor('populate-no-integrity');
    expect(summary).toMatchObject({ integrity: null, status: 0 });
    expect(summary.stderr).not.toContain('undefined');
  });

  it('falls back to the package.json _integrity when the hidden lockfile is absent', () => {
    expect(summaryFor('populate-package-integrity')).toMatchObject({
      integrity: 'sha512-legacy',
      status: 0,
    });
  });

  it('ignores a malformed hidden lockfile instead of throwing', () => {
    expect(summaryFor('populate-malformed-hidden-lock')).toMatchObject({
      integrity: null,
      status: 0,
    });
  });
});
