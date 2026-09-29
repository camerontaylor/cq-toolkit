import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../src/ops/', import.meta.url));

async function constructionSites(directory: string): Promise<string[]> {
  const sites: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sites.push(...(await constructionSites(path)));
    } else if (entry.name.endsWith('.ts')) {
      // Exclude illustrative JSDoc, and include namespace constructors such
      // as the analyze importer's `new d.SubprocessDriver(...)`.
      const source = (await readFile(path, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      if (
        /\bnew\s+(?:\w+\.)?(?:SubprocessDriver|AiSdkDriver|AcpDriver|ClaudeAgentDriver)\b/.test(
          source,
        )
      ) {
        sites.push(relative(ROOT, path));
      }
    }
  }
  return sites.sort();
}

test('driver construction inventory: ops sites require served-model construction coverage', async () => {
  // ADR-0002 §2.5/§2.6: the FACTORY is the one served-model hook for
  // toolkit dispatch, so ops construct no lane class at all. The S4b
  // migration empties this inventory — merge/resolveConflict, analyze/
  // registry and the two review sites already resolve through the factory;
  // the sweep site below is the remaining S4b-B2 leg. When this list is
  // empty it STAYS empty: a new lane construction under src/ops fails here.
  expect(await constructionSites(ROOT)).toEqual([
    'sweep/unit.ts', // S4b-B2 migrates to the factory
  ]);
});
