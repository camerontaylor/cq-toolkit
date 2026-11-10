import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import { makeAddressOwnership } from '../../../src/ops/review/internal/addressOwnership.js';

import * as ownershipModule from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { OpResultArtifactSchema } from '../../../src/kernel/schema.js';
import { exitCodeForOpResult } from '../../../src/cli/exit.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';

import { authorityStore, errorChain, fixture } from './addressManyWorktree.helpers.js';

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

const mutexFaults = vi.hoisted(() => ({
  afterRelease: undefined as undefined | (() => Promise<void>),
  compromise: false,
  releaseFailed: undefined as undefined | (() => void),
}));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      const release = await actual.lock(...args);
      return async () => {
        const governed = args[0].endsWith('/cq-review-address-ownership');
        try {
          await release();
        } catch (error) {
          if (governed) mutexFaults.releaseFailed?.();
          throw error;
        }
        if (!governed) return;
        if (mutexFaults.compromise)
          args[1]?.onCompromised?.(new Error('observed compromise fixture'));
        await mutexFaults.afterRelease?.();
      };
    },
  };
});

test.each([
  'sync',
  'deferred',
  'unprintable',
  'unprintable-message',
  'forged-admission',
  'nested-admission',
  'late-cleanup',
  'late-budget-facts',
] as const)('address lifetime catch is pure and preserves observed report: %s', async (mode) => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
    roles: { worker: role, reviewer: role },
    budgets: { run: { maxTokens: 1000 } },
    review: { reviewers: ['agent'] },
  };
  const journalDir = join(f.root, 'pure-adapter-journal');
  let closed = false,
    effectsAfterClose = 0;
  const effect = () => {
    if (closed) effectsAfterClose++;
  };
  fsFaults.effect = effect;
  const cause =
    mode === 'unprintable'
      ? {
          toString: () => {
            throw new Error('cannot render');
          },
        }
      : new Error('ownership finalization fixture');
  if (mode === 'forged-admission')
    Object.assign(cause, {
      message: 'could not acquire address ownership: active or quarantined guard',
      admissionRefusal: true,
    });
  if (mode === 'unprintable-message')
    Object.defineProperty(cause, 'message', {
      get: () => {
        throw new Error('cannot read message');
      },
    });
  const late =
    mode === 'late-cleanup' || mode === 'late-budget-facts' || mode === 'nested-admission';
  const facts = mode === 'late-budget-facts';
  const original = ownershipModule.withAddressOwnership;
  const spy = vi.spyOn(ownershipModule, 'withAddressOwnership');
  if (
    mode === 'sync' ||
    mode === 'unprintable' ||
    mode === 'unprintable-message' ||
    mode === 'forged-admission'
  )
    spy.mockImplementation(() => {
      closed = true;
      throw cause;
    });
  else if (mode === 'deferred')
    spy.mockImplementation(async () => {
      await Promise.resolve();
      closed = true;
      throw cause;
    });
  else if (mode === 'nested-admission')
    spy.mockImplementation((opts, action) =>
      original(opts, async (lease) => {
        let refusal: unknown;
        try {
          await original(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async () => undefined,
          );
        } catch (error) {
          refusal = error;
        }
        expect(ownershipModule.isAddressOwnershipAdmissionRefusal(refusal)).toBe(true);
        await action(lease);
        throw refusal;
      }).catch((error: unknown) => {
        closed = true;
        throw error;
      }),
    );
  else {
    spy.mockImplementation(async (opts, action) => {
      await original(opts, action);
      closed = true;
      throw cause;
    });
  }
  try {
    const result = await addressModule.makeReviewAddress({
      config,
      git: async (args) => {
        effect();
        return f.run(args);
      },
      gh: async () => {
        effect();
        throw new Error('no forge expected');
      },
      initialRecord: {
        schemaVersion: 1,
        branch: 'feature/x',
        reviewed: {
          base: f.repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
          scope: 'full',
        },
        head: f.repo.git('rev-parse', 'HEAD').trim(),
        sources: [{ kind: 'agent', status: 'terminal' }],
        findings: facts
          ? ['a', 'b'].map((id) => ({
              id,
              file: `src/${id}.ts`,
              source: 'agent' as const,
              severity: 'major' as const,
              status: 'open' as const,
              text: `fix ${id}`,
            }))
          : [],
        advisories: ['retained review advisory'],
      },
      ...(facts
        ? {
            disposition: async () => {
              effect();
              return { status: 'ok' as const, value: {} };
            },
          }
        : {}),
      workerFactory: (deps) => {
        effect();
        if (!facts) throw new Error('no worker expected');
        return {
          escalation: () => {
            effect();
            return createEscalationState();
          },
          fix: async (item) => {
            effect();
            deps.account({
              stopReason: 'complete',
              usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
              costUSD: 0.25,
              denials: [],
            });
            return {
              finding: { ...item, status: 'deferred' as const, reason: 'needs owner' },
              observedHead: f.repo.git('rev-parse', 'HEAD').trim(),
              reason: 'needs owner',
              validation: [],
            };
          },
        };
      },
      review: async () => {
        effect();
        throw new Error('no review expected');
      },
    })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir,
      ...(facts ? { maxTokens: 10, concurrency: 1 } : {}),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('failed surface required');
    expect(result.error).toContain('finalization failed; durability unconfirmed');
    if (mode === 'unprintable' || mode === 'unprintable-message')
      expect(result.error).toContain('unprintable ownership error');
    expect(result.report?.stop).toBeUndefined();
    expect(result.report?.reasons.filter((reason) => reason === result.error)).toHaveLength(1);
    expect(OpResultArtifactSchema.safeParse(result).success).toBe(true);
    expect(exitCodeForOpResult(result)).toBe(1);
    expect(effectsAfterClose).toBe(0);
    if (late) {
      if (!facts) expect(result.report?.admissionHead).toBe(f.repo.git('rev-parse', 'HEAD').trim());
      const persisted = JSON.parse(
        await readFile(join(journalDir, 'review-address-report.json'), 'utf8'),
      ) as addressModule.ReviewAddressReport;
      expect(persisted.reasons).not.toContain(result.error);
      const { stop: _stop, ...retained } = persisted;
      expect(result.report).toEqual({ ...retained, reasons: [...persisted.reasons, result.error] });
      if (facts) {
        expect(persisted.stop).toBe('budget');
        expect(result.report?.usage).toEqual({
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 2,
        });
        expect(result.report?.costUSD).toBe(0.25);
        expect(result.report?.fixes).toHaveLength(1);
        expect(result.report?.fixes[0]?.finding.status).toBe('deferred');
        expect(result.report?.rounds[0]?.runs).toHaveLength(1);
        expect(result.report?.advisories).toEqual(['retained review advisory']);
      }
    } else await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    spy.mockRestore();
    mutexFaults.afterRelease = undefined;
    fsFaults.effect = undefined;
    await f.repo.cleanup();
  }
});
test.each(['records', 'per-record', 'total-bytes', 'resource-count', 'resource-bytes'] as const)(
  'authority writer budget and redundant claims: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let dispatched = 0,
      failure: unknown;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'bound fixture' };
      });
    try {
      try {
        await owner.withLock(async () => {
          for (let index = 0; index < 65; index++) {
            const unique = bound !== 'records';
            const length =
              bound === 'per-record'
                ? 1900
                : bound === 'total-bytes'
                  ? 150
                  : bound === 'resource-bytes'
                    ? 2100
                    : 10;
            try {
              await owner.address(
                {
                  pr: unique ? index + 1 : 7,
                  head: f.prs[0].headRefOid,
                  headRepo: 'fixture/base',
                  headRefName: `${'x'.repeat(length)}${index}`,
                },
                { repoRoot: f.repo.root, source: `pr:${unique ? index + 1 : 7}` },
              );
            } catch (error) {
              if (bound !== 'records') throw error;
              failure = error;
              break;
            }
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('mid-lifetime authority bound reached');
      const names = (await readdir(authorityStore(owner.guardPath)))
        .filter((name) => /^[0-9]{6}\.json$/.test(name))
        .sort();
      const records = await Promise.all(
        names.map((name) => readFile(join(authorityStore(owner.guardPath), name))),
      );
      expect(names.length).toBeLessThanOrEqual(64);
      expect(records.every((record) => record.length <= 16_384)).toBe(true);
      expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThanOrEqual(131_072);
      const last = JSON.parse(records.at(-1)!.toString()) as { resources: string[] };
      expect(last.resources.length).toBeLessThanOrEqual(64);
      expect(last.resources.every((key) => Buffer.byteLength(key) <= 2048)).toBe(true);
      if (bound === 'records') {
        expect(names.length).toBe(64);
        expect(last.resources).toHaveLength(63);
      }
      if (bound === 'resource-count') expect(last.resources.length).toBe(64);
      if (bound === 'resource-bytes') expect(dispatched).toBe(0);
      if (bound === 'per-record') {
        expect(last.resources.length).toBe(16);
        expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThan(131_072);
      }
      if (bound === 'total-bytes') {
        const total =
          records.reduce((sum, record) => sum + record.length, 0) +
          (await readFile(owner.guardPath)).length;
        expect(total).toBeLessThanOrEqual(131_072);
        expect(total).toBeGreaterThan(114_000);
      }
      if (bound === 'records') {
        expect(dispatched).toBe(62);
        await (
          await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
        ).withLock(async () => undefined);
      } else {
        expect(dispatched).toBeLessThan(65);
        await expect(
          (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
            async () => undefined,
          ),
        ).rejects.toThrow('attended recovery');
      }
    } finally {
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
  120_000, // Bounded 64-record real-filesystem history; do not leave timed-out work running.
);
test.each(['anchor-bytes', 'record-bytes', 'total-bytes', 'enumeration'] as const)(
  'authority reader bounds allocation before parsing: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    try {
      await owner.withLock(async () => undefined);
      if (bound === 'anchor-bytes') await writeFile(owner.guardPath, '!'.repeat(257));
      else if (bound === 'record-bytes')
        await writeFile(join(authorityStore(owner.guardPath), '000001.json'), '!'.repeat(16_385));
      else if (bound === 'total-bytes') {
        const store = authorityStore(owner.guardPath);
        const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
        let previous = createHash('sha256')
          .update(await readFile(join(store, '000002.json')))
          .digest('hex');
        const epoch = randomUUID();
        for (let sequence = 3; sequence <= 63; sequence++) {
          const bytes = JSON.stringify({
            version: 3,
            anchor: anchor.anchor,
            sequence,
            previous,
            epoch,
            state: 'active',
            resources: sequence === 3 ? [] : ['x'.repeat(2048)],
          });
          const name = `${String(sequence).padStart(6, '0')}.json`;
          await writeFile(join(store, `pending-${name}`), bytes);
          await link(join(store, `pending-${name}`), join(store, name));
          previous = createHash('sha256').update(bytes).digest('hex');
        }
      } else
        for (let sequence = 3; sequence <= 65; sequence++) {
          const pending = join(
            authorityStore(owner.guardPath),
            `pending-${String(sequence).padStart(6, '0')}.json`,
          );
          await writeFile(pending, '!');
          await link(
            pending,
            join(authorityStore(owner.guardPath), `${String(sequence).padStart(6, '0')}.json`),
          );
        }
      let failure: unknown;
      try {
        await (
          await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
        ).withLock(async () => undefined);
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('authority store bound reached');
      expect(errorChain(failure)).not.toContain('SyntaxError');
    } finally {
      await f.repo.cleanup();
    }
  },
);
