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
  concurrency: 1,
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
  const result = await makeReviewAddressMany({ isolate: async (root) => root, gh, address })(input);
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
  const result = await makeReviewAddressMany({ isolate: async (root) => root, gh, address })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.rows).toHaveLength(2);
  expect(address).toHaveBeenCalledTimes(2);
});

test('unknown usage stops admission and retains held allocation', async () => {
  const address = vi.fn(async () => {
    throw new Error('worker lost');
  });
  const result = await makeReviewAddressMany({ isolate: async (root) => root, gh, address })(input);
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
  const result = await makeReviewAddressMany({
    isolate: async (root) => root,
    gh: changingGh,
    address,
  })({ ...input, pulls: [1] });
  expect(address).not.toHaveBeenCalled();
  expect(result.status).toBe('needs-human');
  expect(result.report?.rows[0]?.status).toBe('settled-needs-human');
});

test('refuses a repository mismatch without dispatching', async () => {
  const otherGh = async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ nameWithOwner: 'other/repo' }),
  });
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    isolate: async (root) => root,
    gh: otherGh,
    address,
  })(input);
  expect(result.status).toBe('needs-human');
  expect(address).not.toHaveBeenCalled();
});

test('oversized reservation never dispatches either PR', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ isolate: async (root) => root, gh, address })({
    ...input,
    maxTokens: 10,
  });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.rows.every((row) => row.status === 'not-admitted')).toBe(true);
  expect(address).not.toHaveBeenCalled();
});

test('unclean summaries retain each PR reason when aggregate accounting is clean', async () => {
  const address = vi.fn(async () => ({
    status: 'needs-human' as const,
    reason: 'reviewer unavailable',
    report: report(),
  }));
  const result = await makeReviewAddressMany({ isolate: async (root) => root, gh, address })(input);
  expect(result.status).toBe('needs-human');
  if (result.status !== 'needs-human') throw new Error('expected needs-human');
  expect(result.reason).toContain('PR #1: reviewer unavailable');
  expect(result.reason).toContain('PR #2: reviewer unavailable');
  expect(result.report?.reasons).toEqual([
    'PR #1: reviewer unavailable',
    'PR #2: reviewer unavailable',
  ]);
});

test('bounded workers overlap and settle shared allocation without oversubscription', async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const address = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    if (active === 2) release();
    await barrier;
    active--;
    return { status: 'ok' as const, value: report() };
  });
  const result = await makeReviewAddressMany({ gh, address, isolate: async (root) => root })({
    ...input,
    concurrency: 2,
  });
  expect(peak).toBe(2);
  expect(result.status).toBe('ok');
  if (result.status === 'ok') expect(result.value.accounting.observedTokens).toBe(20);
});

test.each([true, false])(
  'query enumeration refuses incomplete=%s without dispatch',
  async (incomplete) => {
    const address = vi.fn();
    const searchGh = async (args: string[]) =>
      args.includes('search/issues')
        ? {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({
              total_count: 101,
              incomplete_results: incomplete,
              items: [
                {
                  number: 1,
                  repository_url: 'https://api.github.com/repos/owner/repo',
                  pull_request: { url: 'url' },
                },
              ],
            }),
          }
        : gh(args);
    const { pulls: _, ...queryInput } = input;
    const result = await makeReviewAddressMany({ gh: searchGh, address })({
      ...queryInput,
      query: 'label:fix',
    });
    expect(result.status).toBe('needs-human');
    expect(address).not.toHaveBeenCalled();
  },
);

test('complete query dispatches eligible PRs', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const searchGh = async (args: string[]) =>
    args.includes('search/issues')
      ? {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                number: 1,
                repository_url: 'https://api.github.com/repos/owner/repo',
                pull_request: { url: 'url' },
              },
            ],
          }),
        }
      : gh(args);
  const { pulls: _, ...queryInput } = input;
  const result = await makeReviewAddressMany({
    gh: searchGh,
    address,
    isolate: async (root) => root,
  })({ ...queryInput, query: 'label:fix' });
  expect(result.status).toBe('ok');
  expect(address).toHaveBeenCalledTimes(1);
});

test('enrollment transport failure remains advisory on the attributed row', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const enqueue = vi.fn(async () => {
    throw new Error('transport unavailable');
  });
  const result = await makeReviewAddressMany({
    gh,
    address,
    enqueue,
    isolate: async (root) => root,
  })({
    ...input,
    pulls: [1],
    enrollments: [
      {
        number: 1,
        request: {
          requestId: 'm4-test',
          binding: {
            kind: 'deferred-author',
            repo: input.repo,
            head,
            producer: 'm4',
            target: 'main',
            targetSelector: 'promoted-main',
          },
        },
      },
    ],
  });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.rows[0]?.enrollment).toEqual({
      state: 'unavailable',
      reason: 'Error: transport unavailable',
    });
  expect(address).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test('temporary sibling reservations defer candidates until known usage releases allocation', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({ gh, address, isolate: async (root) => root })({
    ...input,
    pulls: [1, 2, 3, 4],
    concurrency: 3,
  });
  expect(address).toHaveBeenCalledTimes(4);
  expect(result.status).toBe('ok');
  if (result.status === 'ok') expect(result.value.accounting.observedTokens).toBe(40);
});

test('query walks every page before dispatching', async () => {
  const pages: number[] = [];
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const pagedGh = async (args: string[]) => {
    if (args.includes('search/issues')) {
      const page = Number(args.at(-1)!.split('=')[1]);
      pages.push(page);
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          total_count: 101,
          incomplete_results: false,
          items: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
            number: (page - 1) * 100 + i + 1,
            repository_url: 'https://api.github.com/repos/owner/repo',
            pull_request: { url: 'url' },
          })),
        }),
      };
    }
    if (args[0] === 'repo') return gh(args);
    const number = Number(args[1]!.split('/').at(-1));
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ ...metadata(number), state: number === 1 ? 'open' : 'closed' }),
    };
  };
  const { pulls: _, ...queryInput } = input;
  const result = await makeReviewAddressMany({
    gh: pagedGh,
    address,
    isolate: async (root) => root,
  })({ ...queryInput, query: 'label:fix' });
  expect(pages).toEqual([1, 2]);
  expect(result.status).toBe('ok');
  expect(address).toHaveBeenCalledTimes(1);
});
