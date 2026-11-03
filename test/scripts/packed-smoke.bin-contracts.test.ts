// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the installed
// bin and export contract failures: refusing/broken bins, a broken root export,
// and missing or misrouted .bin mappings.
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
  it('fails with the mcp leg named when the installed MCP bin refuses startup (exit 78)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-refusing-mcp');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'mcp-bin' failed");
    expect(result.stderr).toContain('exited early');
    expectNoLeftoverPrefixes(dir);
  });

  it('fails with the cli leg named when the installed cq bin violates the usage contract', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-broken-cli');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'cli-bin' failed");
    expectNoLeftoverPrefixes(dir);
  });

  it('fails the sdk leg when the exports field does not map the root even though dist/index.js exists (P1)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-broken-exports');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'sdk-import' failed");
    expectNoLeftoverPrefixes(dir);
  });

  it('fails the cq leg when the .bin/cq mapping is missing while its dist target exists (re-review P2)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-missing-bin-cq');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'cli-bin' failed");
    expect(result.stderr).toContain('bin mapping missing');
    // This refusal carries no child tails at all; an omitted field must not
    // interpolate the literal `undefined` into the failure text.
    expect(result.stderr).not.toContain('undefined');
    expectNoLeftoverPrefixes(dir);
  });

  it('fails the mcp leg when .bin/cq-harness-mcp is misrouted at another dist file (re-review P2)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-misrouted-bin-mcp');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    // The misrouted mapping runs dist/cli.js instead of the MCP bin: the
    // child exits 2 with the usage artifact instead of serving JSON-RPC,
    // so the mcp leg must fail with its early-exit verdict.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'mcp-bin' failed");
    expect(result.stderr).toContain('exited early');
    expect(result.stderr).not.toContain('undefined');
    expectNoLeftoverPrefixes(dir);
  });
});
