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
// sibling `*.js` file except `registry.js`, `index.js`, and `*.test.js`, and
// collects the modules that export a valid `plan`. A sibling without a
// `plan` export is simply not a plan module; a malformed `plan` export or a
// duplicate plan name throws immediately.
//
// Results are cached per resolved plans root (as a promise), so repeated
// listPlans()/getPlan() calls do not rescan or re-import.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.js'))
    .map((dirent) => dirent.name)
    .sort();
  const entries: PlanRegistryEntry[] = [];
  const fileOf = new Map<string, string>(); // plan name -> module (integrity)
  for (const file of files) {
    if (file === 'registry.js' || file === 'index.js' || file.endsWith('.test.js')) {
      continue;
    }
    // Plain string concatenation into import(): TypeScript must NOT
    // statically resolve this specifier — plan modules are discovered at
    // runtime.
    const mod: unknown = await import(root + '/' + file);
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
