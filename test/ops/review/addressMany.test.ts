import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import { ReviewAddressManyInputSchema, registry } from '../../../src/ops/review/registry.js';

const head = 'a'.repeat(40);
const input = {
  repoRoot: '/repo',
  repo: 'owner/repo',
  owner: 'owner',
  pulls: [1, 2],
  maxTokens: 100,
  tokensPerPr: 50,
};
const metadata = (number: number) => ({
  number,
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'owner', type: 'User' },
  head: { sha: head, ref: `fix-${number}`, repo: { full_name: 'owner/repo' } },
});
const gh = vi.fn(async (args: string[]) => ({
  code: 0,
  stderr: '',
  stdout:
    args[0] === 'repo'
      ? JSON.stringify({ nameWithOwner: 'owner/repo' })
      : JSON.stringify(metadata(Number(args[1]!.split('/').at(-1)))),
}));
const report = (): ReviewAddressReport => ({
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

test('registry exposes strict bulk schema for generic CLI dispatch', async () => {
  const entry = registry.find((entry) => entry.name === 'review.addressMany');
  expect(entry).toBeDefined();
  expect(typeof (await entry!.importer())).toBe('function');
  expect(ReviewAddressManyInputSchema.safeParse({ ...input, typo: true }).success).toBe(false);
});

test('addresses two independently attributed heads and preserves reports', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ gh, address })(input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('expected success');
  expect(result.value.rows.map((row) => row.scope.number)).toEqual([1, 2]);
  expect(result.value.accounting.observedTokens).toBe(20);
  expect(address.mock.calls).toHaveLength(2);
});

test('known failed leg does not discard a successful sibling', async () => {
  let calls = 0;
  const address = vi.fn(async () =>
    ++calls === 1
      ? { status: 'failed' as const, error: 'verification failed', report: report() }
      : { status: 'ok' as const, value: report() },
  );
  const result = await makeReviewAddressMany({ gh, address })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.rows).toHaveLength(2);
  expect(address).toHaveBeenCalledTimes(2);
});

test('unknown usage stops admission and retains held allocation', async () => {
  const address = vi.fn(async () => {
    throw new Error('worker lost');
  });
  const result = await makeReviewAddressMany({ gh, address })(input);
  expect(address).toHaveBeenCalledTimes(1);
  expect(result.report?.accounting.stop).toBe('unknown-usage');
  expect(result.report?.rows[1]?.status).toBe('not-admitted');
});

test('changed head before dispatch refuses and never invokes the address engine', async () => {
  let calls = 0;
  const changingGh = async (args: string[]) => ({
    code: 0,
    stderr: '',
    stdout:
      args[0] === 'repo'
        ? JSON.stringify({ nameWithOwner: 'owner/repo' })
        : JSON.stringify({
            ...metadata(1),
            head: { ...metadata(1).head, sha: ++calls === 1 ? head : 'b'.repeat(40) },
          }),
  });
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ gh: changingGh, address })({ ...input, pulls: [1] });
  expect(address).not.toHaveBeenCalled();
  expect(result.report?.rows[0]?.status).toBe('exception');
});

test('refuses a repository mismatch without dispatching', async () => {
  const otherGh = async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ nameWithOwner: 'other/repo' }),
  });
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ gh: otherGh, address })(input);
  expect(result.status).toBe('needs-human');
  expect(address).not.toHaveBeenCalled();
});

test('oversized reservation never dispatches either PR', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ gh, address })({ ...input, maxTokens: 10 });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.rows.every((row) => row.status === 'not-admitted')).toBe(true);
  expect(address).not.toHaveBeenCalled();
});
