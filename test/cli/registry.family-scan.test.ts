// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the src/ops family scan and its per-family completeness
// teeth (invariants 1 and 2 of that header).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listWithDiagnostics } from '../../src/registry/index.js';
import { PLANNED_FAMILIES, srcOps } from './registry.helpers.js';

describe('registry family scan (src/ops)', () => {
  test('family scan sees every planned family dir', () => {
    const families = readdirSync(srcOps, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    for (const planned of PLANNED_FAMILIES) {
      expect(families).toContain(planned);
    }
  });

  test('no op module without a registry entry (scoped per family)', async () => {
    // The check is PER FAMILY: a single global name set would mask an orphan
    // — family alpha's uncovered op module hides behind family beta's
    // registered op of the same name. Each family's candidates are matched
    // against THAT family's own registry module (imported at source layout —
    // `registry.ts` — through the vitest module runner). Coverage is the
    // amended completeness heuristic (PR 64 integration): an entry named
    // exactly `<base>`, an entry name ending `.<base>` (family-prefixed —
    // 'gates.checkRunner' covers 'checkRunner.ts'), or a `./<base>` reference
    // in the registry module's own source (a helper the registry wires in —
    // gates' fingerprint.ts — is family surface, not an orphan op). A family
    // whose registry.ts does not yield a `registry` array — absent (a future
    // family) or loads-clean-nonconforming (an interim internal registry) —
    // is NOT scanned for orphans: it must be surfaced in
    // listWithDiagnostics().skippedFamilies (asserted in the
    // subcommand-surface test), and is collected as a violation only if it
    // appears in NEITHER place.
    const families = readdirSync(srcOps, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    const { skippedFamilies } = await listWithDiagnostics();
    const skipped = new Set(skippedFamilies);
    const violations: string[] = [];
    for (const family of families) {
      const dirents = readdirSync(join(srcOps, family), { withFileTypes: true });
      const candidateNames = dirents
        .filter(
          (dirent) =>
            dirent.isFile() &&
            dirent.name.endsWith('.ts') &&
            dirent.name !== 'registry.ts' &&
            dirent.name !== 'index.ts' &&
            // A `.d.ts` declaration file is ambient typing, never an op module
            // (mirror of planModuleStem in src/plans/registry.ts) — without
            // this, a future types.d.ts is misread as op 'types.d'.
            !dirent.name.endsWith('.d.ts') &&
            !dirent.name.endsWith('.test.ts'),
        )
        .map((dirent) => dirent.name.replace(/\.ts$/, ''));
      const hasRegistry = dirents.some(
        (dirent) => dirent.isFile() && dirent.name === 'registry.ts',
      );
      if (!hasRegistry) {
        // No registry module to scan against. A bare family (no candidates)
        // has nothing to cover; a module-bearing family (e.g. review's
        // helpers, landed ahead of any registry) contributes no entries and
        // is tolerated/surfaced as absent — a violation only if it appears
        // in NEITHER place (no entries and not in skippedFamilies).
        if (candidateNames.length > 0 && !skipped.has(family)) {
          violations.push(
            `src/ops/${family}: op module(s) ${candidateNames.join(', ')} with no registry.ts, ` +
              'and the family is surfaced neither by registry entries nor skippedFamilies',
          );
        }
        continue;
      }
      // Source-layout import of the family's own registry — the .ts specifier
      // resolves under vitest exactly like every other src import in this
      // suite; the convention's lazy `import('./<name>.js')` importers are
      // not invoked here (import only evaluates the module body).
      let entryNames: Set<string> | undefined;
      try {
        const mod = (await import(join(srcOps, family, 'registry.ts'))) as {
          registry?: unknown;
        };
        if (Array.isArray(mod.registry)) {
          entryNames = new Set(
            (mod.registry as Array<{ name?: unknown }>).map((entry) => String(entry?.name)),
          );
        }
      } catch (err) {
        violations.push(
          `src/ops/${family}/registry.ts failed to load: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (entryNames === undefined) {
        // Loads clean but exports no `registry` array — a NONCONFORMING
        // family (an interim internal registry): not scanned for orphans;
        // the central registry must surface it (skippedFamilies), else it
        // appears in neither place.
        if (!skipped.has(family)) {
          violations.push(
            `src/ops/${family}: registry.ts exports no 'registry' array and the family is ` +
              'surfaced neither by registry entries nor skippedFamilies',
          );
        }
        continue;
      }
      // The registry module's own source, for the helper-reference excusal:
      // a candidate whose module the registry itself imports (type-only
      // helper imports count — the convention routes every REGISTERED op
      // through an entry, so an unreferenced candidate is an orphan).
      const registrySource = readFileSync(join(srcOps, family, 'registry.ts'), 'utf8');
      const referencesModule = (base: string): boolean =>
        [`'./${base}.js'`, `"./${base}.js"`, `'./${base}'`, `"./${base}"`].some((ref) =>
          registrySource.includes(ref),
        );
      for (const opName of candidateNames) {
        const covered =
          entryNames.has(opName) ||
          [...entryNames].some((name) => name.endsWith(`.${opName}`)) ||
          referencesModule(opName);
        if (!covered) {
          violations.push(`src/ops/${family}: no registry entry named '${opName}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
