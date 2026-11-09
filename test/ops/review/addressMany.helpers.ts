// Split provenance: test/ops/review/addressMany.test.ts was split into this
// module plus addressMany.registry.test.ts, addressMany.dispatch.test.ts,
// addressMany.guards.test.ts, addressMany.budget.test.ts,
// addressMany.query.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { vi } from 'vitest';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';

export const head = 'a'.repeat(40);
export const input = {
  repoRoot: '/repo',
  repo: 'owner/repo',
  owner: 'owner',
  pulls: [1, 2],
  concurrency: 1,
  maxTokens: 100,
  tokensPerPr: 50,
};
export const metadata = (number: number) => ({
  number,
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'owner', type: 'User' },
  base: { ref: 'main' },
  head: { sha: head, ref: `fix-${number}`, repo: { full_name: 'owner/repo' } },
});
export const gh = vi.fn(async (args: string[]) => ({
  code: 0,
  stderr: '',
  stdout:
    args[0] === 'repo'
      ? JSON.stringify({ nameWithOwner: 'owner/repo' })
      : JSON.stringify(metadata(Number(args[1]!.split('/').at(-1)))),
}));
export const report = (): ReviewAddressReport => ({
  version: 1,
  source: 'pr:1',
  reportPath: '/report',
  rounds: [],
  findings: [],
  openBlocking: [],
  fixes: [],
  attempts: [],
  failed: [],
  fixesPerRun: 0,
  usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  wallMs: 1,
  reasons: [],
  admissionHead: head,
});
export const enrollmentRequest = {
  requestId: 'm4-test',
  binding: {
    kind: 'deferred-author' as const,
    repo: input.repo,
    head,
    producer: 'm4',
    target: 'main',
    targetSelector: 'promoted-main' as const,
  },
};
