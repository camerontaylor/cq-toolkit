// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory (family-scan,
// subcommand-surface, fixture-root, integrity, absent-vs-broken,
// file-url-import, plan-registry, barrel-aliases); the shared fixtures and
// helpers live here. The original file header is kept below with the family.
//
// I1 registry completeness — test/cli/registry.test.ts (now the
// registry.*.test.ts siblings in this directory).
//
// What is pinned here (phase-4 T4.2 completed the closure; the MECHANISM has
// teeth):
//   1. The src/ops family scan sees every planned family dir (the scan is
//      exercised for real, not vacuously).
//   2. The teeth (PER FAMILY): every op module a family dir contains (`*.ts`
//      except registry.ts / index.ts / *.test.ts / *.d.ts) must be COVERED by
//      THAT family's own registry module (source-layout import of registry.ts
//      through vitest). Coverage (the completeness heuristic, amended at the
//      phase-2 integration, PR 64): an entry named exactly `<base>`, OR an
//      entry name ENDING `.<base>` (family-prefixed entry names — lane C's
//      'gates.checkRunner' covers 'checkRunner.ts'), OR the family registry
//      module itself references `./<base>` (a helper the registry wires in —
//      e.g. gates' fingerprint.ts — is family surface, not an orphan op). A
//      global name set would mask an orphan in family alpha behind family
//      beta's registered op of the same name. A family whose registry.ts does
//      not yield a `registry` array — absent (a future family, before its
//      registry lands) or loads-clean-nonconforming (an interim internal
//      registry) — is NOT scanned for orphans: it must be surfaced in
//      listWithDiagnostics().skippedFamilies instead, and is collected as a
//      violation only if it appears in NEITHER place (entries nor skipped).
//   3. Every registry entry has a subcommand: subcommandNames(list()) covers
//      all entry names plus 'run-plan'; the empty registry still yields
//      ['run-plan']. T4.2 closed the family convention (ratchet's interim
//      metric-adapter registry moved to metricRegistry.ts), so the default
//      root now reports an EMPTY skippedFamilies — the tolerance stays
//      surfaced for future families.
//   4. Fixture-root DI: the pure-op fixture family under
//      test/fixtures/cli-ops/ resolves exactly its six names through the
//      same list()/get() seam, and get('echo').importer() yields an async fn.
//   5. Registry integrity defects surface loudly: duplicate op names across
//      families reject naming the op; a malformed entry (no inputSchema/
//      importer) rejects.
//   6. ABSENT vs BROKEN (the narrow tolerance): a family dir with no
//      registry.js resolves to no entries; a PRESENT-but-broken registry
//      (an evaluation throw, or a registry importing a MISSING TRANSITIVE
//      dep) rejects loudly naming the family — only a not-found for the
//      requested registry.js itself counts as absent.
//   7. Plan-registry discovery (src/plans): sibling modules in BOTH layouts
//      (.ts source and .js dist) are discovered; reserved stems (registry/
//      index, whatever the extension), *.test.* siblings, and .d.ts
//      declaration files are skipped.
//   8. The root barrel exposes the registry as listOps/getOp aliases — the
//      generic list/get names never sit on it (star-export collision rule).
//
// Fixture/generated registries are plain ESM .js files (package
// "type":"module") that import 'zod' from the repo's node_modules — so the
// throwaway tmp roots for (5) are created under <repo>/node_modules, where
// that bare specifier resolves; nothing else ever touches them and each test
// cleans up with rm.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const srcOps = fileURLToPath(new URL('../../src/ops/', import.meta.url));
export const fixtureOps = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));
// Under the repo so generated `.js` registries can bare-import 'zod'.
export const tmpParent = fileURLToPath(new URL('../../node_modules/', import.meta.url));

/** Every planned op family dir (phase-4 T4.2 completes this closure). */
export const PLANNED_FAMILIES = [
  'gates',
  'ledger',
  'review',
  'merge',
  'ratchet',
  'sweep',
  'pr',
  'analyze',
];

const tmpDirs: string[] = [];

/**
 * Registers this test file's afterEach cleanup for every tmp root it made.
 *
 * A per-file binding (rather than an import-time hook) keeps the cleanup
 * visible in the file that owns the fixtures.
 */
export function registerRegistryTmpCleanup(): void {
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });
}

/** Make a fresh tmp ops root under the repo (zod-resolvable), auto-cleaned. */
export async function makeTmpOpsRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpParent, prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Fresh tmp plans root (OS tmpdir) carrying its own package.json
 * {"type":"module"} so the generated `.js` plan sibling is ESM; the `.ts`
 * siblings are plain erasable syntax, transformed by the module runner.
 * Nothing here needs the repo's node_modules (plan modules are pure data).
 */
export async function makeTmpPlansRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  tmpDirs.push(dir);
  return dir;
}

/** One valid single-entry family registry as generated ESM .js source. */
export function registrySource(opName: string): string {
  return [
    "import { z } from 'zod';",
    'export const registry = [',
    `  { name: '${opName}', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: null }) },`,
    '];',
    '',
  ].join('\n');
}
