import { makeGitMutex } from '../../../src/shared/gitMutex.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkerResult } from '../../../src/driver/types.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  addressBatches,
  makeReviewAddress,
  type ReviewAddressDeps,
  type ReviewAddressReport,
} from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import {
  DEV_LEDGER_VERSION,
  devLedgerPath,
  type DevVendorDebtRecord,
} from '../../../src/ops/dev/record.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { cycleRecord } from '../dev/fakes.js';
import { makeTestRepo } from '../dev/repo.js';

const finding = (id: string, file: string | undefined = `src/${id}.ts`): Finding => ({
  id,
  source: 'agent',
  ...(file ? { file } : {}),
  severity: 'major',
  text: `fix ${id}`,
  status: 'open',
});
const role = { provider: 'mock', model: 'mock' };
const config: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: { worker: role, reviewer: role },
  budgets: { run: { maxTokens: 1000 } },
  review: { reviewers: ['agent'] },
};
async function fixture(findings: Finding[] = [finding('a')]) {
  const repo = await makeTestRepo();
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-composition-'));
  const record = (): FindingsRecord => ({
    schemaVersion: 1,
    branch: 'feature/x',
    reviewed: { base: repo.git('merge-base', 'origin/main', 'HEAD').trim(), scope: 'full' },
    head: repo.git('rev-parse', 'HEAD').trim(),
    sources: [{ kind: 'agent', status: 'terminal' }],
    findings,
  });
  const calls: string[] = [];
  const deps: ReviewAddressDeps = {
    config,
    initialRecord: record(),
    review: async () => {
      calls.push('review');
      return { status: 'ok', value: { ...record(), findings: [] } };
    },
    disposition: async (_root, f) => {
      calls.push(`disposition:${f.status}`);
      return { status: 'ok', value: {} };
    },
    workerFactory: () => ({
      escalation: createEscalationState,
      fix: async (f) => {
        calls.push(`fix:${f.id}`);
        return {
          finding: { ...f, status: 'deferred', reason: 'requires owner' },
          reason: 'requires owner',
          observedHead: record().head,
          validation: [],
        };
      },
    }),
  };
  return {
    repo,
    deps,
    calls,
    record,
    input: { repoRoot: repo.root, source: 'local', journalDir },
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}
const reportOf = (
  result: Awaited<ReturnType<ReturnType<typeof makeReviewAddress>>>,
): ReviewAddressReport => (result.status === 'ok' ? result.value : result.report!);

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

  test('no token default or missing roles dispatches work; durable report survives every refusal', async () => {
    const f = await fixture();
    try {
      for (const gap of ['budget', 'roles'] as const) {
        const c = { ...config };
        if (gap === 'budget') delete c.budgets;
        else delete c.roles;
        const result = await makeReviewAddress({ ...f.deps, config: c })(f.input);
        expect(result.status).toBe('needs-human');
        expect(f.calls).toEqual([]);
        const report = reportOf(result);
        expect(report.admissionHead).toBeUndefined();
        expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
      }
    } finally {
      await f.cleanup();
    }
  });
  test('stale findings and incomplete review sources refuse before dispatch', async () => {
    const f = await fixture();
    try {
      for (const record of [
        { ...f.record(), head: 'stale' },
        {
          ...f.record(),
          sources: [
            { kind: 'agent' as const, status: 'blocked' as const, reason: 'review unavailable' },
          ],
        },
      ]) {
        const result = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
        expect(result.status).toBe('needs-human');
        expect(f.calls).toEqual([]);
        // A refusal that is not a budget stop never carries the budget marker.
        expect(reportOf(result).stop).toBeUndefined();
      }
    } finally {
      await f.cleanup();
    }
  });
  test('deferred blocking remains open through omitted re-review findings and the round cap', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress(f.deps)({ ...f.input, rounds: 2 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).openBlocking).toMatchObject([
        { id: 'a', status: 'deferred', reason: 'requires owner' },
      ]);
      expect(f.calls.filter((call) => call === 'fix:a')).toHaveLength(1);
      expect(f.calls).toContain('disposition:deferred');
      expect(reportOf(result).reasons).toContain('review round cap reached with open findings');
      // The production round cap carries the structured marker compositions
      // key on — inside the report envelope (the kernel-sanctioned extension),
      // never a top-level field (the strict OpResultSchema would reject it).
      expect(reportOf(result).stop).toBe('round-cap');
      expect(reportOf(result).rounds.map((entry) => entry.round)).toEqual([1, 2]);
    } finally {
      await f.cleanup();
    }
  });
  test('re-review reporting an allegedly fixed defect again keeps it open', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => ({
            finding: { ...finding, status: 'fixed', reason: 'claimed' },
            commit: 'a'.repeat(40),
            observedHead: f.record().head,
            reason: 'claimed',
            validation: [],
          }),
        }),
        review: async () => ({ status: 'ok', value: f.record() }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).openBlocking[0]?.status).toBe('open');
      // #490: the validated re-review's rows are authoritative; the earlier
      // claimed fix never overwrites the reopened row.
      expect(reportOf(result).findings.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'a', status: 'open' },
      ]);
    } finally {
      await f.cleanup();
    }
  });
  test('local re-review uploads the prior round findings with their final dispositions', async () => {
    const f = await fixture();
    try {
      let priorFindings: readonly Finding[] | undefined;
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => ({
            finding: { ...finding, status: 'fixed', reason: 'verified candidate bytes' },
            observedHead: f.record().head,
            reason: 'verified candidate bytes',
            validation: [],
          }),
        }),
        review: async (input) => {
          priorFindings = input.priorFindings;
          return {
            status: 'ok',
            value: { ...f.record(), findings: [], advisories: ['re-review advisory'] },
          };
        },
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('ok');
      expect(priorFindings).toEqual([
        expect.objectContaining({
          id: 'a',
          status: 'fixed',
          reason: 'verified candidate bytes',
        }),
      ]);
      expect(reportOf(result).advisories).toEqual(['re-review advisory']);
    } finally {
      await f.cleanup();
    }
  });
  test('review advisories stay report context and never enter findings', async () => {
    const f = await fixture([]);
    try {
      const deps = {
        ...f.deps,
        initialRecord: {
          ...f.record(),
          advisories: ['lockfile excluded: assured by dev.check'],
        },
      };
      const result = await makeReviewAddress(deps)(f.input);
      expect(result.status).toBe('ok');
      expect(reportOf(result).advisories).toEqual(['lockfile excluded: assured by dev.check']);
      expect(reportOf(result).findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('a disposition persistence failure cannot become a clean run when re-review omits it', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        disposition: async () => ({ status: 'failed', error: 'ledger unavailable' }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.some((reason) => reason.includes('ledger unavailable'))).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
  test('#490: a failed disposition write leaves the dispatched row open', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        disposition: async () => ({ status: 'failed', error: 'ledger unavailable' }),
        review: async () => ({
          status: 'needs-human',
          reason: 'review.run: not every configured reviewer completed a terminal cycle',
        }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).fixes.map((fix) => fix.finding.status)).toEqual(['open']);
      expect(reportOf(result).findings.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'a', status: 'open' },
      ]);
      // An unpersisted outcome never leaves the blockers.
      expect(reportOf(result).openBlocking.map(({ id }) => id)).toEqual(['a']);
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  });
  test('invalid source still emits its report and clean complete findings exit ok without workers', async () => {
    const f = await fixture([]);
    try {
      const invalid = await makeReviewAddress(f.deps)({ ...f.input, source: 'pr:0' });
      expect(invalid.status).toBe('failed');
      expect(reportOf(invalid).usage.input).toBe(0);
      expect(reportOf(invalid).admissionHead).toBeUndefined();
      const clean = await makeReviewAddress(f.deps)(f.input);
      expect(clean.status).toBe('ok');
      // The clean exit is admitted through `admitCleanRecord`'s final guards, so
      // it carries the engine-read head even though no worker ran.
      expect(reportOf(clean).admissionHead).toBe(f.record().head);
      expect(f.calls).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('a successful re-review refreshes the first-round record but not the admission witness', async () => {
    const f = await fixture([finding('a')]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      // Real admission writes the engine's own ledger, so the fixture must ignore
      // `.cq/` before the run: the clean exit validates a clean publication tree.
      await f.repo.write('.gitignore', '/.cq/\n');
      f.repo.commitAll('ignore engine state');
      const admittedHead = f.record().head;
      let fixedHead = '';
      const deps: ReviewAddressDeps = {
        ...realDeps,
        initialRecord: f.record(),
        // Real admission: the injected disposition would bypass `admitRecord`,
        // and a bypass may never fabricate a witness.
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (target) => {
            await f.repo.write(`src/${target.id}.ts`, 'export const fixed = 1;\n');
            fixedHead = f.repo.commitAll(`fix ${target.id}`);
            return {
              finding: { ...target, status: 'fixed' as const, reason: 'fixed' },
              reason: 'fixed',
              observedHead: fixedHead,
              commit: fixedHead,
              validation: [],
            };
          },
        }),
        review: async () => ({
          status: 'ok' as const,
          value: { ...f.record(), head: fixedHead, findings: [] },
        }),
      };
      const result = await makeReviewAddress(deps)({ ...f.input, rounds: 1 });
      const report = reportOf(result);
      expect(result.status, report.reasons.join(' | ')).toBe('ok');
      expect(fixedHead).not.toBe(admittedHead);
      // The mutable producer view really was refreshed to the verified fix head…
      expect(report.rounds[0]?.record.head).toBe(fixedHead);
      // …while the immutable witness still names the admitted head.
      expect(report.admissionHead).toBe(admittedHead);
      expect(report.verifiedHead).toBe(fixedHead);
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    } finally {
      await f.cleanup();
    }
  });
  test('a head-matching record refused for its sources never fabricates a witness', async () => {
    const f = await fixture([finding('a')]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      const result = await makeReviewAddress({
        ...realDeps,
        initialRecord: { ...f.record(), sources: [] },
      })(f.input);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toMatch(/review source incomplete/);
      // The head matched, but the run refused before any admission.
      expect(reportOf(result).admissionHead).toBeUndefined();
      expect(f.calls).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});

test.each(['clean', 'tracked', 'staged', 'untracked'] as const)(
  'head-only clean findings cannot certify %s content',
  async (mode) => {
    const f = await fixture([]);
    try {
      const head = f.record().head;
      if (mode !== 'clean') {
        await f.repo.write(
          mode === 'untracked' ? 'unreviewed.ts' : 'src/a.ts',
          'unreviewed content',
        );
        if (mode === 'staged') f.repo.git('add', 'src/a.ts');
      }
      const result = await makeReviewAddress(f.deps)(f.input);
      expect(result.status).toBe(mode === 'clean' ? 'ok' : 'needs-human');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(f.calls).toEqual([]);
      if (mode !== 'clean') expect(reportOf(result).reasons.join(' ')).toMatch(/dirty|untracked/);
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test('a clean refreshed record cannot return ok after its wall budget expires', async () => {
  const f = await fixture();
  const realNow = Date.now;
  let clock = realNow();
  try {
    const deps = {
      ...f.deps,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding: Finding) => {
          f.calls.push(`fix:${finding.id}`);
          return {
            finding: { ...finding, status: 'rejected' as const, reason: 'false positive' },
            reason: 'false positive',
            observedHead: f.record().head,
            validation: [],
          };
        },
      }),
      review: async () => {
        clock += 1001;
        return { status: 'ok' as const, value: { ...f.record(), findings: [] } };
      },
    };
    Date.now = () => clock;
    const result = await makeReviewAddress(deps)({ ...f.input, wallMs: 1000, rounds: 1 });
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).reasons.join(' ')).toMatch(/wall/);
    expect(f.calls).toContain('fix:a');
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

test.each([
  'explicit',
  'latest',
  'latest-unknown-head',
  'latest-other-branch',
  'latest-malformed-history',
  'head-mismatch',
  'branch-mismatch',
  'blocked',
  'malformed',
  'missing',
] as const)('local persisted findings admission is fail closed: %s', async (mode) => {
  const f = await fixture([]);
  try {
    const deps = { ...f.deps };
    delete deps.initialRecord;
    const record = f.record();
    if (mode === 'head-mismatch') record.head = 'a'.repeat(40);
    if (mode === 'branch-mismatch') record.branch = 'other';
    if (mode === 'blocked')
      record.sources = [{ kind: 'agent', status: 'blocked', reason: 'review interrupted' }];
    const folder = join(f.repo.root, '.cq', 'review', encodeURIComponent(record.branch));
    await mkdir(folder, { recursive: true });
    const latest = mode.startsWith('latest');
    const path =
      latest || mode === 'missing'
        ? join(folder, '2.json')
        : join(f.input.journalDir, 'record.json');
    if (mode !== 'missing')
      await writeFile(path, mode === 'malformed' ? '{' : JSON.stringify(record));
    if (latest)
      await writeFile(
        join(folder, '1.json'),
        mode === 'latest-malformed-history'
          ? '{'
          : JSON.stringify({
              ...record,
              head:
                mode === 'latest-unknown-head'
                  ? 'a'.repeat(40)
                  : f.repo.git('rev-parse', 'origin/main').trim(),
              ...(mode === 'latest-other-branch' ? { branch: 'other' } : {}),
            }),
      );
    const result = await makeReviewAddress(deps)({
      ...f.input,
      ...(latest || mode === 'missing' ? {} : { record: path }),
    });
    expect(result.status).toBe(mode === 'explicit' || mode === 'latest' ? 'ok' : 'needs-human');
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
      reportOf(result),
    );
  } finally {
    await f.cleanup();
  }
});

test('report storage failure retains the complete non-ok artifact', async () => {
  const f = await fixture([]);
  try {
    const journalFile = join(f.input.journalDir, 'file');
    await writeFile(journalFile, 'not a directory');
    const result = await makeReviewAddress(f.deps)({ ...f.input, journalDir: journalFile });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('report write failed');
    expect(reportOf(result).findings).toEqual([]);
    expect(reportOf(result).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  } finally {
    await f.cleanup();
  }
});

test.each(['matching', 'uncommitted', 'different-base', 'missing'] as const)(
  'clean record needs immutable full review scope: %s',
  async (mode) => {
    const f = await fixture([]);
    try {
      const record = f.record();
      if (mode === 'uncommitted') record.reviewed!.scope = 'uncommitted';
      if (mode === 'different-base') record.reviewed!.base = record.head;
      if (mode === 'missing') delete record.reviewed;
      const result = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
      expect(result.status).toBe(mode === 'matching' ? 'ok' : 'needs-human');
      expect(f.calls).toEqual([]);
      if (mode !== 'matching')
        expect(reportOf(result).reasons.join(' ')).toContain('reviewed base/scope');
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  },
);
test('a record reviewed against HEAD cannot certify the wider target diff on the same clean head', async () => {
  const f = await fixture([]);
  try {
    const record = { ...f.record(), reviewed: { base: f.record().head, scope: 'full' as const } };
    const same = await makeReviewAddress({ ...f.deps, initialRecord: record })({
      ...f.input,
      base: record.head,
    });
    expect(same.status).toBe('ok');
    const wider = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
    expect(wider.status).toBe('needs-human');
    expect(reportOf(wider).reasons.join(' ')).toContain('reviewed base/scope');
    expect(f.calls).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('re-review keeps the original full comparison when a mutable target ref moves during work', async () => {
  const f = await fixture();
  const originalBase = f.record().reviewed!.base;
  let reviewedBase: string | undefined;
  try {
    const result = await makeReviewAddress({
      ...f.deps,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => {
          const observedHead = f.record().head;
          await f.repo.write('src/a.ts', 'verified fixture fix\n');
          const commit = f.repo.commitAll('scripted verified fix');
          f.repo.git('update-ref', 'refs/remotes/origin/main', commit);
          return {
            finding: { ...item, status: 'fixed' },
            commit,
            reason: 'fixed',
            observedHead,
            validation: [],
          };
        },
      }),
      review: async (input) => {
        reviewedBase = input.base;
        return {
          status: 'ok',
          value: { ...f.record(), reviewed: { base: input.base!, scope: 'full' }, findings: [] },
        };
      },
    })(f.input);
    expect(result.status).toBe('ok');
    expect(reviewedBase).toBe(originalBase);
    expect(f.repo.git('merge-base', 'origin/main', 'HEAD').trim()).not.toBe(originalBase);
  } finally {
    await f.cleanup();
  }
});

describe('blocked re-review marker (#509)', () => {
  const blockedTransient = (record: FindingsRecord) => ({
    status: 'needs-human' as const,
    reason: 'review.run: not every configured reviewer completed a terminal cycle',
    report: { ...record, blockedTransient: true as const },
  });
  /** One verified fix, then a blocked re-review (with one retry for transient blocks). */
  const run = async (
    spendOnRetry: number,
    firstBlock?: 'wall' | 'tokens' | 'remaining' | 'claimed-budget',
  ) => {
    const f = await fixture();
    const realNow = Date.now;
    let clock = realNow();
    try {
      if (firstBlock === 'wall') Date.now = () => clock;
      let account: ((result: WorkerResult) => void) | undefined;
      let reviews = 0;
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: (deps) => {
          account = deps.account;
          return {
            escalation: createEscalationState,
            fix: async (finding) => ({
              finding: { ...finding, status: 'fixed', reason: 'verified' },
              commit: 'a'.repeat(40),
              observedHead: f.record().head,
              reason: 'verified',
              validation: [],
            }),
          };
        },
        review: async () => {
          reviews += 1;
          if (firstBlock === 'wall') clock += 1001;
          if (firstBlock === 'tokens')
            account?.({
              stopReason: 'error',
              usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            });
          if (reviews === 2 && spendOnRetry > 0)
            account?.({
              stopReason: 'error',
              usage: { input: spendOnRetry, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            });
          return firstBlock
            ? {
                status: 'needs-human' as const,
                reason: 'review.run: not every configured reviewer completed a terminal cycle',
                report: {
                  ...f.record(),
                  ...(firstBlock !== 'remaining' ? { blockedBudget: true as const } : {}),
                },
              }
            : blockedTransient(f.record());
        },
      })({ ...f.input, maxTokens: 100, wallMs: firstBlock === 'wall' ? 1000 : 60000, rounds: 1 });
      return { result, reviews };
    } finally {
      Date.now = realNow;
      await f.cleanup();
    }
  };

  test.each(['wall', 'tokens'] as const)(
    '#532: a non-transient re-review block after exhausting %s carries budget',
    async (budget) => {
      const { result, reviews } = await run(0, budget);
      expect(reviews).toBe(1);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).fixes).toEqual([expect.objectContaining({ commit: 'a'.repeat(40) })]);
      expect(reportOf(result).stop).toBe('budget');
      expect(reportOf(result).verifiedHead).toBe('a'.repeat(40));
    },
  );

  test.each(['remaining', 'claimed-budget'] as const)(
    '#532: a %s block with leg budget remaining has no marker',
    async (mode) => {
      const { result, reviews } = await run(0, mode);
      expect(reviews).toBe(1);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).stop).toBeUndefined();
    },
  );

  test('still blocked after the retry with a verified fix: marked rereview-blocked', async () => {
    const { result, reviews } = await run(0);
    expect(reviews).toBe(2);
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).stop).toBe('rereview-blocked');
    // #490: no re-review replaced the dispatched rows, so the fixed finding's
    // row says fixed (S7 H/K/L reported every such row 'open').
    expect(
      reportOf(result).findings.map(({ id, status, reason }) => ({ id, status, reason })),
    ).toEqual([{ id: 'a', status: 'fixed', reason: 'verified' }]);
    // …and the draft-facing blockers agree with the rows: the fixed finding
    // is no longer listed as open blocking.
    expect(reportOf(result).openBlocking).toEqual([]);
  });

  test('a retry that exhausts the token budget carries budget, never rereview-blocked', async () => {
    const { result, reviews } = await run(100);
    expect(reviews).toBe(2);
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).stop).toBe('budget');
    expect(reportOf(result).stop).not.toBe('rereview-blocked');
  });
});

