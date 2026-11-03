// Split provenance: test/scripts/packed-smoke.test.ts was split by subject into
// packed-smoke.{usage,install,bin-contracts,deadlines,isolation,integrity,happy-path}.test.ts
// plus packed-smoke.helpers.ts (shared fixtures). This file carries the happy
// path over a stub-installed package: every leg passes and the summary carries
// tarball identity, on disk or on stdout.
import { existsSync, readFileSync } from 'node:fs';
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

describe('packed-smoke happy path over stubs', () => {
  it('passes all legs against a stub-installed package and writes the summary with tarball identity', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate');
    const out = join(dir, 'summary.json');
    const result = runSmoke([`--tarball=${tarball}`, `--out=${out}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    const summary = JSON.parse(readFileSync(out, 'utf8')) as {
      ok: boolean;
      tarball: { sha256: string; bytes: number; name: string };
      installed: { name: string; version: string; integrity: string | null };
      sdk: { seamVersion: string; harnessConfigTools: string[] };
      cli: { exit: number; errorKind: string };
      mcp: { serverName: string; tools: string[] };
      requiredArtifactsMissing?: string[];
    };
    expect(summary.ok).toBe(true);
    expect(summary.tarball.name).toBe('fixture.tgz');
    expect(summary.tarball.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.tarball.bytes).toBeGreaterThan(0);
    // The stub records integrity ONLY in the hidden npm lockfile, so this
    // asserts the modern-install provenance path, not a package.json field.
    expect(summary.installed).toEqual({
      name: '@camerontaylor/cq-toolkit',
      version: '9.9.9-fixture',
      integrity: 'sha512-fixture',
    });
    // SDK leg: the fixture-only seam value proves the import resolved the
    // INSTALLED package's dist, never this checkout's real dist.
    expect(summary.sdk.seamVersion).toBe('fixture-seam');
    expect(summary.sdk.harnessConfigTools).toContain('read');
    // cq leg: the stub bin honored the usage contract.
    expect(summary.cli).toEqual({ exit: 2, errorKind: 'usage' });
    // MCP leg: a real stdio round trip happened against the stub bin.
    expect(summary.mcp.serverName).toBe('cq-harness');
    expect(summary.mcp.tools).toEqual(['read', 'edit', 'bash']);
    expect(summary.requiredArtifactsMissing ?? []).toEqual([]);
    expectNoLeftoverPrefixes(dir);
  });

  it('prints the summary to stdout when --out is omitted', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
      tempRoot: dir,
    });
    expect(result.status, result.stderr).toBe(0);
    // The summary is a pretty-printed multi-line document; find its start.
    const start = result.stdout.indexOf('{\n  "ok"');
    const summary = JSON.parse(result.stdout.slice(start)) as { ok: boolean };
    expect(summary.ok).toBe(true);
  });
});
