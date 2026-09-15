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
//      test/fixtures/cli-ops/ resolves exactly its five names through the
//      same list()/get() seam, and get('echo').importer() yields an async fn.
//   5. Registry integrity defects surface loudly: duplicate op names across
//      families reject naming the op; a malformed entry (no inputSchema/
//      importer) rejects.
//
// Fixture/generated registries are plain ESM .js files (package
// "type":"module") that import 'zod' from the repo's node_modules — so the
// throwaway tmp roots for (5) are created under <repo>/node_modules, where
// that bare specifier resolves; nothing else ever touches them and each test
// cleans up with rm.
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { subcommandNames } from '../../src/cli/main.js';
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
  test('the fixture family resolves exactly its five ops through the same seam', async () => {
    const names = (await list({ opsRoot: join(fixtureOps) })).map((entry) => entry.name).sort();
    expect(names).toEqual(['boom', 'budget', 'echo', 'indet', 'needshuman']);
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
