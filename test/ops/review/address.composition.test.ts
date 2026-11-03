// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,reviewRounds,admission,blockedRereview,vendorBoundary,lock,m5b3Correlation}.test.ts.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { addressBatches, makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { config, finding, fixture, reportOf } from './address.helpers.js';

test.each([undefined, '/prepared/pr-7', 'prepared/pr-7'])(
  'plain caller records dependency selection: %s',
  async (dependencyRoot) => {
    const f = await fixture();
    let selected: string | undefined;
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: (deps) => {
          selected = deps.dependencyRoot;
          return f.deps.workerFactory!(deps);
        },
      })({
        repoRoot: f.repo.root,
        source: 'local',
        ...(dependencyRoot === undefined ? {} : { dependencyRoot }),
        journalDir: f.input.journalDir,
      });
      const expected = dependencyRoot?.startsWith('/')
        ? dependencyRoot
        : join(f.repo.root, dependencyRoot ?? '.');
      expect(selected).toBe(expected);
      expect(reportOf(result).dependencySource).toEqual({
        kind: dependencyRoot === undefined ? 'caller' : 'prepared',
        root: expected,
      });
    } finally {
      await f.cleanup();
    }
  },
);

describe('review.address composition', () => {
  test('an engine prerequisite refusal stops the leg before paid re-review', async () => {
    const f = await fixture();
    const reason = 'baseline precondition failed: dependency metadata differs';
    let refused = false;
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          preconditionFailure: () => (refused ? reason : undefined),
          preconditions: () =>
            refused ? [{ kind: 'deterministic', scope: 'leg', stage: 'dependencies', reason }] : [],
          fix: async (item) => {
            refused = true;
            return {
              finding: { ...item, status: 'deferred', reason },
              observedHead: f.record().head,
              reason,
              validation: [],
            };
          },
        }),
      })({ ...f.input, rounds: 10 });
      expect(result.status).toBe('needs-human');
      expect(result.status === 'needs-human' && result.reason).toContain(reason);
      expect(f.calls).not.toContain('review');
      expect(reportOf(result).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(reportOf(result).preconditions).toEqual([
        { kind: 'deterministic', scope: 'leg', stage: 'dependencies', reason },
      ]);
    } finally {
      await f.cleanup();
    }
  });
  test('CLI closure fixture preserves an uncertain finding as open with exit 3', async () => {
    const f = await fixture();
    try {
      await f.repo.write('a.ts', 'throw new Error("BAD");\n');
      f.repo.commitAll('closure CLI trigger');
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../fixtures/review-closure-cli/entry.mjs', import.meta.url)),
          'review.address',
          '--source=local',
          `--repoRoot=${f.repo.root}`,
          '--verifyClosure',
          '--rounds=1',
          `--journalDir=${f.input.journalDir}`,
          '--json',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(child.status, child.stderr).toBe(3);
      expect(JSON.parse(child.stdout)).toMatchObject({
        status: 'needs-human',
        report: {
          findings: [{ id: 'demo', status: 'open' }],
          closureVerifications: [
            {
              verification: { verdict: 'uncertain', reason: 'omitted-consumer-or-dependency' },
            },
          ],
        },
      });
    } finally {
      await f.cleanup();
    }
  });

  test.each([true, false])(
    'closure verification opt-in=%s uses pinned evidence',
    async (verifyClosure) => {
      const f = await fixture([{ ...finding('a'), text: 'Replace `a = 1`' }]);
      try {
        let committed = '';
        const before = f.repo.git('show', 'HEAD:src/a.ts');
        const result = await makeReviewAddress({
          ...f.deps,
          workerFactory: () => ({
            escalation: createEscalationState,
            fix: async (item) => {
              const observedHead = f.record().head;
              await f.repo.write('sibling.txt', 'concurrent sibling\n');
              const validatedParent = f.repo.commitAll('sibling fix');
              await f.repo.write('src/a.ts', 'export const fixedA = 2;\n');
              committed = f.repo.commitAll('fix a');
              // The packet must read the committed snapshot, never this live file.
              await f.repo.write('src/a.ts', 'uncommitted drift\n');
              return {
                finding: { ...item, status: 'fixed' },
                observedHead,
                commit: committed,
                validatedParent,
                reason: 'fixed',
                validation: [],
              };
            },
          }),
        })({ ...f.input, verifyClosure, rounds: 1 });
        const report = reportOf(result);
        if (verifyClosure) {
          expect(result.status).toBe('needs-human');
          expect(f.calls).not.toContain('disposition:fixed');
          expect(f.calls).not.toContain('review');
          expect(report.findings[0]?.status).toBe('open');
          const evidence = report.closureVerifications?.[0];
          expect(evidence?.packet.before).toBe(before);
          expect(evidence?.packet.after).toBe('export const fixedA = 2;\n');
          expect(evidence?.packet.metadata.revision.head).toBe(committed);
          expect(evidence?.packet.metadata.revision.parent).toBe(
            f.repo.git('rev-parse', `${committed}^`).trim(),
          );
          expect(evidence?.packet.patch).toContain('+export const fixedA = 2;');
          expect(evidence?.packet.relevantDependenciesComplete).toBe(false);
          expect(evidence?.verification.verdict).toBe('uncertain');
          expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toMatchObject({
            closureVerifications: report.closureVerifications,
          });
        } else {
          expect(report.closureVerifications).toBeUndefined();
          expect(f.calls).toContain('disposition:fixed');
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  test.each([true, false])(
    'portable cq.json parsing gates clean record acceptance: valid=%s',
    async (valid) => {
      const f = await fixture([]);
      try {
        await f.repo.write(
          'cq.json',
          valid ? JSON.stringify(config) : '{"schemaVersion":2,"checks":"invalid"}',
        );
        f.repo.commitAll('fixture configuration');
        const deps = { ...f.deps, initialRecord: f.record() };
        delete deps.config;
        const result = await makeReviewAddress(deps)(f.input);
        expect(result.status).toBe(valid ? 'ok' : 'needs-human');
        expect(f.calls).toEqual([]);
        expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
          reportOf(result),
        );
      } finally {
        await f.cleanup();
      }
    },
  );
  test('paid reasoning tokens stop sibling dispatch and survive the budget refusal report', async () => {
    const f = await fixture([finding('a'), finding('b')]);
    try {
      const attempted: string[] = [];
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: (deps) => ({
          escalation: createEscalationState,
          fix: async (item) => {
            attempted.push(item.id);
            deps.account({
              stopReason: 'complete',
              usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
              costUSD: 0.25,
              denials: [],
            });
            return {
              finding: { ...item, status: 'deferred', reason: 'needs owner' },
              observedHead: f.record().head,
              reason: 'needs owner',
              validation: [],
            };
          },
        }),
      })({ ...f.input, maxTokens: 10, concurrency: 1 });
      expect(result.status).toBe('needs-human');
      expect(attempted).toEqual(['a']);
      expect(reportOf(result).rounds).toHaveLength(1);
      expect(reportOf(result).rounds[0]?.runs).toHaveLength(1);
      expect(f.calls).not.toContain('review');
      expect(reportOf(result).usage).toEqual({
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 2,
      });
      expect(reportOf(result).costUSD).toBe(0.25);
      expect(reportOf(result).reasons.join(' ')).toMatch(/budget/);
      // S7 H (D1): the structured budget marker a composition publishes on.
      expect(reportOf(result).stop).toBe('budget');
      // #490: the budget stop came before any re-review, so the rows are the
      // dispatched snapshot. 'a' carries its recorded outcome; 'b' was never
      // attempted and stays open.
      expect(
        reportOf(result).findings.map(({ id, status, reason }) => ({ id, status, reason })),
      ).toEqual([
        { id: 'a', status: 'deferred', reason: 'needs owner' },
        { id: 'b', status: 'open', reason: undefined },
      ]);
      // Deferred and never-attempted rows both stay blocking.
      expect(reportOf(result).openBlocking.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'a', status: 'deferred' },
        { id: 'b', status: 'open' },
      ]);
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  });
  test('one round retains both batch runs and only its final findings record', async () => {
    const f = await fixture([finding('a'), finding('b')]);
    try {
      const result = await makeReviewAddress(f.deps)({ ...f.input, concurrency: 1, rounds: 1 });
      const report = reportOf(result);
      expect(f.calls.filter((call) => call.startsWith('fix:'))).toEqual(['fix:a', 'fix:b']);
      // The injected disposition makes `admitRecord` return before admission, so
      // this run must never claim an admission witness it did not earn.
      expect(report.admissionHead).toBeUndefined();
      expect(report.rounds).toHaveLength(1);
      expect(report.rounds[0]).toMatchObject({ round: 1, record: { findings: report.findings } });
      expect(report.rounds[0]).toHaveProperty('runs', [
        expect.objectContaining({ jobs: [expect.objectContaining({ jobId: 'finding-0' })] }),
        expect.objectContaining({ jobs: [expect.objectContaining({ jobId: 'finding-0' })] }),
      ]);
      expect(report.rounds[0]).not.toHaveProperty('run');
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    } finally {
      await f.cleanup();
    }
  });
  test('waves bound concurrency, serialize aliases and put unanchored findings alone', () => {
    const unanchored = { ...finding('unknown'), file: undefined };
    expect(
      addressBatches(
        [finding('a'), finding('alias', './src/a.ts'), finding('b'), unanchored, finding('c')],
        2,
      ).map((batch) => batch.map((f) => f.id)),
    ).toEqual([['a', 'b'], ['alias'], ['unknown'], ['c']]);
    expect(() => addressBatches([], 0)).toThrow('positive');
  });
  test('empty-file scope is a singleton and retains its own empty identity', () => {
    const empty = { ...finding('empty'), file: '' };
    const batches = addressBatches([finding('a'), empty, finding('b')], 2);
    expect(batches.map((batch) => batch.map((row) => row.id))).toEqual([['a'], ['empty'], ['b']]);
    expect(batches[1]?.[0]).toBe(empty);
    expect(empty).toHaveProperty('file', '');
  });

  test('mixed findings run eligible work and stop before re-review with the empty row OPEN', async () => {
    const f = await fixture([finding('a'), { ...finding('empty'), file: '' }]);
    try {
      const result = await makeReviewAddress(f.deps)(f.input);
      expect(result.status).toBe('needs-human');
      expect(f.calls).toEqual(['fix:a', 'disposition:deferred']);
      const report = reportOf(result);
      if (result.status !== 'needs-human') throw new Error('missing empty-file refusal');
      expect(result.reason).toBe(
        `unresolved: finding has no file path; report: ${report.reportPath}`,
      );
      expect(report.reasons).toContain('unresolved: finding has no file path');
      expect(report.findings.find((row) => row.id === 'empty')).toMatchObject({
        file: '',
        status: 'open',
        reason: 'unresolved: finding has no file path',
      });
      expect(report.openBlocking.find((row) => row.id === 'empty')).toHaveProperty('file', '');
      expect(report.fixes.map((fix) => fix.finding.id)).toEqual(['a']);
    } finally {
      await f.cleanup();
    }
  });
});
