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
// ABSENT vs BROKEN (the tolerance is narrow): an ABSENT family registry is
// expected (families land in later phases) and contributes no entries — but
// only a not-found rejection whose resolution target IS the requested family
// `registry.js` itself is treated as absent (classifier mirrors the SDK
// presence idiom: code ERR_MODULE_NOT_FOUND + `Cannot find module '<path>'`,
// or the module runner's `Could not resolve "<path>"`). A PRESENT-but-broken
// registry — a syntax error, an evaluation throw, a not-found for a
// TRANSITIVE dependency of the registry module, any other rejection — throws
// loudly, naming the family, the requested path, and the original message
// (attached as `cause`). Defects that also surface loudly: a registry export
// that is not an array, a malformed entry, or a duplicate op name across
// families — all throw immediately.
//
// Results are cached per resolved ops root (as a promise), so repeated
// list()/get() calls do not rescan or re-import.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Classify ONE family-registry import rejection: 'absent' ONLY for the known
 * resolution-error shapes naming the REQUESTED registry path itself as the
 * quoted resolution target — node's `ERR_MODULE_NOT_FOUND` +
 * `Cannot find module '<path>'` (or the module runner's
 * `Could not resolve "<path>"`). `target` is the specifier the registry was
 * imported through — a plain fs path on POSIX, a FILE URL on win32 (see the
 * import site below); when it is a file URL the two runtimes quote different
 * spellings of that ONE requested module (node's native loader prints the
 * decoded path, the vitest module runner prints the URL as given), so both
 * spellings are matched — they name the REQUESTED registry itself, never a
 * transitive dependency, and the tolerance stays exactly this narrow.
 * Everything else — a not-found for a TRANSITIVE dependency of the registry
 * module (the requested path appears only as the IMPORTING module, never as
 * the quoted target), a syntax error, an evaluation throw, junk — is
 * 'broken'.
 */
function isAbsentFamilyRegistry(err: unknown, target: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  // The file-URL spelling's other face: its decoded path. For a plain-path
  // target fileURLToPath throws (not a URL) and the list stays single-entry.
  let decodedPath: string | undefined;
  try {
    decodedPath = fileURLToPath(target);
  } catch {
    decodedPath = undefined;
  }
  const targets = decodedPath === undefined ? [target] : [target, decodedPath];
  return targets.some(
    (candidate) =>
      (code === 'ERR_MODULE_NOT_FOUND' &&
        message.includes(`Cannot find module '${candidate}'`)) ||
      message.includes(`Could not resolve "${candidate}"`),
  );
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
    // Discovered-path import, win32-safe: a constructed plain fs path cannot
    // be imported on win32 (`import('C:\\...')` parses `c:` as a URL scheme
    // — ERR_UNSUPPORTED_ESM_URL_SCHEME), so there the path is converted to a
    // FILE URL first (pathToFileURL). POSIX keeps the plain path: it is
    // already a valid specifier, and the vitest module runner resolves the
    // NESTED relative dynamic imports inside a family registry (the
    // convention's canonical `import('./<name>.js')` importer) against the
    // file-URL module id AS AN FS PATH — importing registries via file URLs
    // breaks every family's lazy importers under vitest. TypeScript must NOT
    // statically resolve this specifier — families are discovered at runtime.
    const registryPath = path.join(root, family, 'registry.js');
    const registrySpecifier =
      process.platform === 'win32' ? pathToFileURL(registryPath).href : registryPath;
    let mod: unknown;
    try {
      mod = await import(registrySpecifier);
    } catch (err) {
      if (isAbsentFamilyRegistry(err, registrySpecifier)) {
        continue; // absent family registry — the family lands in a later phase
      }
      throw new Error(
        `op family '${family}': registry module ${registrySpecifier} failed to load ` +
          `(broken registry): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
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
