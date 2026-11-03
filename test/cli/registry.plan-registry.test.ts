// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries plan-registry discovery over src/plans (invariant 7).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getPlan, listPlans } from '../../src/plans/registry.js';
import { makeTmpPlansRoot, registerRegistryTmpCleanup } from './registry.helpers.js';

registerRegistryTmpCleanup();

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

  test('rejects a dispatcher-reserved plan name (run-plan, flag-shaped, whitespace)', async () => {
    // The same guard the op registry applies: such a name can never be
    // dispatched (run-plan is handled before the plan registry; a leading '-'
    // parses as a flag; whitespace corrupts the plain-text help), so the scan
    // must reject it loudly instead of listing a dead plan.
    for (const [file, name] of [
      ['reserved.ts', 'run-plan'],
      ['flag.ts', '-dashed'],
      ['space.ts', 'has space'],
    ] as const) {
      const root = await makeTmpPlansRoot('cq-plans-reserved-');
      await writeFile(
        join(root, file),
        `export const plan = { name: '${name}', importer: async () => ({ id: 'x', jobs: [] }) };\n`,
      );
      await expect(listPlans({ plansRoot: root })).rejects.toThrow(
        `plan name '${name}' is reserved`,
      );
    }
  });
});
