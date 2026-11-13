// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// distinct-invocation ownership cases for the default journal.
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
test.each(['same checkout', 'aliased checkout'] as const)(
  'distinct default-journal invocations cannot overlap worker ownership: %s',
  async (mode) => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owned = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let edits = 0;
    const drivers: DriverFactory = {
      resolve: (request) => {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              if (
                input.outputSchema?.name === 'review.address.outcome/v1' &&
                !input.prompt.startsWith('related-check feedback')
              ) {
                edits++;
                if (edits > 1) throw new Error('overlapping provider dispatch');
                entered();
                await gate;
              }
              return resolved.driver.run(input);
            },
          },
        };
      },
    };
    let otherRoot = f.repo.root;
    if (mode === 'aliased checkout') {
      otherRoot = join(f.journalDir, 'alias');
      await symlink(f.repo.root, otherRoot, 'dir');
    }
    const invoke = makeReviewAddress({ drivers, initialRecord: f.record });
    const first = invoke({ repoRoot: f.repo.root, source: 'local' });
    try {
      await Promise.race([
        owned,
        first.then((result) => {
          throw new Error(`first worker did not enter: ${JSON.stringify(result)}`);
        }),
      ]);
      // Even disjoint file claims from another worker instance must not use
      // the shared mutable checkout while this provider owns its tree.
      const other = await invoke({ repoRoot: otherRoot, source: 'local' });
      expect(other.status, JSON.stringify(other)).toBe('needs-human');
      expect(other.report?.reasons.join(' ')).toContain('Slot busy');
      if (other.report)
        await expect(readFile(other.report.reportPath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(edits).toBe(1);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.record.head);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('BAD');
      release();
      const completed = await first;
      expect(completed.status, JSON.stringify(completed)).toBe('ok');
      const fresh = completed.status === 'ok' ? completed.value : completed.report!;
      const clean = fresh.rounds.at(-1)!.record;
      const later = await makeReviewAddress({ drivers, initialRecord: clean })({
        repoRoot: f.repo.root,
        source: 'local',
      });
      expect(later.status, JSON.stringify(later)).toBe('ok');
      expect(edits).toBe(1);
    } finally {
      release();
      await first;
      await f.cleanup();
    }
  },
);
