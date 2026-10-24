import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  addressBatches,
  makeReviewAddress,
  type ReviewAddressDeps,
  type ReviewAddressReport,
} from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
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
  test('invalid source still emits its report and clean complete findings exit ok without workers', async () => {
    const f = await fixture([]);
    try {
      const invalid = await makeReviewAddress(f.deps)({ ...f.input, source: 'pr:0' });
      expect(invalid.status).toBe('failed');
      expect(reportOf(invalid).usage.input).toBe(0);
      const clean = await makeReviewAddress(f.deps)(f.input);
      expect(clean.status).toBe('ok');
      expect(f.calls).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
