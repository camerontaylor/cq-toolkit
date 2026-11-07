// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the queue
// evidence ownership and import-interruption tests.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { config, fixture } from './addressDeferred.helpers.js';

function ownershipReceipt() {
  const paths: unknown[] = [];
  return JSON.stringify({
    version: 1,
    item_id: 'current-ownership',
    request_id: 'original',
    source: {
      repo: 'owner/repo',
      pr: 1,
      merge_sha: 'a'.repeat(40),
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      paths,
      scope_digest: createHash('sha256').update('[]').digest('hex'),
      equivalence: 'd'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    outcome: 'no-current-code',
    counted: false,
    classification: null,
    findings: [],
    run_id: null,
    started_at: null,
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  });
}

test.each(['exact', 'wrong-digest'] as const)(
  'local queue evidence without durable ownership refuses acknowledgement: %s',
  async (mode) => {
    const f = await fixture(false);
    try {
      const bytes = ownershipReceipt();
      const id = createHash('sha256').update(bytes).digest('hex');
      const path = join(await realpath(f.repo.root), '.cq/queue-evidence', id + '.json');
      let imported = false;
      const result = await makeReviewAddress({
        config,
        initialRecord: f.record(),
        resolveDeferredVendorContext: async (request) => {
          if (!imported) {
            imported = true;
            await mkdir(join(f.repo.root, '.cq/queue-evidence'), { recursive: true });
            await writeFile(path, bytes);
            await request.onEvidenceImported?.({
              receiptId: mode === 'wrong-digest' ? 'e'.repeat(64) : id,
              path,
            });
          }
          return f.resolver(request);
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
      // Local mode has no durable private ownership store. Even an exact
      // import must refuse before the caller can acknowledge its consumption.
      expect(result.status).toBe('needs-human');
      if (mode === 'exact')
        expect(result.status === 'needs-human' && result.reason).toContain(
          'durable queue evidence ownership unavailable',
        );
    } finally {
      await f.cleanup();
    }
  },
);

test.each(['ack-interrupted', 'persist-refused', 'changed-known'] as const)(
  'PR import ownership survives interruption before enclosing action settles: %s',
  async (mode) => {
    const f = await fixture(false);
    try {
      const head = f.record().head;
      f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const namespace = createHash('sha256')
        .update(
          JSON.stringify(['owner', 'repo', 7, 'main', null, 'owner/repo', 'feature/x', 'author']),
        )
        .digest('hex');
      const ownershipPath = join(
        await realpath(f.repo.root),
        '.git/cq-review-address',
        namespace,
        'bookkeeping.json',
      );
      const ok = (value: unknown): GhResult => ({
        code: 0,
        stdout: typeof value === 'string' ? value : JSON.stringify(value),
        stderr: '',
      });
      const gh: GhFn = async (args) => {
        if (args[0] === 'repo') return ok({ nameWithOwner: 'owner/repo' });
        if (args[0] === 'pr')
          return ok({
            headRefName: 'feature/x',
            headRepositoryOwner: { login: 'owner' },
            headRepository: { name: 'repo' },
          });
        if (args.includes('user')) return ok('author');
        if (args.includes('graphql'))
          return ok({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'author' },
                  headRefName: 'feature/x',
                  headRefOid: head,
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        if (args.some((arg) => arg === 'repos/owner/repo/pulls/7'))
          return ok({ head: { sha: head } });
        if (args.some((arg) => arg.includes('/comments') || arg.includes('/reviews')))
          return ok([]);
        throw new Error('unexpected offline forge operation');
      };
      let resumedAfterObserver = false;
      let changedEvidenceError: unknown;
      let evidenceRoot: string | undefined;
      let evidencePath: string | undefined;
      const result = await makeReviewAddress({
        config,
        gh,
        workerFactory: (deps) => ({
          escalation: createEscalationState,
          fix: async () => {
            throw new Error('no findings should dispatch');
          },
          withVerifiedHead: async (action) => {
            await deps.prepareBookkeeping?.();
            return action(head);
          },
        }),
        review: async (request) => ({
          status: 'needs-human',
          reason: 'pending vendor debt',
          report: {
            ...f.record(),
            branch: f.repo.git('-C', request.repoRoot, 'branch', '--show-current').trim(),
            deferredVendorDebt: f.debt,
          },
        }),
        resolveDeferredVendorContext: async (request) => {
          evidenceRoot = await realpath(request.repoRoot);
          const bytes = ownershipReceipt();
          const id = createHash('sha256').update(bytes).digest('hex');
          evidencePath = join(evidenceRoot, '.cq/queue-evidence', id + '.json');
          await mkdir(join(evidenceRoot, '.cq/queue-evidence'), { recursive: true });
          await writeFile(evidencePath, bytes);
          if (mode === 'persist-refused') await writeFile(ownershipPath, 'external change');
          if (!request.onEvidenceImported) throw new Error('observer missing');
          await request.onEvidenceImported({ receiptId: id, path: evidencePath });
          // This is the exact point at which QueueClient may send ack. Use a
          // new reader, with no in-memory fingerprints from the running engine.
          const fresh = makeAddressBookkeepingReceipt({
            path: ownershipPath,
            identity: namespace,
            fingerprints: new Map(),
            git: async (root, args) => f.repo.git('-C', root, ...args).trim(),
          });
          expect(await fresh.ownedFiles()).toContain(evidencePath);
          await fresh.prepare(evidenceRoot);
          resumedAfterObserver = true;
          if (mode === 'changed-known') {
            await writeFile(evidencePath, bytes + '\n');
            changedEvidenceError = await request
              .onEvidenceImported({ receiptId: id, path: evidencePath })
              .catch((error: unknown) => error);
          }
          // Simulate an ack transport failure before context/outer FIFO return.
          throw new Error('ack interrupted');
        },
      })({ repoRoot: f.repo.root, source: 'pr:7', journalDir: f.journalDir });
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(resumedAfterObserver).toBe(mode !== 'persist-refused');
      // A refusal must leave the external ownership change in place rather
      // than rewriting it; a later reader failing would also look refused.
      if (mode === 'persist-refused')
        expect(await readFile(ownershipPath, 'utf8')).toBe('external change');
      // The second import of a modified receipt is rejected on its own terms,
      // not merely masked by the unconditional acknowledgement failure below.
      if (mode === 'changed-known') expect(changedEvidenceError).toBeInstanceOf(Error);
      if (mode === 'ack-interrupted') {
        const bytes = JSON.parse(await readFile(ownershipPath, 'utf8')) as {
          files: Array<{ path: string; sha256: string }>;
        };
        expect(evidenceRoot).toBeDefined();
        expect(evidencePath).toBeDefined();
        expect(bytes.files).toContainEqual({
          path: relative(evidenceRoot!, evidencePath!),
          sha256: createHash('sha256').update(ownershipReceipt()).digest('hex'),
        });
      }
    } finally {
      await f.cleanup();
    }
  },
);
