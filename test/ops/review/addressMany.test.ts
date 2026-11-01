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
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
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
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.rows).toHaveLength(2);
  expect(address).toHaveBeenCalledTimes(2);
});

test('unknown usage stops admission and retains held allocation', async () => {
  const address = vi.fn(async () => {
    throw new Error('worker lost');
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
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
    coordinationRoot: '/unused-test-coordination',
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
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh: otherGh,
    address,
  })(input);
  expect(result.status).toBe('needs-human');
  expect(address).not.toHaveBeenCalled();
});

test('oversized reservation never dispatches either PR', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })({
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
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
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
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (root) => root,
  })({
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
    const result = await makeReviewAddressMany({
      coordinationRoot: '/unused-test-coordination',
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
    coordinationRoot: '/unused-test-coordination',
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
    coordinationRoot: '/unused-test-coordination',
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
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (root) => root,
  })({
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
    coordinationRoot: '/unused-test-coordination',
    gh: pagedGh,
    address,
    isolate: async (root) => root,
  })({ ...queryInput, query: 'label:fix' });
  expect(pages).toEqual([1, 2]);
  expect(result.status).toBe('ok');
  expect(address).toHaveBeenCalledTimes(1);
});

const enrollmentRequest = {
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
test('duplicate and out-of-selection enrollments are refused', async () => {
  expect(
    ReviewAddressManyInputSchema.safeParse({
      ...input,
      enrollments: [1, 1].map((number) => ({ number, request: enrollmentRequest })),
    }).success,
  ).toBe(false);
  expect(
    ReviewAddressManyInputSchema.safeParse({
      ...input,
      enrollments: [{ number: 3, request: enrollmentRequest }],
    }).success,
  ).toBe(false);
});

test('budget refusal retains the advisory request', async () => {
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address: vi.fn(),
  })({ ...input, maxTokens: 1, enrollments: [{ number: 1, request: enrollmentRequest }] });
  expect(result.report?.rows[0]?.enrollment.state).toBe('unavailable');
});

test.each(['cap', 'changing-total', 'foreign', 'duplicate', 'exit', 'facts'])(
  'discovery refuses %s before dispatch',
  async (mode) => {
    const address = vi.fn();
    let page = 0;
    const queryGh = async (args: string[]) => {
      if (args[0] === 'repo') return gh(args);
      if (!args.includes('search/issues'))
        return { code: 1, stderr: 'facts unavailable', stdout: '' };
      page++;
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
        code: mode === 'exit' ? 1 : 0,
        stderr: '',
        stdout: JSON.stringify({
          total_count: total,
          incomplete_results: false,
          items: Array.from({ length: count }, (_, i) => ({
            number: mode === 'duplicate' && page === 2 ? 1 : (page - 1) * 100 + i + 1,
            repository_url: `https://api.github.com/repos/${mode === 'foreign' ? 'other/repo' : input.repo}`,
            pull_request: { url: 'url' },
          })),
        }),
      };
    };
    const { pulls: _, ...rest } = input;
    const result = await makeReviewAddressMany({
      coordinationRoot: '/unused-test-coordination',
      gh: queryGh,
      address,
    })({ ...rest, query: 'is:open' });
    expect(result.status).toBe('needs-human');
    expect(address).not.toHaveBeenCalled();
  },
);

test('facts reads are bounded', async () => {
  let active = 0;
  let peak = 0;
  const boundedGh = async (args: string[]) => {
    if (args[0] === 'repo') return gh(args);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await gh(args);
    active--;
    return result;
  };
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh: boundedGh,
    address,
    isolate: async (root) => root,
  })({ ...input, pulls: Array.from({ length: 20 }, (_, i) => i + 1), maxTokens: 1000 });
  expect(peak).toBeLessThanOrEqual(8);
  expect(address).toHaveBeenCalledTimes(20);
});

test('head movement during clone is refused after isolation', async () => {
  let moved = false;
  const changingGh = async (args: string[]) => {
    const result = await gh(args);
    if (args[0] !== 'repo' && moved)
      result.stdout = JSON.stringify({
        ...metadata(1),
        head: { ...metadata(1).head, sha: 'b'.repeat(40) },
      });
    return result;
  };
  const address = vi.fn();
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh: changingGh,
    address,
    isolate: async (root) => {
      moved = true;
      return root;
    },
  })({ ...input, pulls: [1] });
  expect(result.status).toBe('needs-human');
  expect(address).not.toHaveBeenCalled();
});

test('refused usage settlement retains sibling reports and names the accounting fault', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, concurrency: 2 });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.rows).toHaveLength(2);
  expect(result.report?.reasons.join(';')).toContain('settlement refused');
});

test('a throwing settlement waits for siblings and preserves their individual results', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, concurrency: 2 });
  expect(result.report?.rows).toHaveLength(2);
  expect(result.report?.rows.every((row) => row.result?.status === 'ok')).toBe(true);
  expect(result.report?.reasons.join(';')).toContain('Worker rejected');
});

test('an ineligible enrolled PR remains advisory while eligible siblings dispatch', async () => {
  const metadataGh = async (args: string[]) => {
    if (args[0] === 'repo') return gh(args);
    const number = Number(args[1]!.split('/').at(-1));
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ ...metadata(number), draft: number === 1 }),
    };
  };
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh: metadataGh,
    address,
    isolate: async (root) => root,
  })({ ...input, enrollments: [{ number: 1, request: enrollmentRequest }] });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.excluded?.[0]?.enrollment.state).toBe('unavailable');
  expect(address).toHaveBeenCalledTimes(1);
});

test('skipped rows name the real worker rejection and held allocation', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, pulls: [1, 2, 3], concurrency: 2 });
  expect(result.report?.rows).toHaveLength(3);
  // The sticky overrun is an explicit budget refusal, not a generic missing worker result.
  expect(result.report?.rows[2]?.reason).toBe('budget');
  expect(result.report?.rows[2]?.detail).toContain('Worker rejected');
  expect(result.report?.reasons.join(';')).toContain('Worker rejected');
});

test('aggregate reports the preserved isolation path for each leg', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh,
    address,
    isolate: async (_root, number) => `/isolated/pr-${number}`,
  })({ ...input });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.preservedClones).toEqual([
      { number: 1, path: '/isolated/pr-1' },
      { number: 2, path: '/isolated/pr-2' },
    ]);
});

test('bulk caller forwards only the selected PR prepared dependency root', async () => {
  const address = vi.fn(async (_input: unknown) => ({ status: 'ok' as const, value: report() }));
  await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async () => '/isolated',
    gh,
    address,
  })({ ...input, dependencyRoots: { '1': 'prepared/old-pr' } });
  expect(address.mock.calls[0]![0]).toMatchObject({
    repoRoot: '/isolated',
    dependencyRoot: '/repo/prepared/old-pr',
  });
  expect(address.mock.calls[1]![0]).not.toHaveProperty('dependencyRoot');
  expect(
    ReviewAddressManyInputSchema.safeParse({ ...input, dependencyRoots: { bad: '/path' } }).success,
  ).toBe(false);
});

test('refuses prepared roots outside the PR selection before dispatch', async () => {
  const address = vi.fn();
  const isolate = vi.fn();
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate,
    gh,
    address,
  })({ ...input, dependencyRoots: { '123': '/prepared' } });
  expect(result).toEqual({
    status: 'needs-human',
    reason: 'Prepared dependency root outside PR selection',
  });
  expect(address).not.toHaveBeenCalled();
  expect(isolate).not.toHaveBeenCalled();
});
