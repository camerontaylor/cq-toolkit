// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the CLI
// usage surface: argv validation and rejection of positional arguments.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupScratch, makeTarball, runSmoke, scratch } from './packed-smoke.helpers.js';

afterEach(cleanupScratch);

describe('packed-smoke usage surface', () => {
  it('exits 2 on a missing flag, an unknown flag, a duplicate flag, a bad timeout, and a nonexistent tarball', () => {
    const tarball = makeTarball(scratch());
    for (const args of [
      [],
      [`--tarball=${tarball}`, '--bogus=1'],
      [`--tarball=${tarball}`, '--out=/tmp/a', '--out=/tmp/b'],
      [`--tarball=${tarball}`, '--timeout-ms=0'],
      [`--tarball=${tarball}`, '--timeout-ms=nope'],
      ['--tarball=/nonexistent/fixture.tgz'],
    ]) {
      const result = runSmoke(args);
      expect(result.status, `args: ${args.join(' ')}`).toBe(2);
      expect(result.stderr).toContain('packed-smoke:');
    }
  });

  it('rejects positional arguments (named flags only)', () => {
    const tarball = makeTarball(scratch());
    const result = runSmoke([tarball]);
    expect(result.status).toBe(2);
  });
});
