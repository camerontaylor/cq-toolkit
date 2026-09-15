// I1 registry completeness scaffold — test/cli/registry.test.ts.
//
// What is pinned here (full closure is phase-4 T4.2; the MECHANISM has teeth
// today):
//   1. The src/ops family scan sees every planned family dir (the scan is
//      exercised for real, not vacuously).
//   2. The teeth: every op module a family dir contains (`*.ts` except
//      registry.ts / index.ts / *.test.ts) must have a matching entry name
//      in `await list()` — basename === entry.name. Vacuously true today
//      (no op module has landed yet); the day one lands without a registry
//      entry, this fails naming the file and the missing entry.
//   3. Every registry entry has a subcommand: subcommandNames(list()) covers
//      all entry names plus 'run-plan'; the empty registry still yields
//      ['run-plan'].
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
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { subcommandNames } from '../../src/cli/main.js';
import { getPlan, listPlans } from '../../src/plans/registry.js';
import { get, list } from '../../src/registry/index.js';

const srcOps = fileURLToPath(new URL('../../src/ops/', import.meta.url));
const fixtureOps = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));
// Under the repo so generated `.js` registries can bare-import 'zod'.
const tmpParent = fileURLToPath(new URL('../../node_modules/', import.meta.url));

/** Every planned op family dir (phase-4 T4.2 completes this closure). */
const PLANNED_FAMILIES = ['gates', 'ledger', 'review', 'merge', 'ratchet', 'sweep', 'pr', 'analyze'];

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** Make a fresh tmp ops root under the repo (zod-resolvable), auto-cleaned. */
async function makeTmpOpsRoot(prefix: string): Promise<string> {
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
async function makeTmpPlansRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  tmpDirs.push(dir);
  return dir;
}

/** One valid single-entry family registry as generated ESM .js source. */
function registrySource(opName: string): string {
  return [
    "import { z } from 'zod';",
    'export const registry = [',
    `  { name: '${opName}', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: null }) },`,
    '];',
    '',
  ].join('\n');
}

describe('registry family scan (src/ops)', () => {
  test('family scan sees every planned family dir', () => {
    const families = readdirSync(srcOps, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    for (const planned of PLANNED_FAMILIES) {
      expect(families).toContain(planned);
    }
  });

  test('no op module without a registry entry', async () => {
    const entries = await list();
    const entryNames = new Set(entries.map((entry) => entry.name));
    const families = readdirSync(srcOps, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    const violations: string[] = [];
    for (const family of families) {
      for (const dirent of readdirSync(join(srcOps, family), { withFileTypes: true })) {
        if (!dirent.isFile() || !dirent.name.endsWith('.ts')) continue;
        if (
          dirent.name === 'registry.ts' ||
          dirent.name === 'index.ts' ||
          dirent.name.endsWith('.test.ts')
        ) {
          continue;
        }
        const opName = dirent.name.replace(/\.ts$/, '');
        if (!entryNames.has(opName)) {
          violations.push(`src/ops/${family}/${dirent.name}: no registry entry named '${opName}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('registry ⇄ CLI subcommand surface', () => {
  test('every registry entry has a subcommand', async () => {
    const entries = await list();
    const names = subcommandNames(entries);
    for (const entry of entries) {
      expect(names).toContain(entry.name);
    }
    expect(names).toContain('run-plan');
    // The built-in run-plan subcommand exists even with zero op families.
    expect(subcommandNames([])).toEqual(['run-plan']);
  });
});

describe('fixture-root DI (test/fixtures/cli-ops)', () => {
  test('the fixture family resolves exactly its six ops through the same seam', async () => {
    const names = (await list({ opsRoot: join(fixtureOps) })).map((entry) => entry.name).sort();
    expect(names).toEqual(['boom', 'budget', 'echo', 'garbage', 'indet', 'needshuman']);
  });

  test("get('echo') yields an entry whose importer() is an async op fn", async () => {
    const entry = await get('echo', { opsRoot: join(fixtureOps) });
    if (entry === undefined) throw new Error('fixture family: no registry entry named echo');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    expect(op.constructor.name.includes('AsyncFunction')).toBe(true);
  });
});

describe('registry integrity defects reject loudly', () => {
  test('duplicate op names across families reject naming the op', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-dup-');
    for (const family of ['alpha', 'beta']) {
      await mkdir(join(tmp, family), { recursive: true });
      await writeFile(join(tmp, family, 'registry.js'), registrySource('dup'));
    }
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/dup/);
  });

  test('a malformed entry (no inputSchema/importer) rejects', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-malformed-');
    await mkdir(join(tmp, 'malformed'), { recursive: true });
    await writeFile(
      join(tmp, 'malformed', 'registry.js'),
      "export const registry = [{ name: 'x' }];\n",
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/'x'/);
  });
});

describe('absent vs broken family registries (the narrow tolerance)', () => {
  test('an ABSENT registry.js is tolerated: the family contributes no entries', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-absent-');
    await mkdir(join(tmp, 'empty-family'), { recursive: true });
    // Only a not-found for the requested registry.js itself counts as absent.
    await expect(list({ opsRoot: tmp })).resolves.toEqual([]);
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

describe('plan registry (src/plans) — .ts discovery + skip rules', () => {
  test('discovers .ts and .js plan siblings; skips reserved stems, tests, and .d.ts', async () => {
    const root = await makeTmpPlansRoot('cq-plans-discovery-');
    // One plan module per layout: .ts (source) and .js (dist).
    await writeFile(
      join(root, 'alpha.ts'),
      "export const plan = { name: 'alpha', importer: async () => ({ id: 'alpha', jobs: [] }) };\n",
    );
    await writeFile(
      join(root, 'beta.js'),
      "export const plan = { name: 'beta', importer: async () => ({ id: 'beta', jobs: [] }) };\n",
    );
    // Reserved stem (registry, whatever its extension and however valid its
    // content) — never imported, never listed.
    await writeFile(
      join(root, 'registry.ts'),
      "export const plan = { name: 'reserved-never', importer: async () => ({ id: 'x', jobs: [] }) };\n",
    );
    // Test sibling — skipped in either layout.
    await writeFile(
      join(root, 'skip.test.ts'),
      "export const plan = { name: 'test-never', importer: async () => ({ id: 'x', jobs: [] }) };\n",
    );
    // Declaration file — ambient typing, never a module candidate.
    await writeFile(join(root, 'types.d.ts'), 'export type PlanName = string;\n');
    const names = (await listPlans({ plansRoot: root })).map((entry) => entry.name);
    expect(names).toEqual(['alpha', 'beta']);
    const alpha = await getPlan('alpha', { plansRoot: root });
    expect(alpha?.name).toBe('alpha');
    expect(typeof alpha?.importer).toBe('function');
  });
});

describe('root barrel aliases (src/index.js)', () => {
  test('exposes listOps/getOp; the generic list/get names never sit on the barrel', async () => {
    const barrel = await import('../../src/index.js');
    // Aliases of the same registry seam, not re-implementations.
    expect(barrel.listOps).toBe(list);
    expect(barrel.getOp).toBe(get);
    // The bare generic names would collide (star-export ambiguity) with the
    // first family barrel that ever exports them — they must stay absent.
    expect(Object.hasOwn(barrel, 'list')).toBe(false);
    expect(Object.hasOwn(barrel, 'get')).toBe(false);
  });
});
