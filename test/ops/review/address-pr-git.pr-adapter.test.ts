// Split provenance: test/ops/review/address-pr-git.test.ts was split into this
// file, address-pr-git.rejectionCarry.test.ts and address-pr-git.helpers.ts.
// The single parametrised real-PR-adapter case body now lives in the helper;
// the mode table and the hoisted mocks stay here, verbatim.
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  runPrAdapterCase,
  setupReviewFixture,
  teardownReviewFixture,
  type PrAdapterMode,
  type Scanner,
} from './address-pr-git.helpers.js';

// Hold the real ledger writer at a deterministic shared-checkout rendezvous.
const ledgerRace = vi.hoisted(() => ({
  beforeDisposition: undefined as (() => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      ledgerRace.beforeRename?.(from, to);
      return fs.renameSync(from, to);
    },
  };
});
vi.mock('../../../src/ops/dev/disposition.js', async (original) => {
  const module = await original<typeof import('../../../src/ops/dev/disposition.js')>();
  return {
    ...module,
    makeDevDisposition: (...args: Parameters<typeof module.makeDevDisposition>) => {
      const op = module.makeDevDisposition(...args);
      return async (input: Parameters<typeof op>[0]) => {
        await ledgerRace.beforeDisposition?.();
        return op(input);
      };
    },
  };
});

const modes = [
  'local-only',
  'publish',
  'publish-reuse-alias',
  'publish-reuse-bulk',
  'publish-reuse-modified-ledger',
  'publish-reuse-modified-history',
  'publish-reuse-caller',
  'publish-reuse-unregistered',
  'publish-reuse-malformed',
  'publish-reuse-missing-receipt',
  'publish-reuse-corrupt-receipt',
  'publish-reuse-partial-receipt',
  'publish-reuse-wrong-branch',
  'publish-reuse-wrong-root',
  'publish-reuse-wrong-identity',
  'publish-reuse-stale-head',
  'publish-siblings',
  'publish-admission-transition',
  'publish-siblings-ledger-snapshot',
  'publish-rejection',
  'publish-rejection-refreshed',
  'caller-file',
  'caller-cq',
  'caller-ledger-temp',
  'caller-index',
  'bookkeeping-tamper',
  'bookkeeping-before-disposition',
] as const satisfies readonly PrAdapterMode[];

let scanner: Scanner;
beforeEach(async () => {
  scanner = await setupReviewFixture();
});
afterEach(async () => {
  await teardownReviewFixture(ledgerRace, scanner);
});

test.each(modes)(
  'real PR adapter without cq ignore preserves admission and publication hygiene: %s',
  (mode) => runPrAdapterCase(mode, ledgerRace, scanner),
);

test('consecutive same-head PR address runs authenticate real engine bookkeeping and leave reusable slots (mutation: check caller root or skip receipt import)', () =>
  runPrAdapterCase('publish-reuse', ledgerRace, scanner));

test('address recreates an externally removed completed checkout (mutation: eager binding capture)', () =>
  runPrAdapterCase('publish-reuse-removed', ledgerRace, scanner));
test('address reports a pure dirty refusal as needs-human and retries cleanly (mutation: skip refusal classification)', () =>
  runPrAdapterCase('publish-reuse-dirty', ledgerRace, scanner));
