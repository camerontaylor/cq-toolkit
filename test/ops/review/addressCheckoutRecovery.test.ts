import { afterEach, expect, test, vi } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { isolateAddressMany } from '../../../src/ops/review/addressMany.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import {
  withAddressOwnership,
  withAddressManyCheckout,
  runAddressReviewLoop,
  bindAddressTerminalReport,
  addressTerminalWorkerBinding,
  recordAddressTerminalAttempt,
  deferAddressTerminalAttempt,
  addressCancelledResult,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { validateAddressTerminalAuthority } from '../../../src/ops/review/internal/addressRunLifecycle.js';
import { identityRepo, terminalInput, terminalReport } from './addressManyWorktree.helpers.js';
import { slotFixture, deferred, reached } from './slotOwnership.helpers.js';
import { fixture as localFixture, useGitleaksPath } from './address-local.helpers.js';

const faults = vi.hoisted(() => ({
  writes: 0,
  failWrite: 0,
  failRestore: false,
  restorationPath: '',
  sawFailure: false,
  commonEnvs: [] as string[],
  indexEnvs: [] as string[],
}));
vi.mock('../../../src/adapters/lock/slotLock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/adapters/lock/slotLock.js')>();
  return {
    ...actual,
    acquireSlot: async (...args: Parameters<typeof actual.acquireSlot>) => {
      const slot = await actual.acquireSlot(...args);
      return {
        ...slot,
        writeMetadata: async (metadata: Parameters<typeof slot.writeMetadata>[0]) => {
          faults.writes++;
          if (
            faults.writes === faults.failWrite ||
            (faults.sawFailure && faults.failRestore && !metadata.incomplete)
          ) {
            faults.sawFailure = true;
            throw new Error('injected slot persistence failure');
          }
          await slot.writeMetadata(metadata);
        },
      };
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      opts: import('node:child_process').SpawnOptions,
    ) => {
      if (opts.env?.GIT_COMMON_DIR) faults.commonEnvs.push(opts.env.GIT_COMMON_DIR);
      if (opts.env?.GIT_INDEX_FILE) faults.indexEnvs.push(opts.env.GIT_INDEX_FILE);
      return actual.spawn(command, args, opts);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args);
      if (
        String(args[0]) === faults.restorationPath &&
        typeof args[1] === 'number' &&
        args[1] & constants.O_WRONLY
      )
        fd.writeFile = async () => {
          throw new Error('injected restoration write failure');
        };
      return fd;
    },
  };
});
afterEach(() =>
  Object.assign(faults, {
    writes: 0,
    failWrite: 0,
    failRestore: false,
    restorationPath: '',
    sawFailure: false,
  }),
);
useGitleaksPath();
async function checkoutMetadata(common: string) {
  const directory = join(common, 'cq-review/slots');
  const name = (await readdir(directory)).find(
    (n) => n.startsWith('checkout-') && n.endsWith('.json'),
  )!;
  return readSlotMetadata(join(directory, name));
}

