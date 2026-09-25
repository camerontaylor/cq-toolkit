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

test('driver construction inventory: new ops sites require served-model construction coverage', async () => {
  expect(await constructionSites(ROOT)).toEqual([
    'analyze/registry.ts', // S1
    'merge/resolveConflict.ts', // S3
    'review/fixReviewItem.ts', // S4; S5 wraps plain injection in this file
    'review/registry.ts', // S4 perHarness AiSdkDriver injection
    'sweep/unit.ts', // S2
  ]);
});
