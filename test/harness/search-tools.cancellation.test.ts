// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers deadline vs caller-abort classification and
// in-flight rg aborts.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as runner from '../../src/harness/run.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool } from './search-tools.helpers.js';

test.each([
  ['enumeration', false],
  ['enumeration', true],
  ['grep', false],
  ['grep', true],
] as const)('search %s distinguishes deadline from caller abort (%s)', async (phase, aborted) => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'a.txt'), 'needle');
    const controller = new AbortController();
    const original = runner.runArgvCommand;
    const spy = vi
      .spyOn(runner, 'runArgvCommand')
      .mockImplementation(async (file, args, options) => {
        if ((phase === 'grep') === args.includes('--json')) {
          if (aborted) controller.abort();
          return { kind: 'killed', stdout: '', stderr: '', overflowed: false };
        }
        return original(file, args, options);
      });
    try {
      const result = await tool(
        buildTools(defaultHarnessConfig, workspace, 'read-only'),
        'grep',
      ).execute({ pattern: 'needle' }, { signal: controller.signal });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.denial.reason).toMatch(new RegExp(`^${aborted ? 'CANCELLED' : 'TIMEOUT'}: `));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('contained grep and glob tools', () => {
  test('returns a denial when an in-flight rg operation is aborted', async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all(
        Array.from({ length: 1_500 }, (_, index) =>
          writeFile(join(workspace, `abort-${index}.txt`), 'needle\n', 'utf8'),
        ),
      );
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const controller = new AbortController();
      const pending = grep.execute({ pattern: 'needle' }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 5);
      const aborted = await pending;
      expect(aborted.ok).toBe(false);
      if (!aborted.ok) expect(aborted.denial.reason).toContain('cancelled:');
    });
  });
});
