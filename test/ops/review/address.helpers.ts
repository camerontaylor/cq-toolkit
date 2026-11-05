// Split provenance: test/ops/review/address.test.ts was split into this shared
// fixture module plus address.{composition,reviewRounds,admission,blockedRereview,vendorBoundary,lock,m5b3Correlation}.test.ts.
import { rm } from 'node:fs/promises';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import {
  makeReviewAddress,
  type ReviewAddressDeps,
  type ReviewAddressReport,
} from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeTestRepo } from '../dev/repo.js';

export const finding = (id: string, file: string | undefined = `src/${id}.ts`): Finding => ({
  id,
  source: 'agent',
  ...(file ? { file } : {}),
  severity: 'major',
  text: `fix ${id}`,
  status: 'open',
});
export const role = { provider: 'mock', model: 'mock' };
export const config: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: { worker: role, reviewer: role },
  budgets: { run: { maxTokens: 1000 } },
  review: { reviewers: ['agent'] },
};
export async function fixture(findings: Finding[] = [finding('a')]) {
  const repo = await makeTestRepo();
  const journalDir = await realTmpDir('cq-address-composition-');
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
export const reportOf = (
  result: Awaited<ReturnType<ReturnType<typeof makeReviewAddress>>>,
): ReviewAddressReport => (result.status === 'ok' ? result.value : result.report!);
