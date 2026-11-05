import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { fixture, git, input, reportOf, scripted } from './fix-run-shared.js';

test.each(['missing-policy', 'scanner-fault'] as const)(
  'real scanner composition refuses %s before worker dispatch',
  async (mode) => {
    const f = await fixture();
    let calls = 0;
    try {
      if (mode === 'missing-policy') {
        await unlink(join(f.repo, 'upload-policy.yml'));
        await git(f.repo, 'add', '-A');
        await git(f.repo, 'commit', '-m', 'remove configured policy');
      } else vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '2');
      const drivers: DriverFactory = {
        resolve: (request) => {
          const resolved = scripted().resolve(request);
          return {
            ...resolved,
            driver: {
              run: async (invocation, options) => {
                calls++;
                return resolved.driver.run(invocation, options);
              },
            },
          };
        },
      };
      const result = await makeFixRun({ drivers })(input(f));
      expect(result.status).toBe('needs-human');
      expect(calls).toBe(0);
      expect(reportOf(result).tasks.every((task) => task.reason?.includes('upload refused'))).toBe(
        true,
      );
      expect(reportOf(result).fixesPerRun).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