test.each(['identity', 'admission', 'scan', 'thrown'] as const)(
  '#532: %s refusal coinciding with the deadline stays unmarked',
  async (mode) => {
    const f = await fixture();
    const realNow = Date.now;
    let clock = realNow();
    try {
      Date.now = () => clock;
      const record = f.record();
      const result = await makeReviewAddress({
        ...f.deps,
        initialRecord:
          mode === 'admission'
            ? {
                ...record,
                get head() {
                  clock += 1001;
                  return 'b'.repeat(40);
                },
              }
            : record,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (item) => ({
            finding: { ...item, status: 'fixed', reason: 'verified' },
            commit: record.head,
            observedHead: record.head,
            reason: 'verified',
            validation: [],
          }),
        }),
        review: async () => {
          clock += 1001;
          if (mode === 'thrown') throw new Error('unexpected reviewer fault');
          if (mode === 'scan')
            return {
              status: 'needs-human',
              reason: 'review.run: denylist scan found protected content; refusing reviewer upload',
            };
          f.repo.git('commit', '--allow-empty', '-m', 'concurrent checkout');
          return { status: 'ok', value: record };
        },
      })({ ...f.input, wallMs: 1000 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).stop).toBeUndefined();
      expect(reportOf(result).reasons.join(' ')).toMatch(
        mode === 'identity'
          ? /identity changed/
          : mode === 'admission'
            ? /does not match/
            : mode === 'scan'
              ? /protected content/
              : /unexpected reviewer fault/,
      );
    } finally {
      Date.now = realNow;
      await f.cleanup();
    }
  },
);

