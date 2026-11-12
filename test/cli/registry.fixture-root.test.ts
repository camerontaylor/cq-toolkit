// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries fixture-root DI over test/fixtures/cli-ops (invariant 4)
// and the backslash-root refusal that guards the same seam.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { get, list } from '../../src/registry/index.js';
import {
  fixtureOps,
  makeTmpOpsRoot,
  registerRegistryTmpCleanup,
  registrySource,
} from './registry.helpers.js';

registerRegistryTmpCleanup();

describe('fixture-root DI (test/fixtures/cli-ops)', () => {
  test('the fixture family resolves exactly its eight ops through the same seam', async () => {
    const names = (await list({ opsRoot: join(fixtureOps) })).map((entry) => entry.name).sort();
    // plainthrow/spendthrow are the #1195 throw twins (a bare rejection and a
    // rejection carrying the settled-usage carrier) — machine-mode-pins
    // dispatches them through the thrown-exit artifact contract.
    expect(names).toEqual([
      'boom',
      'budget',
      'echo',
      'garbage',
      'indet',
      'needshuman',
      'plainthrow',
      'spendthrow',
    ]);
  });

  // POSIX-only: on Windows '\' is a path separator, so `${tmp}\\dir` is a
  // nested child path whose name holds no backslash — and the registry only
  // refuses backslash-bearing family paths off win32 (src/registry/index.ts).
  test.skipIf(process.platform === 'win32')(
    'a BACKSLASH-bearing ops root is REFUSED loudly — it is unaddressable as an ESM module (review-debt #85)',
    async () => {
      // A POSIX directory legitimately named with a backslash (e.g. an
      // --ops-root like /tmp/a\b): Node parses import specifiers with URL
      // semantics where '\' splits as a path separator, so the raw path
      // resolves to a DIFFERENT (nonexistent) path — and empirically neither
      // escape form can rescue it (a percent-encoded file URL is rejected:
      // "must not include encoded '/' or '\'"). Verified against Node
      // 2026-09-16; the scan therefore refuses loudly with the reason
      // instead of a confusing not-found or a silent family skip.
      const tmp = await makeTmpOpsRoot('cq-registry-bs-');
      const bsRoot = `${tmp}\\dir`; // a child dir whose NAME contains a backslash
      await mkdir(bsRoot, { recursive: true });
      await mkdir(join(bsRoot, 'bsfam'), { recursive: true });
      await writeFile(join(bsRoot, 'bsfam', 'registry.js'), registrySource('bsop'));
      await expect(list({ opsRoot: bsRoot })).rejects.toThrow(
        /contains a backslash .* ESM import addressing treats '\\' as a path separator/s,
      );
    },
  );

  // win32-only: backslash IS the separator there, so a plain root must be
  // accepted with no backslash refusal.
  test.skipIf(process.platform !== 'win32')(
    'a normal Windows ops root is accepted (no backslash refusal on win32)',
    async () => {
      const tmp = await makeTmpOpsRoot('cq-registry-win-');
      await mkdir(join(tmp, 'winfam'), { recursive: true });
      await writeFile(join(tmp, 'winfam', 'registry.js'), registrySource('winop'));
      const names = (await list({ opsRoot: tmp })).map((entry) => entry.name);
      expect(names).toEqual(['winop']);
    },
  );

  test("get('echo') yields an entry whose importer() is an async op fn", async () => {
    const entry = await get('echo', { opsRoot: join(fixtureOps) });
    if (entry === undefined) throw new Error('fixture family: no registry entry named echo');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    expect(op.constructor.name.includes('AsyncFunction')).toBe(true);
  });
});
