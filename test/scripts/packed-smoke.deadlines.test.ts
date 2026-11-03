// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the MCP leg
// deadline bounds: a bin that answers but never exits past EOF, and one that
// consumes the requests but never answers.
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
  it('bounded-fails the mcp leg when the bin responds but never exits past EOF (P2)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-hung-mcp');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=3000'], {
      fakeBinDir: fake,
      tempRoot: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'mcp-bin' failed");
    expect(result.stderr).toContain('leg deadline');
    expectNoLeftoverPrefixes(dir);
  });

  it('reports a collecting-phase timeout as such, not as an unrelated early exit (#607)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-silent-mcp');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=3000'], {
      fakeBinDir: fake,
      tempRoot: dir,
      timeoutMs: 60_000,
    });
    // The MCP bin consumes the requests but never answers: the deadline
    // fires during the collecting phase and the failure must be named as a
    // collecting-phase timeout, distinct from a pre-deadline early exit.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'mcp-bin' failed");
    expect(result.stderr).toContain('collecting-phase timeout');
    expect(result.stderr).not.toContain('exited early');
    expectNoLeftoverPrefixes(dir);
  });
});
