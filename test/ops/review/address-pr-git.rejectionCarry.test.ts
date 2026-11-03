// Split provenance: test/ops/review/address-pr-git.test.ts was split into
// address-pr-git.pr-adapter.test.ts, this file and address-pr-git.helpers.ts.
// The persisted-rejection-carry case body now lives in the helper; the mode
// table and the hoisted mocks stay here, verbatim, so this file runs under the
// same mocked module graph as before.
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  runPersistedRejectionCase,
  setupReviewFixture,
  teardownReviewFixture,
  type RejectionMode,
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
  'proven',
  'missing-record',
  'record-other-head',
  'wrong-author',
  'missing-reply',
  'legacy',
  'stale-round',
  'resolve-intent',
] as const satisfies readonly RejectionMode[];

let scanner: Scanner;
beforeEach(async () => {
  scanner = await setupReviewFixture();
});
afterEach(async () => {
  await teardownReviewFixture(ledgerRace, scanner);
});

test.each(modes)(
  'real persisted rejection carry requires current authenticated proof: %s',
  (mode) => runPersistedRejectionCase(mode),
);