test('unregistered or runner-minted terminal token refuses without effects (mutation: accept structural terminal authority)', async () => {
  const f = await slotFixture();
  try {
    for (const token of [{}, { git: f.run, commonDir: f.common }, f.run])
      await expect(validateAddressTerminalAuthority(token as object)).rejects.toThrow(
        /authority|token|forged/i,
      );
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    const before = await readFile(join(f.repo.root, 'src/a.ts'), 'utf8');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: true },
      async (lease) => {
        const binding = addressTerminalWorkerBinding(lease);
        expect(await recordAddressTerminalAttempt(binding, terminalInput(f.repo))).toBeDefined();
      },
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(before);
    expect((await checkoutMetadata(f.common))?.incomplete).toBe(false);
  } finally {
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  'metadata write failure restores earlier pristine slots; restore fault=%s (mutation: omit pre-domain compensation)',
  async (restoreFault) => {
    const f = await slotFixture();
    const clone = await identityRepo();
    try {
      faults.failWrite = 2;
      faults.failRestore = restoreFault;
      let writers = 0,
        action = false;
      const git: typeof f.run = async (args) => {
        if (args.includes('fetch') || args.includes('add') || args.includes('config')) writers++;
        return makeGhRunner({ bin: 'git' })(args);
      };
      const pending = withAddressOwnership(
        { repoRoot: clone.root, git, source: 'pr:7', coordinationRoot: f.common, production: true },
        async () => {
          action = true;
        },
      );
      await expect(pending).rejects.toThrow(
        restoreFault ? /restoration failed/ : /persistence failure/,
      );
      expect(writers).toBe(0);
      expect(action).toBe(false);
      const path = join(f.common, 'cq-review/slots/pr-7.json');
      expect((await readSlotMetadata(path))?.incomplete).toBe(restoreFault);
    } finally {
      await clone.cleanup();
      await f.repo.cleanup();
    }
  },
);

test('unbound creation crash refuses (mutation: omit first durable incomplete write)', async () => {
  const f = await slotFixture();
  try {
    await expect(
      withAddressOwnership(
        { repoRoot: f.repo.root, git: f.run, source: 'pr:7', production: true },
        async () => {
          throw new Error('crash before creation');
        },
      ),
    ).rejects.toThrow('crash before creation');
    expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toMatchObject({
      state: 'unbound',
      incomplete: true,
    });
    let fetch = false;
    await expect(
      withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: async (args) => {
            if (args.includes('fetch')) fetch = true;
            return f.run(args);
          },
          source: 'pr:7',
          production: true,
        },
        async () => {},
      ),
    ).rejects.toThrow(/incomplete/i);
    expect(fetch).toBe(false);
  } finally {
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  '%s: cancelled late writer settles evidence before complete flag; restoration fault retains flag and failed ref (mutation: clear before drain or ignore restoration failure)',
  async (restoreFault) => {
    const f = await slotFixture(),
      entered = deferred(),
      release = deferred(),
      cancel = deferred();
    const parent = new AbortController(),
      report = terminalReport(join(f.root, 'recovery-report.json'));
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'), 'utf8');
    let actual: Promise<unknown> | undefined;
    const pending = withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: true,
        signal: parent.signal,
      },
      async (lease) => {
        await bindAddressTerminalReport(lease, report);
        const binding = addressTerminalWorkerBinding(lease),
          attempt = await recordAddressTerminalAttempt(binding, terminalInput(f.repo));
        actual = lease.track(async () => {
          entered.resolve();
          await release.promise;
          await writeFile(join(f.repo.root, 'src/a.ts'), 'late cancelled bytes\n');
          deferAddressTerminalAttempt(binding, attempt);
        });
        await cancel.promise;
        return addressCancelledResult(lease);
      },
    );
    void pending.catch(() => undefined);
    try {
      await reached(entered.promise, pending);
      parent.abort();
      cancel.resolve();
      expect((await checkoutMetadata(f.common))?.incomplete).toBe(true);
      await expect(
        withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: 'local', production: true },
          async () => {},
        ),
      ).rejects.toThrow(/busy/i);
      if (restoreFault) faults.restorationPath = join(f.repo.root, 'src/a.ts');
      release.resolve();
      const result = await pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (restoreFault)
        expect('error' in result && String(result.error)).toContain('restoration write failure');
      else expect('value' in result && result.value.status).toBe('needs-human');
      const refs = f.repo
        .git('for-each-ref', '--format=%(refname)', 'refs/heads')
        .trim()
        .split('\n')
        .filter((ref) => ref.includes('/failed/'));
      expect(refs).toHaveLength(1);
      expect(f.repo.git('show', `${refs[0]}:src/a.ts`)).toBe('late cancelled bytes\n');
      expect((await checkoutMetadata(f.common))?.incomplete).toBe(restoreFault);
      if (!restoreFault) {
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(baseline);
        expect(
          (JSON.parse(await readFile(report.reportPath, 'utf8')) as { failed: unknown[] }).failed,
        ).toHaveLength(1);
      }
    } finally {
      release.resolve();
      cancel.resolve();
      await actual;
      await pending.catch(() => undefined);
      await f.repo.cleanup();
    }
  },
);

