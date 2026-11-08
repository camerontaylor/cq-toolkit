import { expect, test } from 'vitest';
import * as lifecycle from '../../../src/ops/review/internal/addressRunLifecycle.js';
import * as compatibility from '../../../src/ops/review/internal/addressOwnership.js';
import { fixture } from './addressManyWorktree.helpers.js';

test('compatibility exports share the private capability boundary', async () => {
  expect(compatibility.validateAddressTerminalAuthority).toBe(
    lifecycle.validateAddressTerminalAuthority,
  );
  expect(compatibility.addressTerminalWorkerBinding).toBe(lifecycle.addressTerminalWorkerBinding);
  const f = await fixture();
  try {
    await compatibility.withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async (lease) => {
        expect(() => lifecycle.addressTerminalWorkerBinding({ ...lease })).toThrow('forged');
        const binding = lifecycle.addressTerminalWorkerBinding(lease);
        expect(() => lifecycle.releaseAddressTerminalAttempt({ ...binding }, {})).toThrow('forged');
        await expect(lifecycle.validateAddressTerminalAuthority(binding)).rejects.toThrow('forged');
      },
    );
  } finally {
    await f.repo.cleanup();
  }
});
