// Central plan registry — lazy aggregation over sibling plan modules.
//
// CONVENTION (defined by this lane): a plan is contributed by a FILE in this
// directory (src/plans/<name>.ts) exporting
//
//   export const plan: PlanRegistryEntry;
//
// Later lanes (phase 3) add plans by adding such a file — they NEVER edit
// this registry. Discovery is lazy: importing this module does no fs work and
// no dynamic imports; the first listPlans()/getPlan() call scans this
// directory (same directory this file lives in), dynamic-imports every
// sibling module file in BOTH layouts — `*.js` (the compiled dist layout)
// and `*.ts` (the source layout, exactly what phase-3 lanes add; a `.d.ts`
// declaration file is not a module and is never imported) — except the
// reserved stems `registry` and `index` (whatever their extension) and
// `*.test.*` siblings, and collects the modules that export a valid `plan`.
// The discovered filename is imported AS-IS: under vitest a `.ts` import
// transforms fine, and in dist the only siblings present are `.js`. A
// sibling without a `plan` export is simply not a plan module; a malformed
// `plan` export or a duplicate plan name throws immediately.
//
// Results are cached per resolved plans root (as a promise), so repeated
// listPlans()/getPlan() calls do not rescan or re-import.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PlanRegistryEntry } from '../kernel/types.js';

const listCache = new Map<string, Promise<PlanRegistryEntry[]>>();

/**
 * Default plans root: the directory this module lives in (`src/plans` under
 * vitest, `dist/plans` in the built package).
 */
export function defaultPlansRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

/**
 * Aggregate every plan exported by a sibling module. Scans `plansRoot`
 * (default {@link defaultPlansRoot}) for files only, skipping the registry
 * and barrel modules and tests; a root that does not exist yields `[]`.
 */
export function listPlans(opts?: { plansRoot?: string }): Promise<PlanRegistryEntry[]> {
  const root = path.resolve(opts?.plansRoot ?? defaultPlansRoot());
  let cached = listCache.get(root);
  if (cached === undefined) {
    cached = scanPlans(root);
    listCache.set(root, cached);
  }
  return cached;
}

/**
 * Look up one plan registry entry by name, or `undefined` when no sibling
 * module registers that plan name.
 */
export async function getPlan(
  name: string,
  opts?: { plansRoot?: string },
): Promise<PlanRegistryEntry | undefined> {
  return (await listPlans(opts)).find((entry) => entry.name === name);
}

/**
 * The module stem of a discovered sibling filename, or `undefined` when the
 * file is not an importable plan-module candidate: only `.js` (dist layout)
 * and `.ts` (source layout) qualify — a `.d.ts` declaration file is
 * ambient typing, never a module.
 */
function planModuleStem(file: string): string | undefined {
  if (file.endsWith('.d.ts')) return undefined;
  if (file.endsWith('.js') || file.endsWith('.ts')) return file.slice(0, -3);
  return undefined;
}

/** One directory scan + lazy sibling imports, per resolved root. */
async function scanPlans(root: string): Promise<PlanRegistryEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const files = dirents
    .filter((dirent) => dirent.isFile() && planModuleStem(dirent.name) !== undefined)
    .map((dirent) => dirent.name)
    .sort();
  const entries: PlanRegistryEntry[] = [];
  const fileOf = new Map<string, string>(); // plan name -> module (integrity)
  for (const file of files) {
    // Reserved names are skipped by STEM, whatever the layout's extension,
    // and so are test siblings in either layout (`foo.test.js`/`foo.test.ts`).
    const stem = planModuleStem(file) ?? '';
    if (stem === 'registry' || stem === 'index' || stem.endsWith('.test')) {
      continue;
    }
    // Discovered-path import, URL-safe (same rationale as the family scan
    // in src/registry/index.ts). Node parses import specifiers with URL
    // semantics, so the conversion has three cases:
    //   - win32: a plain fs path cannot be imported (`import('C:\\...')`
    //     parses `c:` as a URL scheme — ERR_UNSUPPORTED_ESM_URL_SCHEME) →
    //     convert to a FILE URL (pathToFileURL).
    //   - a POSIX path containing `#`, `?`, or `%`: the raw path would
    //     truncate (`#` starts a fragment, `?` a query) or misparse (`%`
    //     starts an invalid escape) → convert too (pathToFileURL
    //     percent-escapes them). (A backslash is NOT this case — it is
    //     unaddressable either way and refused above, review-debt #85.)
    //   - every other POSIX path: keep the plain path — it is already a
    //     valid specifier, and the vitest module runner resolves
    //     sibling-relative imports inside plan modules against the file-URL
    //     module id AS AN FS PATH, breaking plan discovery under test. The
    //     caveat stays true exactly for these normal POSIX paths.
    // TypeScript must NOT statically resolve this specifier — plan modules
    // are discovered at runtime.
    const modulePath = path.join(root, file);
    // A POSIX path containing a backslash is UNADDRESSABLE as an ESM
    // module (review-debt #85) — neither the raw specifier (re-resolves
    // with the backslash as a separator) nor a percent-encoded file URL
    // (rejected: "must not include encoded '/' or '\\'") can import it.
    // Refuse loudly with the reason; win32 is exempt (backslash is its
    // separator and the conversion below handles it).
    if (process.platform !== 'win32' && modulePath.includes('\\')) {
      throw new Error(
        `plan scan: the plan module path '${modulePath}' contains a backslash — Node's ESM import addressing treats '\\' as a path separator on every platform, so the module cannot be imported; rename the file or directory`,
      );
    }
    const specifier =
      process.platform === 'win32' || /[#?%]/.test(modulePath)
        ? pathToFileURL(modulePath).href
        : modulePath;
    const mod: unknown = await import(specifier);
    const plan = (mod as { plan?: unknown }).plan;
    if (plan === undefined || plan === null) {
      continue; // not a plan module
    }
    const p = plan as Partial<PlanRegistryEntry> | null;
    if (typeof p !== 'object' || p === null) {
      throw new Error(
        `plan module '${file}': 'plan' export must be a PlanRegistryEntry object`,
      );
    }
    if (typeof p.name !== 'string' || p.name === '') {
      throw new Error(`plan module '${file}': plan.name must be a non-empty string`);
    }
    if (typeof p.importer !== 'function') {
      throw new Error(
        `plan module '${file}': plan.importer must be a function (() => Promise<Plan>)`,
      );
    }
    const previous = fileOf.get(p.name);
    if (previous !== undefined) {
      throw new Error(
        `duplicate plan name '${p.name}' exported by both '${previous}' and '${file}'`,
      );
    }
    fileOf.set(p.name, file);
    entries.push(p as PlanRegistryEntry);
  }
  return entries;
}
