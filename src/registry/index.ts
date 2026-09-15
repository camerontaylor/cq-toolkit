// Central op registry — lazy family aggregation over src/ops.
//
// FAMILY CONVENTION (defined by this lane): every op family exports
// `src/ops/<family>/registry.ts` containing
//
//   export const registry: OpRegistryEntry[];
//
// where each entry is `{ name, inputSchema, importer }`:
//   - `name`       — the globally unique op name (unique across ALL families).
//   - `inputSchema`— a zod schema validating the JSON-serializable op input
//                    before dispatch.
//   - `importer`   — `() => Promise<Op>`; canonical form
//                    `async () => (await import('./<name>.js')).default` —
//                    the op module `src/ops/<family>/<name>.ts` DEFAULT-exports
//                    the op function, and the importer unwraps the module
//                    namespace to it (lazy: the module loads only on dispatch).
//
// Aggregation here NEVER imports an op module or a family registry module at
// construction: importing this module does no fs work and no dynamic imports.
// Discovery happens lazily on the first list()/get() call — a runtime
// directory scan of the ops root (one level: family directories), then a lazy
// dynamic import of each family's `registry.js`, then (only when an op is
// actually dispatched) the entry's own `importer()` pulls the op module in.
// Missing family registries are expected (families land in later phases): an
// import that rejects simply contributes no entries. Defects that DO surface
// loudly: a registry export that is not an array, a malformed entry, or a
// duplicate op name across families — all throw immediately.
//
// Results are cached per resolved ops root (as a promise), so repeated
// list()/get() calls do not rescan or re-import.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpRegistryEntry } from '../kernel/types.js';

const listCache = new Map<string, Promise<OpRegistryEntry[]>>();

/**
 * Default ops root: `src/ops` under vitest (source layout), `dist/ops` in the
 * built package — resolved relative to this module's compiled location.
 */
export function defaultOpsRoot(): string {
  return fileURLToPath(new URL('../ops', import.meta.url));
}

/**
 * Aggregate every landed op family's registry entries. Scans `opsRoot`
 * (default {@link defaultOpsRoot}) for directories only; a root that does not
 * exist means no family has landed yet and yields `[]`.
 */
export function list(opts?: { opsRoot?: string }): Promise<OpRegistryEntry[]> {
  const root = path.resolve(opts?.opsRoot ?? defaultOpsRoot());
  let cached = listCache.get(root);
  if (cached === undefined) {
    cached = scanOps(root);
    listCache.set(root, cached);
  }
  return cached;
}

/**
 * Look up one op registry entry by name across all families, or `undefined`
 * when no family registers that name.
 */
export async function get(
  name: string,
  opts?: { opsRoot?: string },
): Promise<OpRegistryEntry | undefined> {
  return (await list(opts)).find((entry) => entry.name === name);
}

/** One directory scan + lazy family-registry imports, per resolved root. */
async function scanOps(root: string): Promise<OpRegistryEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return []; // no family has landed yet
    }
    throw err;
  }
  const entries: OpRegistryEntry[] = [];
  const familyOf = new Map<string, string>(); // op name -> family (integrity)
  const families = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();
  for (const family of families) {
    // Plain string concatenation into import(): TypeScript must NOT
    // statically resolve this specifier — families are discovered at runtime.
    let mod: unknown;
    try {
      mod = await import(root + '/' + family + '/registry.js');
    } catch {
      continue; // family registry absent — the family lands in a later phase
    }
    const registry = (mod as { registry?: unknown }).registry;
    if (!Array.isArray(registry)) {
      throw new Error(
        `op family '${family}': registry.js must export 'registry' as an array of OpRegistryEntry ` +
          `(got ${registry === null ? 'null' : typeof registry})`,
      );
    }
    for (const entry of registry) {
      const e = entry as Partial<OpRegistryEntry> | null | undefined;
      if (typeof e?.name !== 'string' || e.name === '') {
        throw new Error(
          `op family '${family}': registry entry must have a non-empty string 'name'`,
        );
      }
      if (typeof e?.inputSchema?.parse !== 'function') {
        throw new Error(
          `op family '${family}': op '${e?.name}' registry entry must have an 'inputSchema' ` +
            `with a .parse function (zod schema)`,
        );
      }
      if (typeof e?.importer !== 'function') {
        throw new Error(
          `op family '${family}': op '${e?.name}' registry entry must have an 'importer' ` +
            `function (() => Promise<Op>)`,
        );
      }
      const previous = familyOf.get(e.name);
      if (previous !== undefined) {
        throw new Error(
          `duplicate op name '${e.name}' registered by both family '${previous}' and family '${family}'`,
        );
      }
      familyOf.set(e.name, family);
      entries.push(e as OpRegistryEntry);
    }
  }
  return entries;
}
