import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import * as checkoutOwnership from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import {
  makeAddressOwnership,
  withAddressOwnership as withLegacyOwnership,
  isAddressOwnershipAdmissionRefusal as isLegacyAdmissionRefusal,
} from '../../../src/ops/review/internal/addressOwnership.js';

import {
  authorityState,
  damageGuard,
  deferred,
  errorChain,
  fixture,
  preservedDamage,
} from './addressManyWorktree.helpers.js';

// Filesystem fault gates are test-only. Every unaffected operation is real.
const fsFaults = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void),
  link: undefined as
    | undefined
    | ((phase: 'before' | 'after', source: string, destination: string) => Promise<void>),
  open: undefined as
    | undefined
    | ((path: string, flags: string | number | undefined) => Promise<void>),
  sync: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      fsFaults.effect?.();
      return actual.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.effect?.();
      return actual.writeFile(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      fsFaults.effect?.();
      await fsFaults.link?.('before', String(args[0]), String(args[1]));
      await actual.link(...args);
      await fsFaults.link?.('after', String(args[0]), String(args[1]));
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      fsFaults.effect?.();
      await fsFaults.open?.(String(args[0]), args[1]);
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        fsFaults.effect?.();
        await fsFaults.sync?.(String(args[0]));
        await sync();
      };
      return file;
    },
  };
});

test('v2 authority requires attended migration and is never automatically reused', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  try {
    await owner.withLock(async () => undefined);
    const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { version: number };
    anchor.version = 2;
    const evidence = JSON.stringify(anchor);
    await writeFile(owner.guardPath, evidence);
    let failure: unknown,
      dispatched = 0;
    try {
      await (
        await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
      ).withLock(async () => {
        dispatched++;
      });
    } catch (error) {
      failure = error;
    }
    expect(errorChain(failure)).toContain('v2 requires attended migration');
    expect(dispatched).toBe(0);
    expect(await readFile(owner.guardPath, 'utf8')).toBe(evidence);
  } finally {
    await f.repo.cleanup();
  }
});
test('callback values cannot forge completion and retired lease/proof replay cannot reopen admission', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  // Private methods are deliberately reached only here to test runtime brands,
  // not exposed to callers as a production certificate or bypass API.
  const publisher = owner as unknown as { publishCompletion(proof: object): Promise<void> };
  const fake = { owner, sequence: 2, state: 'quiescent' };
  let lease: ReturnType<typeof owner.lease> | undefined;
  let consumed: object | undefined;
  const publish = publisher.publishCompletion.bind(owner);
  const observed = vi.spyOn(publisher, 'publishCompletion').mockImplementation(async (proof) => {
    consumed = proof;
    await publish(proof);
  });
  try {
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    expect(
      await owner.withLock(async () => {
        lease = owner.lease();
        return fake;
      }),
    ).toBe(fake);
    observed.mockRestore();
    expect(consumed).toBeDefined();
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    await expect(
      lease!.track(async () => {
        throw new Error('stale dispatch');
      }),
    ).rejects.toThrow('admissions closed');
    await expect(owner.withLock(async () => undefined)).rejects.toThrow(
      'lifetime already consumed',
    );
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
  } finally {
    observed.mockRestore();
    await f.repo.cleanup();
  }
});
test('regression: a genuine active-slot refusal preserves the owner and returns without report IO', async () => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const journalDir = join(f.root, 'admission-refusal-journal');
  let dispatches = 0;
  try {
    const path = join(f.repo.root, '.git/cq-review/slots');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {
        const name = (await readdir(path)).find((name) => name.endsWith('.json'))!;
        const before = await readFile(join(path, name), 'utf8');
        const result = await addressModule.makeReviewAddress({
          config: {
            schemaVersion: 2,
            checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
            roles: { worker: role, reviewer: role },
            budgets: { run: { maxTokens: 1000 } },
            review: { reviewers: ['agent'] },
          },
          git: f.run,
          review: async () => {
            dispatches++;
            throw new Error('no review expected');
          },
        })({ repoRoot: f.repo.root, source: 'local', journalDir, push: true });
        expect(result.status).toBe('needs-human');
        if (result.status !== 'needs-human') throw new Error('admission was not refused');
        expect(result.reason).toMatch(/busy/i);
        expect(result.report?.stop).toBeUndefined();
        expect(dispatches).toBe(0);
        await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(path, name), 'utf8')).toEqual(before);
      },
    );
    const name = (await readdir(path)).find((name) => name.endsWith('.json'))!;
    expect(JSON.parse(await readFile(join(path, name), 'utf8'))).toMatchObject({
      incomplete: false,
    });
  } finally {
    await f.repo.cleanup();
  }
});
test('immutable write loss with detached work refuses again after late settlement', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const entered = deferred(),
    release = deferred();
  let actual: Promise<unknown> | undefined;
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'after' && destination.endsWith('/000002.json'))
      await damageGuard(owner.guardPath, 'replace');
  };
  try {
    await expect(
      owner.withLock(async () => {
        actual = owner.lease().track(async () => {
          entered.resolve();
          await release.promise;
          await f.repo.write('survivor.txt', 'late survivor');
        });
        await entered.promise;
        throw new Error('force error-path quarantine while actual work remains');
      }),
    ).rejects.toThrow('force error-path');
    await preservedDamage(owner.guardPath, 'replace');
    fsFaults.link = undefined;
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    release.resolve();
    await actual;
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    await preservedDamage(owner.guardPath, 'replace');
  } finally {
    release.resolve();
    await actual;
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test.each(['foreign', 'bootstrap-window'])(
  'regression: legacy admission refusal maps to needs-human: %s',
  async (mode) => {
    const f = await fixture();
    // Isolate the retained legacy mapper until E removes this store suite.
    const legacy = vi
      .spyOn(checkoutOwnership, 'withAddressOwnership')
      .mockImplementation(withLegacyOwnership);
    const legacyRefusal = vi
      .spyOn(checkoutOwnership, 'isAddressOwnershipAdmissionRefusal')
      .mockImplementation(isLegacyAdmissionRefusal);
    const role = { provider: 'mock', model: 'mock' };
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      const invoke = async () => {
        const result = await addressModule.makeReviewAddress({
          config: {
            schemaVersion: 2,
            checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
            roles: { worker: role, reviewer: role },
            budgets: { run: { maxTokens: 1000 } },
            review: { reviewers: ['agent'] },
          },
          git: f.run,
          review: async () => {
            throw new Error('must not dispatch');
          },
        })({ repoRoot: f.repo.root, source: 'local', journalDir: join(f.root, 'refusal-journal') });
        expect(result.status).toBe('needs-human');
        if (result.status === 'needs-human') expect(result.reason).toContain('could not acquire');
      };
      if (mode === 'foreign') {
        await writeFile(owner.guardPath, 'foreign evidence');
        await invoke();
      } else {
        fsFaults.link = async (phase, _source, target) => {
          if (phase === 'after' && target === owner.guardPath) {
            fsFaults.link = undefined;
            await invoke();
          }
        };
        await owner.withLock(async () => undefined);
      }
    } finally {
      legacyRefusal.mockRestore();
      legacy.mockRestore();
      fsFaults.link = undefined;
      await f.repo.cleanup();
    }
  },
);
