// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// review.address local full-cycle suite.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { readObservations } from '../../../src/kernel/observation.js';
import { runPlan } from '../../../src/kernel/runner.js';
import { createGovernor } from '../../../src/kernel/governor.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { z } from 'zod';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { fixture, gitleaksCalls, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
describe('review.address local full cycle', () => {
  test('nested worker, feedback, closure and re-review usage reach the enclosing budget exactly once', async () => {
    const f = await fixture();
    let next = 0;
    try {
      const run = await runPlan(
        {
          id: 'outer-address',
          jobs: [
            {
              id: 'address',
              op: 'review.address',
              input: { repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir },
            },
            { id: 'later', op: 'probe', input: {} },
          ],
        },
        { concurrency: 1, stopOnError: false, maxTokens: 10 },
        {
          get: (name) =>
            ({
              name,
              inputSchema: z.unknown(),
              importer: async () =>
                name === 'review.address'
                  ? f.op
                  : async () => {
                      next++;
                      return { status: 'ok', value: {} };
                    },
            }) as unknown as OpRegistryEntry<never, never>,
        },
        {
          governor: createGovernor({ maxTokens: 10 }),
          allowAdvisory: true,
          allowAdvisoryProvenance: 'product',
        },
      );
      expect(run.usage).toEqual({ input: 8, output: 4, cacheRead: 0, cacheWrite: 0 });
      expect(run.jobs[0]?.usage).toEqual(run.usage);
      expect(next).toBe(0);
      expect(run.jobs[1]?.result.status).toBe('budget-exhausted');
      expect(f.models).toEqual(['worker', 'worker', 'reviewer', 'reviewer']);
    } finally {
      await f.cleanup();
    }
  });
  test('fixture findings become a gated commit, dev disposition, actual review.run and clean report', async () => {
    const f = await fixture();
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.fixesPerRun).toBe(1);
      expect(result.value.openBlocking).toEqual([]);
      expect(result.value.attempts.map((attempt) => attempt.invocation)).toEqual([
        'edit',
        'feedback',
        'closure',
      ]);
      expect(result.value.usage).toEqual({
        input: 2 * f.models.length,
        output: f.models.length,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(f.models.filter((model) => model === 'reviewer').length).toBeGreaterThan(0);
      expect((await gitleaksCalls()).length).toBeGreaterThan(3);
      const ledger = makeSubprocessDevEffects(f.repo.root).openLedger('feature/x').load();
      const disposition = ledger.records.find(
        (row): row is Extract<typeof row, { kind: 'disposition' }> =>
          row.kind === 'disposition' && row.findingId === 'seed-a' && row.action === 'fixed',
      );
      expect(disposition).toBeDefined();
      // ADR-0008 T38: the v3 disposition carries full provenance — the
      // engine names itself as owner, and the evidence is the finding's
      // own verbatim proof: the gated commit SHA for a fixed disposition.
      expect(disposition?.owner).toBe('review.address');
      expect(disposition?.evidence).toEqual([f.repo.git('rev-parse', 'HEAD').trim()]);
      expect(disposition?.fingerprint ?? null).toBeNull();
      expect(disposition?.acceptedRisk ?? null).toBeNull();
      expect(JSON.parse(await readFile(result.value.reportPath, 'utf8'))).toEqual(result.value);
      expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      // Publication is an explicit opt-in even after a successful run.
      expect(() => f.repo.git('rev-parse', 'refs/remotes/origin/feature/x')).toThrow();
    } finally {
      await f.cleanup();
    }
  });
  test('two failed worker attempts route to shared rescue before human', async () => {
    const f = await fixture('rescue');
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
        push: true,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(
        result.value.attempts
          .filter((attempt) => attempt.invocation === 'edit')
          .map((attempt) => attempt.tier),
      ).toEqual(['worker', 'worker', 'rescue']);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'feature/x')).toContain(
        result.value.fixes[0]!.commit,
      );
      expect(result.value.escalation?.perRunUsed).toBe(1);
      expect(result.value.fixesPerRun).toBe(1);
      expect(result.value.failed.map((row) => [row.ordinal, row.tier])).toEqual([
        [1, 'worker'],
        [2, 'worker'],
      ]);
      expect(result.value.fixes[0]!.failedAttempts).toEqual(result.value.failed);
      for (const row of result.value.failed) {
        expect(f.repo.git('rev-parse', row.branch).trim()).toBe(row.sha);
        expect(f.repo.git('rev-parse', `${row.sha}^`).trim()).toBe(row.parent);
      }
      const journal = JSON.parse(
        await readFile(result.value.reportPath, 'utf8'),
      ) as ReviewAddressReport;
      expect(journal.failed).toEqual(result.value.failed);
      expect(
        journal.attempts.filter((row) => row.failedAttempt).map((row) => row.failedAttempt),
      ).toEqual(journal.failed);
    } finally {
      await f.cleanup();
    }
  });
  test('a deferred blocker survives actual re-review and yields honest needs-human at the round cap', async () => {
    const f = await fixture('defer');
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.openBlocking).toHaveLength(1);
      expect(report.openBlocking[0]?.status).toBe('deferred');
      expect(report.fixesPerRun).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.record.head);
    } finally {
      await f.cleanup();
    }
  });
  test.each(['alone', 'first'] as const)(
    'a fileless finding dispatched %s defers with a verified head like a filed sibling',
    async (kind) => {
      // T19 round 4: the local dispatch path calls the worker's fix directly,
      // without withVerifiedHead, so a fileless finding can precede every
      // admission. Before the unanchored branch ran initialize(stop), its
      // outcome depended on dispatch order — alone or first it was refused as
      // 'unexpected worker execution head' and dropped; only after a filed
      // sibling did it defer. Now every order matches filed-first and the PR
      // path: needs-human with exactly one deferred finding-disposition
      // carrying a verified 40-hex head.
      const f = await fixture();
      try {
        const seed = f.record.findings[0]!;
        const fileless: Finding = { ...seed, id: 'seed-fileless', file: undefined };
        f.record.findings = kind === 'alone' ? [fileless] : [fileless, seed];
        const result = await f.op({
          repoRoot: f.repo.root,
          source: 'local',
          journalDir: f.journalDir,
        });
        expect(result.status, JSON.stringify(result)).toBe('needs-human');
        const report = result.status === 'ok' ? result.value : result.report!;
        expect(report.openBlocking).toMatchObject([
          {
            id: 'seed-fileless',
            status: 'deferred',
            reason: 'unanchored finding needs human scope',
          },
        ]);
        const streams = await readObservations(f.journalDir);
        const deferred = streams
          .flatMap((stream) => stream.events)
          .flatMap((event) => (event.type === 'finding-disposition' ? [event.payload] : []))
          .filter((payload) => payload.status === 'deferred' && payload.fingerprint.path === '');
        expect(deferred).toHaveLength(1);
        expect(deferred[0]?.observedHead).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await f.cleanup();
      }
    },
  );
});

test('local exit publication leases the observed destination separately from the local baseline', async () => {
  const f = await fixture();
  try {
    const expected = f.repo.git('rev-parse', 'HEAD').trim();
    f.repo.git('push', 'origin', 'HEAD:refs/heads/feature/x');
    f.repo.git('commit', '--allow-empty', '-m', 'prior local work');
    f.record.head = f.repo.git('rev-parse', 'HEAD').trim();
    const pushes: string[][] = [];
    const git = makeGhRunner({ bin: 'git' });
    const op = makeReviewAddress({
      drivers: f.drivers,
      initialRecord: f.record,
      git: async (args) => {
        if (args.includes('push')) pushes.push(args);
        return git(args);
      },
    });
    const result = await op({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
      push: true,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`--force-with-lease=refs/heads/feature/x:${expected}`);
    expect(pushes[0]?.at(-1)).toBe(
      `${f.repo.git('rev-parse', 'HEAD').trim()}:refs/heads/feature/x`,
    );
  } finally {
    await f.cleanup();
  }
});
