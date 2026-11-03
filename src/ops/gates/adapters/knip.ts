// Knip 6 --reporter json: file rows contain categorized symbol arrays.
import { z } from 'zod';
import type { CheckAdapter, CheckFailure } from '../checkRunner.js';

const Symbol = z.object({
  name: z.string().min(1),
  namespace: z.string().exactOptional(),
  line: z.number().int().positive().exactOptional(),
  col: z.number().int().positive().exactOptional(),
});
const Row = z
  .object({
    file: z.string().min(1),
    owners: z.array(z.object({ name: z.string() })).exactOptional(),
    files: z.array(Symbol).exactOptional(),
    dependencies: z.array(Symbol).exactOptional(),
    devDependencies: z.array(Symbol).exactOptional(),
    optionalPeerDependencies: z.array(Symbol).exactOptional(),
    unlisted: z.array(Symbol).exactOptional(),
    binaries: z.array(Symbol).exactOptional(),
    unresolved: z.array(Symbol).exactOptional(),
    exports: z.array(Symbol).exactOptional(),
    types: z.array(Symbol).exactOptional(),
    nsExports: z.array(Symbol).exactOptional(),
    nsTypes: z.array(Symbol).exactOptional(),
    enumMembers: z.array(Symbol).exactOptional(),
    namespaceMembers: z.array(Symbol).exactOptional(),
    catalog: z.array(Symbol).exactOptional(),
    catalogReferences: z.array(Symbol).exactOptional(),
    duplicates: z.array(z.array(Symbol).min(1)).exactOptional(),
    cycles: z.array(z.array(Symbol).min(1)).exactOptional(),
  })
  .strict();
const Report = z.object({ issues: z.array(Row) }).strict();

export const knipJsonAdapter: CheckAdapter = {
  name: 'knip-json',
  parse(raw) {
    const unknown = {
      verdict: 'indeterminate' as const,
      reason: 'knip-json: missing, malformed or contradictory Knip 6 report',
    };
    if (raw.exitCode !== 0 && raw.exitCode !== 1) return unknown;
    let value: unknown;
    try {
      value = JSON.parse(raw.stdout);
    } catch {
      return unknown;
    }
    const parsed = Report.safeParse(value);
    if (!parsed.success) return unknown;
    const failures: CheckFailure[] = [];
    for (const row of parsed.data.issues) {
      let recognized = false;
      for (const [category, items] of Object.entries(row)) {
        if (category === 'file' || category === 'owners') continue;
        recognized = true;
        for (const item of items as Array<z.infer<typeof Symbol> | Array<z.infer<typeof Symbol>>>) {
          for (const symbol of Array.isArray(item) ? item : [item]) {
            failures.push({
              file: row.file,
              ruleId: category,
              message: `${category}: ${symbol.namespace === undefined ? '' : `${symbol.namespace}.`}${symbol.name}`,
              severity: 'error',
              line: symbol.line ?? null,
              column: symbol.col ?? null,
            });
          }
        }
      }
      if (!recognized) return unknown;
    }
    if ((raw.exitCode === 0) !== (failures.length === 0)) return unknown;
    return { verdict: 'parsed', set: { tool: 'knip', failures, exitCode: raw.exitCode } };
  },
};
