import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointAddressTerminalEvidence } from '../../../src/ops/review/internal/addressEvidence.js';
import { expect, test } from 'vitest';
import * as lifecycle from '../../../src/ops/review/internal/addressRunLifecycle.js';
import * as compatibility from '../../../src/ops/review/internal/addressOwnership.js';
import { fixture } from './addressManyWorktree.helpers.js';

test('compatibility exports share the private capability boundary', async () => {
  const entryPoints = [
    'validateAddressTerminalAuthority',
    'trackAddressTerminalProcess',
    'bindAddressTerminalReport',
    'addressTerminalWorkerBinding',
    'recordAddressTerminalAttempt',
    'releaseAddressTerminalAttempt',
    'deferAddressTerminalAttempt',
    'addressCancelledResult',
    'noteAddressOpaqueInvocation',
    'checkpointAddressTerminalWorker',
    'addressTerminalCandidate',
    'addressTerminalBookkeeping',
    'addressOrdinaryReport',
  ] as const;
  for (const name of entryPoints) expect(compatibility[name]).toBe(lifecycle[name]);
  for (const value of Object.values(lifecycle)) expect(value).not.toBeInstanceOf(WeakMap);
  for (const name of [
    'liveLeases',
    'terminalInternals',
    'terminalAuthorities',
    'terminalWorkers',
    'participantLeases',
  ])
    expect(lifecycle).not.toHaveProperty(name);
  await expect(lifecycle.validateAddressTerminalAuthority({})).rejects.toThrow('forged');
  const f = await fixture();
  try {
    const before = await readdir(join(f.repo.root, '.git'));
    await expect(checkpointAddressTerminalEvidence({}, f.repo.root)).rejects.toThrow('forged');
    expect(await readdir(join(f.repo.root, '.git'))).toEqual(before);
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
