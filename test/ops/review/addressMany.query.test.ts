import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, input, metadata, report } from './addressMany.helpers.js';

test.each([true, false])(
  'query enumeration refuses incomplete=%s without dispatch',
  async (incomplete) => {
    const address = vi.fn();
    const searchGh = async (args: string[]) =>
      args.includes('search/issues')
        ? {
            code: 0,
            stderr: '',
            stdout: JSON.stringify([
              {
                total_count: 101,
                incomplete_results: incomplete,
                items: [
                  {
                    number: 1,
                    repository_url: 'https://api.github.com/repos/owner/repo',
                    pull_request: { url: 'url' },
                  },
                ],
              },
            ]),
          }
        : gh(args);
    const { pulls: _, ...queryInput } = input;
    const result = await makeReviewAddressMany({
      coordinationRoot: coordinationRoot(),
      gh: searchGh,
      address,
    })({
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
          stdout: JSON.stringify([
            {
              total_count: 1,
              incomplete_results: false,
              items: [
                {
                  number: 1,
                  repository_url: 'https://api.github.com/repos/owner/repo',
                  pull_request: { url: 'url' },
                },
              ],
            },
          ]),
        }
      : gh(args);
  const { pulls: _, ...queryInput } = input;
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh: searchGh,
    address,
    isolate: async (root) => root,
  })({ ...queryInput, query: 'label:fix' });
  expect(result.status).toBe('ok');
  expect(address).toHaveBeenCalledTimes(1);
});

test('query requests every page through one paginate+slurp call before dispatching', async () => {
  const searches: string[][] = [];
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const pagedGh = async (args: string[]) => {
    if (args.includes('search/issues')) {
      searches.push(args);
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify(
          [1, 2].map((page) => ({
            total_count: 101,
            incomplete_results: false,
            items: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
              number: (page - 1) * 100 + i + 1,
              repository_url: 'https://api.github.com/repos/owner/repo',
              pull_request: { url: 'url' },
            })),
          })),
        ),
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
    coordinationRoot: coordinationRoot(),
    gh: pagedGh,
    address,
    isolate: async (root) => root,
  })({ ...queryInput, query: 'label:fix' });
  expect(searches).toHaveLength(1);
  expect(searches[0]).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  expect(searches[0]).not.toContain('page=1');
  expect(result.status).toBe('ok');
  expect(address).toHaveBeenCalledTimes(1);
});

test.each(['cap', 'changing-total', 'foreign', 'duplicate', 'exit', 'facts'])(
  'discovery refuses %s before dispatch',
  async (mode) => {
    const address = vi.fn();
    const queryGh = async (args: string[]) => {
      if (args[0] === 'repo') return gh(args);
      if (!args.includes('search/issues'))
        return { code: 1, stderr: 'facts unavailable', stdout: '' };
      const pages = [1, 2].map((page) => {
        const total =
          mode === 'cap'
            ? 1001
            : mode === 'facts'
              ? 1
              : mode === 'changing-total' && page === 2
                ? 102
                : 101;
        const count = mode === 'facts' || page === 2 ? 1 : 100;
        return {
          total_count: total,
          incomplete_results: false,
          items: Array.from({ length: count }, (_, i) => ({
            number: mode === 'duplicate' && page === 2 ? 1 : (page - 1) * 100 + i + 1,
            repository_url: `https://api.github.com/repos/${mode === 'foreign' ? 'other/repo' : input.repo}`,
            pull_request: { url: 'url' },
          })),
        };
      });
      return {
        code: mode === 'exit' ? 1 : 0,
        stderr: '',
        stdout: JSON.stringify(mode === 'facts' ? pages.slice(0, 1) : pages),
      };
    };
    const { pulls: _, ...rest } = input;
    const result = await makeReviewAddressMany({
      coordinationRoot: coordinationRoot(),
      gh: queryGh,
      address,
    })({ ...rest, query: 'is:open' });
    expect(result.status).toBe('needs-human');
    expect(address).not.toHaveBeenCalled();
  },
);
