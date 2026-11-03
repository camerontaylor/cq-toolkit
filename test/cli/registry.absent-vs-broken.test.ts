// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the ABSENT vs BROKEN narrow tolerance (invariant 6).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { list, listWithDiagnostics } from '../../src/registry/index.js';
import { makeTmpOpsRoot, registerRegistryTmpCleanup } from './registry.helpers.js';

registerRegistryTmpCleanup();

describe('absent vs broken family registries (the narrow tolerance)', () => {
  test('an ABSENT registry.js is tolerated: the family contributes no entries', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-absent-');
    await mkdir(join(tmp, 'empty-family'), { recursive: true });
    // Only a not-found for the requested registry.js itself counts as absent.
    await expect(list({ opsRoot: tmp })).resolves.toEqual([]);
    // The tolerated absence is SURFACED, not silent (the diagnostics share
    // the same cached scan as the list() call above).
    const { entries, skippedFamilies } = await listWithDiagnostics({ opsRoot: tmp });
    expect(entries).toEqual([]);
    expect(skippedFamilies).toEqual(['empty-family']);
  });

  test('a NONCONFORMING registry (loads clean, no registry array) is skipped + surfaced', async () => {
    // The PR 64 amendment: a module that loads cleanly but exports no
    // `registry` array is not a broken family — it contributes no entries,
    // is NOT thrown over, and is surfaced in skippedFamilies (the real-world
    // case: lane-H ratchet's registry.ts is a metric-adapter registry until
    // the family conforms — T4.2). The diagnostics carry no entries for it.
    const tmp = await makeTmpOpsRoot('cq-registry-nonconforming-');
    await mkdir(join(tmp, 'interim'), { recursive: true });
    await writeFile(
      join(tmp, 'interim', 'registry.js'),
      'export const adapters = new Map();\nexport function listAdapters() {\n  return [];\n}\n',
    );
    const { entries, skippedFamilies } = await listWithDiagnostics({ opsRoot: tmp });
    expect(entries).toEqual([]);
    expect(skippedFamilies).toEqual(['interim']);
  });

  test('a PRESENT-but-broken registry (evaluation throw) rejects naming the family', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-kaboom-');
    await mkdir(join(tmp, 'kaboom-family'), { recursive: true });
    await writeFile(join(tmp, 'kaboom-family', 'registry.js'), "throw new Error('kaboom');\n");
    // Loud, not silently-tolerated: the message names the family and the
    // registry path (with the original error attached as cause).
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/kaboom-family/);
  });

  test('a registry importing a MISSING TRANSITIVE dep rejects (not tolerated as absent)', async () => {
    // The not-found names './nope-missing.js' — a transitive dependency — as
    // the resolution target, never the requested registry.js itself, so the
    // absent classifier does not apply: this throws loudly.
    const tmp = await makeTmpOpsRoot('cq-registry-transitive-');
    await mkdir(join(tmp, 'transitive'), { recursive: true });
    await writeFile(
      join(tmp, 'transitive', 'registry.js'),
      "import './nope-missing.js';\nexport const registry = [];\n",
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/transitive/);
  });
});
