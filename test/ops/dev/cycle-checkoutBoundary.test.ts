import { expect, test } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDevCycle } from '../../../src/ops/dev/cycle.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { checkoutWriterContext } from '../../../src/shared/checkoutWriterContext.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { fixture as localFixture, useGitleaksPath } from '../review/address-local.helpers.js';
import { checkRecord } from './fakes.js';
import { repoEffects, seed } from './repo.js';
import { bindCycleRepo, greenCheck, openFake } from './cycle.helpers.js';
import {
  fixtureIn,
  input as fixInput,
  fixingDrivers,
  fixedUnitReport,
  stubSweepRegistries,
} from '../fix/observation-wiring.helpers.js';
useGitleaksPath();

test('cycle address leg uses slots without leaking to surrounding legs (mutation: bypass new owner context)', async () => {
  const f = await localFixture();
  let dispatches = 0,
    checks = 0,
    published = false;
  try {
    bindCycleRepo(f.repo);
    await seed(f.repo);
    const drivers: typeof f.drivers = {
      resolve(request) {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              expect(checkoutWriterContext()).toBeDefined();
              dispatches++;
              const names = await readdir(join(f.repo.root, '.git/cq-review/slots'));
              const slot = names.find((n) => n.startsWith('checkout-') && n.endsWith('.json'))!;
              expect(
                (await readSlotMetadata(join(f.repo.root, '.git/cq-review/slots', slot)))
                  ?.incomplete,
              ).toBe(true);
              return resolved.driver.run(input);
            },
          },
        };
      },
    };
    const result = await makeDevCycle({
      effects: repoEffects(f.repo),
      drivers,
      check: async (input) => {
        expect(checkoutWriterContext()).toBeUndefined();
        checks++;
        const result = await greenCheck()(input);
        if (result.status === 'ok') {
          const at = result.value;
          const ledger = repoEffects(f.repo).openLedger(f.record.branch);
          const prior = ledger.load();
          ledger.save({
            ...prior,
            records: [...prior.records, checkRecord({ ...at, checkId: `k10${checks}-bbbbbbbb` })],
          });
        }
        return result;
      },
      review: async () => {
        expect(checkoutWriterContext()).toBeUndefined();
        return { status: 'ok', value: f.record };
      },
      address: makeReviewAddress({ drivers, initialRecord: f.record }),
      open: async (input) => {
        expect(checkoutWriterContext()).toBeUndefined();
        published = true;
        return openFake([])(input);
      },
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(dispatches).toBeGreaterThan(0);
    expect(checks).toBe(2);
    expect(published).toBe(true);
    expect(checkoutWriterContext()).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('generic fix after address inherits no review context (mutation: leak completed ALS context)', async () => {
  const f = await localFixture(),
    roots: string[] = [];
  try {
    expect(
      (await f.op({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir })).status,
    ).toBe('ok');
    const g = await fixtureIn(roots);
    let observed = false;
    const stub = stubSweepRegistries(fixedUnitReport());
    const result = await makeFixRun({
      drivers: fixingDrivers(),
      registry: {
        get(name) {
          observed = true;
          expect(checkoutWriterContext()).toBeUndefined();
          return stub(name);
        },
      },
    })(fixInput(g));
    expect(result.status).not.toBe('failed');
    expect(observed).toBe(true);
    expect(checkoutWriterContext()).toBeUndefined();
    await expect(readdir(join(g.repo, '.git/cq-review/slots'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await f.cleanup();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});
