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

test('a store-free lifetime supplies identity checks and tracks actual process close', async () => {
  class Lifetime extends lifecycle.AddressRunLifecycle {
    readonly commonDir = '/checkout';
    checks = 0;
    constructor() {
      super({});
      this.active = this.admitting = true;
    }
    async assertOwned() {
      await this.assertIdentity();
    }
    protected async assertIdentity() {
      this.checks++;
    }
    validate() {
      return this.validateTerminal();
    }
    track(promise: Promise<void>) {
      this.registerTerminalProcess(promise);
    }
    stop() {
      this.stopAdmissions();
    }
    get pending() {
      return this.tasks.size + this.terminalProcesses.size;
    }
  }
  const run = new Lifetime();
  let close!: () => void;
  run.track(
    new Promise<void>((done) => {
      close = done;
    }),
  );
  expect(run.pending).toBe(1);
  expect(await run.validate()).toEqual({ commonDir: '/checkout', terminal: false });
  run.stop();
  expect(run.pending).toBe(1);
  expect(await run.validate()).toEqual({ commonDir: '/checkout', terminal: true });
  expect(run.checks).toBe(2);
  close();
  await Promise.resolve();
  expect(run.pending).toBe(0);
});
