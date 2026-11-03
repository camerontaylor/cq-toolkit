// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the loud integrity defects: duplicate/malformed/reserved
// entries and the schema-strictness gate (invariant 5 plus the strictness
// teeth the convention makes load-bearing).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { list } from '../../src/registry/index.js';
import { makeTmpOpsRoot, registerRegistryTmpCleanup, registrySource } from './registry.helpers.js';

registerRegistryTmpCleanup();

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

  test("an op named 'run-plan' rejects: the dispatcher owns that name", async () => {
    // main.ts dispatches 'run-plan' before the registry is ever consulted and
    // dedups it out of the global help, so such an entry validates but can
    // never be invoked — registration rejects it as a malformed entry.
    const tmp = await makeTmpOpsRoot('cq-registry-runplan-');
    await mkdir(join(tmp, 'runplanfam'), { recursive: true });
    await writeFile(join(tmp, 'runplanfam', 'registry.js'), registrySource('run-plan'));
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/reserved by the CLI dispatcher/);
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/'run-plan'/);
  });

  test("an op named '--weird' rejects: leading-dash names parse as flags", async () => {
    // A name starting with '-' would collide with flag spellings at the
    // dispatcher — never invocable as a subcommand — so registration rejects.
    const tmp = await makeTmpOpsRoot('cq-registry-dashname-');
    await mkdir(join(tmp, 'dashfam'), { recursive: true });
    await writeFile(join(tmp, 'dashfam', 'registry.js'), registrySource('--weird'));
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/reserved by the CLI dispatcher/);
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/'--weird'/);
  });

  test('a non-strict object behind a WRAPPER rejects at scan (review-debt #82)', async () => {
    // The def-walk unwraps optional/nullable/default/catch/readonly (and a
    // pipe's IN side) to the object they hide, so a strip-mode object can
    // no longer bypass the strictness enforcement by hiding behind a
    // wrapper — the exact silent-strip hole the convention exists to close.
    const tmp = await makeTmpOpsRoot('cq-registry-wrapped-');
    await mkdir(join(tmp, 'wrapfam'), { recursive: true });
    await writeFile(
      join(tmp, 'wrapfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'wrapped-strip', inputSchema: z.object({ a: z.string() }).optional(), importer: async () => async () => ({ status: 'ok', value: null }) },",
        "  { name: 'nullish-strip', inputSchema: z.object({ a: z.string() }).nullish(), importer: async () => async () => ({ status: 'ok', value: null }) },",
        "  { name: 'caught-strip', inputSchema: z.object({ a: z.string() }).strict().catch({ a: 'x' }), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/must be \.strict\(\)/);
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/wrapped-strip/);
  });

  test('a .catch() wrapper REJECTS at scan — the fallback would swallow unknown-key rejection (PR #112 review)', async () => {
    // zod's catch replaces ANY inner failure, including the
    // unrecognized_keys failure a strict object raises on a typo'd flag —
    // the typo would reach the op as fallback data instead of exit 2.
    // Incompatible with the convention whatever the inner strictness says.
    const tmp = await makeTmpOpsRoot('cq-registry-caught-');
    await mkdir(join(tmp, 'caughtfam'), { recursive: true });
    await writeFile(
      join(tmp, 'caughtfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'caught-strict', inputSchema: z.object({ a: z.string() }).strict().catch({ a: 'x' }), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/wraps its object in \.catch\(\)/);
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/caught-strict/);
  });

  test('a STRICT object behind wrappers scans clean — the unwrapping never over-rejects (review-debt #82)', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-wrapped-ok-');
    await mkdir(join(tmp, 'wrapok'), { recursive: true });
    await writeFile(
      join(tmp, 'wrapok', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'wrapped-strict', inputSchema: z.object({ a: z.string() }).strict().optional(), importer: async () => async () => ({ status: 'ok', value: null }) },",
        "  { name: 'nullish-strict', inputSchema: z.object({ a: z.string() }).strict().nullish(), importer: async () => async () => ({ status: 'ok', value: null }) },",
        "  { name: 'readonly-strict', inputSchema: z.object({ a: z.string() }).strict().readonly(), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).resolves.toMatchObject([
      { name: 'wrapped-strict' },
      { name: 'nullish-strict' },
      { name: 'readonly-strict' },
    ]);
  });

  test('a non-strict object inputSchema (default z.object, no .strict()) rejects at scan', async () => {
    // The convention makes unknown-key rejection LOAD-BEARING (a typo'd flag
    // must exit 2, not be silently stripped), so a shape-bearing object
    // schema without the strictness marker is the same class of loud defect
    // as a malformed entry. The structural probe (probed live on zod
    // 4.6.4): `.strict()` shows up as the object def's `catchall` set to a
    // `never` schema — absent on strip-mode objects, `unknown` on loose.
    const tmp = await makeTmpOpsRoot('cq-registry-nonstrict-');
    await mkdir(join(tmp, 'nonstrict'), { recursive: true });
    await writeFile(
      join(tmp, 'nonstrict', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'strips-typo', inputSchema: z.object({ a: z.string() }), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/must be \.strict\(\)/);
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/strips-typo/);
  });

  test('strict through a refinement stays accepted: .strict().refine passes the gate', async () => {
    // The positive edge of the discriminator: refine/superRefine mutate the
    // SAME ZodObject def, so the strictness marker stays visible — the gate
    // must not reject compositions the convention allows.
    const tmp = await makeTmpOpsRoot('cq-registry-strictref-');
    await mkdir(join(tmp, 'strictref'), { recursive: true });
    await writeFile(
      join(tmp, 'strictref', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'strictref', inputSchema: z.object({ a: z.string() }).strict().refine(() => true), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).resolves.toHaveLength(1);
  });
});
