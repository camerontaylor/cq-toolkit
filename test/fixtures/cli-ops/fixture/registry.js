// Pure-op fixture family registry (I1): the family-convention shape
// (src/ops/<family>/registry.ts) rendered as plain ESM .js under test/fixtures.
// Pure data + zod only — no src/ or dist/ imports; importers lazy-import the
// sibling op modules, which DEFAULT-export async op fns.
import { z } from 'zod';
const lazy = (file) => async () => (await import(file)).default;
export const registry = [
  {
    name: 'echo',
    inputSchema: z.object({ msg: z.string() }).strict(),
    importer: lazy('./echo.js'),
  },
  { name: 'boom', inputSchema: z.object({}).strict(), importer: lazy('./boom.js') },
  { name: 'needshuman', inputSchema: z.object({}).strict(), importer: lazy('./needshuman.js') },
  { name: 'budget', inputSchema: z.object({}).strict(), importer: lazy('./budget.js') },
  { name: 'indet', inputSchema: z.object({}).strict(), importer: lazy('./indet.js') },
  // NOT a taxonomy verdict: the CX1 gate probe — the CLI must reject this
  // result (exit 1, stdout EMPTY) before any artifact is written.
  { name: 'garbage', inputSchema: z.object({}).strict(), importer: lazy('./garbage.js') },
];
