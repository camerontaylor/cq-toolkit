import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    reviewed: { base: repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(), scope: 'full' },
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
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
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
                  : f.repo.git('rev-parse', 'origin/merge-queue').trim(),
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
          f.repo.git('update-ref', 'refs/remotes/origin/merge-queue', commit);
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
    expect(f.repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim()).not.toBe(originalBase);
  } finally {
    await f.cleanup();
  }
});
