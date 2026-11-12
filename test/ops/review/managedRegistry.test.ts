import { afterEach, expect, test, vi } from 'vitest';
import * as managed from '../../../src/ops/dev/managedReview.js';
import * as cycle from '../../../src/ops/dev/cycle.js';
import * as address from '../../../src/ops/review/address.js';
import * as many from '../../../src/ops/review/addressMany.js';
import * as reviewRun from '../../../src/ops/review/run.js';
import * as queue from '../../../src/ops/review/internal/queueClient.js';
import * as forge from '../../../src/adapters/forge-github/gh.js';
import { registry as reviewRegistry } from '../../../src/ops/review/registry.js';
import { registry as devRegistry } from '../../../src/ops/dev/registry.js';
import { makeTestRepo, repoEffects, seed } from '../dev/repo.js';
import { bindCycleRepo, greenCheck, cleanReview } from '../dev/cycle.helpers.js';
import { coordinationRoot, gh, input } from './addressMany.helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('production registry binds the managed route in every composed root without resolving it eagerly', async () => {
  const repo = await makeTestRepo();
  try {
    const submit: managed.ManagedReviewSubmit = vi.fn(async () => ({
      status: 'refused' as const,
      reason: 'offline',
    }));
    const configured = vi
      .spyOn(managed, 'makeConfiguredManagedReviewSubmit')
      .mockReturnValue(submit);
    const run = vi.fn(async () => ({
      status: 'needs-human' as const,
      reason: 'construction probe',
    }));
    const cycleFactory = vi.spyOn(cycle, 'makeDevCycle').mockReturnValue(run);
    const addressFactory = vi.spyOn(address, 'makeReviewAddress').mockReturnValue(run);
    const manyFactory = vi.spyOn(many, 'makeReviewAddressMany').mockReturnValue(run);
    const reviewFactory = vi.spyOn(reviewRun, 'makeReviewRun').mockReturnValue(run);
    for (const name of ['dev.cycle', 'review.address', 'review.addressMany', 'review.run']) {
      const entry = [...devRegistry, ...reviewRegistry].find((entry) => entry.name === name)!;
      const op = await entry.importer();
      await op({ repoRoot: repo.root });
    }
    expect(configured).toHaveBeenCalledTimes(4);
    for (const factory of [cycleFactory, addressFactory, manyFactory, reviewFactory])
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ managedSubmit: submit }));
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await repo.cleanup();
  }
});

test('addressMany default construction carries the managed route into each address operation', async () => {
  const repo = await makeTestRepo();
  try {
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
        roles: {
          worker: { provider: 'mock', model: 'mock' },
          reviewer: { provider: 'mock', model: 'mock' },
        },
        budgets: { run: { maxTokens: 1000 } },
      }),
    );
    const submit: managed.ManagedReviewSubmit = async () => ({
      status: 'refused' as const,
      reason: 'offline',
    });
    const factory = vi
      .spyOn(address, 'makeReviewAddress')
      .mockReturnValue(async () => ({ status: 'needs-human', reason: 'default address probe' }));
    await many.makeReviewAddressMany({
      managedSubmit: submit,
      gh,
      coordinationRoot: coordinationRoot(),
      isolate: async () => repo.root,
    })({ ...input, repoRoot: repo.root });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ managedSubmit: submit }));
  } finally {
    await repo.cleanup();
  }
});

test('cycle default address construction retains the same managed route after review', async () => {
  const repo = await makeTestRepo();
  try {
    bindCycleRepo(repo);
    const state = await seed(repo);
    const submit: managed.ManagedReviewSubmit = async () => ({
      status: 'refused',
      reason: 'offline',
    });
    const factory = vi.spyOn(address, 'makeReviewAddress').mockReturnValue(async () => ({
      status: 'needs-human',
      reason: 'address construction probe',
    }));
    const result = await cycle.makeDevCycle({
      effects: repoEffects(repo),
      check: greenCheck(),
      review: cleanReview(state),
      managedSubmit: submit,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ managedSubmit: submit }));
  } finally {
    await repo.cleanup();
  }
});

test.each([true, false])(
  'configured managed binding resolves checkout forge identity and queue transport (valid=%s)',
  async (valid) => {
    const repo = await makeTestRepo();
    try {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'offline-fixture');
      const transport = vi.fn(async (raw: string) => {
        const wire = JSON.parse(raw) as { op: string };
        if (wire.op === 'capabilities')
          return JSON.stringify({
            v: 1,
            command: 'review-v1',
            operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
            features: ['chunked-result-v1'],
            limits: {
              max_request_bytes: 6291456,
              max_snapshot_bytes: 5242880,
              max_content_bytes: 3145728,
              max_objects: 4096,
              chunk_bytes: 3072,
            },
          });
        expect(wire.op).toBe('submit');
        return JSON.stringify({
          v: 1,
          action: 'observed',
          state: 'failed',
          next_action: 'resubmit',
          reason: 'offline fixture review failed',
        });
      });
      const ssh = vi.spyOn(queue, 'sshQueueTransport').mockReturnValue(transport);
      const forgeRun = vi.fn(async () => ({
        code: 0,
        stdout: valid ? 'owner/repo\n' : 'malformed',
        stderr: '',
      }));
      const forgeFactory = vi.spyOn(forge, 'makeGhRunner').mockReturnValue(forgeRun);
      const submit = managed.makeConfiguredManagedReviewSubmit();
      expect(ssh).not.toHaveBeenCalled();
      expect(forgeFactory).not.toHaveBeenCalled();
      const result = await submit({
        cwd: repo.root,
        target: 'main',
        base: repo.git('rev-parse', 'origin/main').trim(),
        head: repo.git('rev-parse', 'HEAD').trim(),
        reachable: true,
      });
      expect(forgeFactory).toHaveBeenCalledWith({ cwd: repo.root, timeoutMs: 30_000 });
      expect(forgeRun).toHaveBeenCalledWith([
        'repo',
        'view',
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
      ]);
      if (valid) {
        expect(ssh).toHaveBeenCalledWith('offline-fixture', 'review-v1');
        expect(transport).toHaveBeenCalledTimes(2);
        expect(JSON.parse(transport.mock.calls[0]![0]!)).toMatchObject({ op: 'capabilities' });
        expect(JSON.parse(transport.mock.calls[1]![0]!)).toMatchObject({
          op: 'submit',
          inputs: { repo: 'owner/repo' },
        });
        expect(result).toMatchObject({
          status: 'refused',
          reason: expect.stringContaining(
            "the queued review ended 'failed' — offline fixture review failed",
          ) as unknown,
        });
      } else {
        expect(transport).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          status: 'refused',
          reason: expect.stringContaining(
            'gh repo view could not resolve a valid owner/repository identity',
          ) as unknown,
        });
      }
    } finally {
      await repo.cleanup();
    }
  },
);