test('SDK direct-child completion clears but opaque review never clears (mutation: conflate awaited SDK and opaque invocation)', async () => {
  for (const opaque of [false, true]) {
    const f = await localFixture();
    try {
      const drivers: typeof f.drivers = {
        resolve(request) {
          const resolved = f.drivers.resolve(request);
          return {
            ...resolved,
            lane: request.modelSpec.model === 'worker' ? 'claude-code' : resolved.lane,
          };
        },
      };
      const result = await makeReviewAddress({
        drivers,
        initialRecord: f.record,
        ...(opaque
          ? {
              review: async () => ({
                status: 'ok' as const,
                value: {
                  ...f.record,
                  head: f.repo.git('rev-parse', 'HEAD').trim(),
                  reviewed: {
                    base: f.repo.git('merge-base', 'HEAD', 'origin/main').trim(),
                    scope: 'full' as const,
                  },
                  findings: [],
                },
              }),
            }
          : {}),
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
      expect(result.status, JSON.stringify(result)).toBe(opaque ? 'needs-human' : 'ok');
      expect((await checkoutMetadata(join(f.repo.root, '.git')))?.incomplete).toBe(opaque);
    } finally {
      await f.cleanup();
    }
  }
});

test('bulk terminal evidence stays in clone (mutation: bind terminal commonDir to original coordination repo)', async () => {
  const f = await slotFixture(),
    parent = new AbortController();
  const original = await readFile(join(f.repo.root, 'src/a.ts'), 'utf8');
  let clone = '',
    target = '',
    common = '';
  const report = terminalReport(join(f.root, 'bulk-terminal-report.json'));
  try {
    const result = await withAddressManyCheckout({ commonDir: f.common, pr: 7 }, async () => {
      clone = await isolateAddressMany(f.repo.root, 7, { cloneRoot: join(f.root, 'clones') });
      common = f.repo
        .git('-C', clone, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        .trim();
      return withAddressOwnership(
        {
          repoRoot: clone,
          git: f.run,
          source: 'pr:7',
          coordinationRoot: f.common,
          production: true,
          signal: parent.signal,
        },
        async (lease) => {
          await runAddressReviewLoop(lease, {
            ...f.opts(),
            repoRoot: clone,
            registry: slotWorktreeRegistry(common),
            worktreeRoot: join(common, 'cq-review-worktrees'),
            onWorktreeResolved: async (info) => {
              target = info.path;
            },
          });
          await bindAddressTerminalReport(lease, report);
          const binding = addressTerminalWorkerBinding(lease),
            head = f.repo.git('-C', target, 'rev-parse', 'HEAD').trim();
          const attempt = await recordAddressTerminalAttempt(binding, {
            ...terminalInput(f.repo),
            root: target,
            parent: head,
            executionHead: head,
          });
          await writeFile(join(target, 'src/a.ts'), 'clone cancelled bytes\n');
          faults.commonEnvs = [];
          faults.indexEnvs = [];
          parent.abort();
          deferAddressTerminalAttempt(binding, attempt);
          return addressCancelledResult(lease);
        },
      );
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in result, 'clone terminal authority must settle').toBe(true);
    if (!('value' in result)) return;
    expect(result.value.status).toBe('needs-human');
    const refs = f.repo
      .git('-C', clone, 'for-each-ref', '--format=%(refname)', 'refs/heads')
      .split('\n')
      .filter((n) => n.includes('/failed/'));
    expect(refs).toHaveLength(1);
    expect(f.repo.git('-C', clone, 'show', `${refs[0]}:src/a.ts`)).toBe('clone cancelled bytes\n');
    expect(
      f.repo
        .git('for-each-ref', '--format=%(refname)', 'refs/heads')
        .split('\n')
        .filter((n) => n.includes('/failed/')),
    ).toEqual([]);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(original);
    expect(await readFile(join(target, 'src/a.ts'), 'utf8')).toBe(original);
    expect(faults.commonEnvs.length).toBeGreaterThan(0);
    expect(new Set(faults.commonEnvs)).toEqual(new Set([common]));
    expect(faults.indexEnvs.length).toBeGreaterThan(0);
    expect(faults.indexEnvs.every((path) => path.startsWith(common + '/'))).toBe(true);
    expect((await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json')))?.incomplete).toBe(
      false,
    );
  } finally {
    await f.repo.cleanup();
  }
});

test('opaque completion preserves an existing review refusal reason (mutation: overwrite refusal with opaque reason)', async () => {
  const f = await localFixture();
  try {
    const result = await makeReviewAddress({
      drivers: f.drivers,
      initialRecord: f.record,
      review: async () => ({ status: 'needs-human', reason: 'fixture review service unavailable' }),
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('fixture review service unavailable');
    expect(result.report?.reasons).toContain(
      'opaque invocation write-set unconfirmed; checkout retained incomplete',
    );
    expect((await checkoutMetadata(join(f.repo.root, '.git')))?.incomplete).toBe(true);
  } finally {
    await f.cleanup();
  }
});