const bothReviewerConfig: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: { worker: role, reviewer: role },
  budgets: { run: { maxTokens: 2000 } },
  review: { reviewers: ['agent', 'coderabbit'], rounds: 1 },
};

const vendorQueueStatus = (): QueueStatus => ({
  state: 'awaiting-pr',
  pr: null,
  mergeSha: null,
  itemId: null,
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
});

/**
 * Local composition across the REAL vendor-preparation boundary: the repo's own
 * cq.json configures both reviewers, it carries a genuine blocked CodeRabbit
 * origin in the dev ledger, and the DEFAULT makeReviewRun resolves forge
 * identity through a scoped offline `gh` shim. No review stub, no effects
 * factory, no disposition override.
 */
async function vendorAddressFixture() {
  const repo = await makeTestRepo();
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write('cq.json', JSON.stringify(bothReviewerConfig));
  repo.commitAll('configure both reviewers');
  const branch = 'feature/x';
  const head = repo.git('rev-parse', 'HEAD').trim();
  const base = repo.git('merge-base', 'origin/main', 'HEAD').trim();
  makeSubprocessDevEffects(repo.root)
    .openLedger(branch)
    .save({
      version: DEV_LEDGER_VERSION,
      branch,
      records: [
        cycleRecord({
          head,
          base,
          dirtySha256: 'clean-tree',
          cycleId: 'c001-origin',
          vendorFailure: {
            source: 'vendor',
            category: 'vendor-rate-limited',
            codes: ['rate_limited'],
          },
          completion: { kind: 'blocked', reason: 'structured rate limit' },
        }),
      ],
    });
  const shimDir = await mkdtemp(join(tmpdir(), 'cq-gh-shim-'));
  await writeFile(
    join(shimDir, 'gh'),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === 'repo') process.stdout.write('owner/repo\\n');\nelse if (args[0] === 'api') process.stdout.write('author\\n');\nelse process.exit(1);\n`,
    { mode: 0o755 },
  );
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-vendor-'));
  const record = (): FindingsRecord => ({
    schemaVersion: 1,
    branch,
    reviewed: { base, scope: 'full' },
    head,
    sources: [
      { kind: 'agent', status: 'terminal' },
      { kind: 'coderabbit', status: 'terminal' },
    ],
    findings: [finding('a')],
  });
  const ledger = () => makeSubprocessDevEffects(repo.root).openLedger(branch).load();
  const appendForeign = () => {
    const store = makeSubprocessDevEffects(repo.root).openLedger(branch);
    const latest = store.load();
    store.save({
      ...latest,
      records: [...latest.records, cycleRecord({ head, base, cycleId: 'c913-external-append' })],
    });
  };
  const run = (queueClient: DeferredQueueClient) =>
    makeReviewAddress({
      initialRecord: record(),
      queueClient,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => ({
          finding: { ...item, status: 'deferred', reason: 'needs owner' },
          observedHead: head,
          reason: 'needs owner',
          validation: [],
        }),
      }),
    })({ repoRoot: repo.root, source: 'local', journalDir, rounds: 1 });
  return {
    repo,
    shimDir,
    head,
    base,
    ledger,
    appendForeign,
    run,
    cleanup: async () => {
      await repo.cleanup();
      await rm(shimDir, { recursive: true, force: true });
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}

describe('review.address vendor preparation boundary', () => {
  test('external append with a returning status read refuses without owning the bytes', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        f.appendForeign();
        return vendorQueueStatus();
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      // The default runner actually dispatched: both queue calls, in order.
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'deferred debt or working identity changed while verifying queue status',
      );
      const ledger = f.ledger();
      // The engine's enrollment is durably on disk; the foreign bytes stay too,
      // and neither is reported as clean completion.
      expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });

  test('external append with a throwing status read preserves the original error', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        f.appendForeign();
        throw new Error('status read failed after external append');
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'status read failed after external append',
      );
      const ledger = f.ledger();
      expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });

  test('valid requested enrollment with a throwing status read is the reachable control', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        throw new Error('status read failed after durable enrollment');
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'status read failed after durable enrollment',
      );
      const ledger = f.ledger();
      const debts = ledger.records.filter(
        (entry): entry is DevVendorDebtRecord => entry.kind === 'vendor-debt',
      );
      expect(debts).toHaveLength(1);
      const debt = debts[0]!.debt;
      expect(debt.vendorCompleted).toBe(false);
      expect(debt.reference.binding).toMatchObject({
        kind: 'deferred-author',
        repo: 'owner/repo',
        producer: 'author',
        target: 'main',
        head: f.head,
      });
      expect(debt.deferral).toMatchObject({
        id: debt.reference.requestId,
        base: f.base,
        dirtySha256: 'clean-tree',
      });
      expect(debt.originAttempt).toMatchObject({
        cycleId: 'c001-origin',
        head: f.head,
        base: f.base,
        target: 'main',
      });
      // The real durable enrollment is the engine's own request on disk.
      const onDisk = JSON.parse(
        await readFile(devLedgerPath(f.repo.root, 'feature/x'), 'utf8'),
      ) as { records: { kind: string; debt?: { reference: { requestId: string } } }[] };
      const persisted = onDisk.records.filter((entry) => entry.kind === 'vendor-debt');
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.debt?.reference.requestId).toBe(debt.reference.requestId);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });
});

test('plain and isolated address calls share the caller per-PR lock', async () => {
  const f = await fixture();
  try {
    const domain = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const result = await makeGitMutex({
      lockPath: join(domain, 'cq-review-address-pr-7'),
      failFast: true,
    }).withLock(async () => {
      return makeReviewAddress({ ...f.deps, coordinationRoot: domain })({
        ...f.input,
        source: 'pr:7',
      });
    });
    expect(result.status).toBe('needs-human');
    expect(f.calls).toEqual([]);
    expect(result.status === 'needs-human' && result.reason).toMatch(/lock|locked/i);
  } finally {
    await f.cleanup();
  }
});
