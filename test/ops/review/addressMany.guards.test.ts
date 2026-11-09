// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.budget.test.ts,
// addressMany.query.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, head, input, metadata, report } from './addressMany.helpers.js';

test('base movement during clone refuses dispatch', async () => {
  let moved = false;
  const read = async (args: string[]) =>
    args[0] === 'repo'
      ? gh(args)
      : {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({ ...metadata(1), base: { ref: moved ? 'other' : 'release' } }),
        };
  const address = vi.fn();
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    gh: read,
    address,
    isolate: async (root) => {
      moved = true;
      return root;
    },
  })({ ...input, pulls: [1] });
  expect(result.status).toBe('needs-human');
  expect(result.report?.rows[0]?.result).toMatchObject({
    status: 'needs-human',
    reason: 'PR eligibility, head or base changed before dispatch',
  });
  expect(address).not.toHaveBeenCalled();
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
  // A leg refused before dispatch provably spent nothing: its BUDGET
  // settlement is measured zero, so the ledger stays clean and the aggregate
  // is needs-human, never a spurious budget-exhausted flip.
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

test('refuses prepared roots outside the PR selection before dispatch', async () => {
  const address = vi.fn();
  const isolate = vi.fn();
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate,
    gh,
    address,
  })({ ...input, dependencyRoots: { '123': '/prepared' } });
  expect(result.status).toBe('needs-human');
  if (result.status !== 'needs-human') throw new Error('expected needs-human');
  expect(result.reason).toBe('Prepared dependency root outside PR selection');
  expect(result.usageSummary).toEqual({ knownCount: 0, unknownCount: 0, unpricedCount: 0 });
  expect(address).not.toHaveBeenCalled();
  expect(isolate).not.toHaveBeenCalled();
});
