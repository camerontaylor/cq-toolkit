import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { defaultAcpEndpointTable, AcpEndpointTableSchema } from '../../src/driver/acp/binaries.js';
import { SESSIONS_DIR } from '../../src/driver/conformance.js';
import type { SpawnCall } from './acp.helpers.js';
import { recordingSpawn, driverOptions, invocation, withScratch } from './acp.helpers.js';

// ---------------------------------------------------------------------------
// 2. Driver-specific tests
// ---------------------------------------------------------------------------

describe('acp driver specifics (fake ACP server)', () => {
  test('child env is scrubbed by default and passes through only named values', async () => {
    await withScratch(async (scratchDir) => {
      const secretName = 'CQ_ACP_SECRET_CANARY';
      const passthroughName = 'ACP_PASSTHROUGH_CANARY';
      const oldSecret = process.env[secretName];
      const oldPassthrough = process.env[passthroughName];
      const oldConfigured = process.env.CQ_RUN_ENV_PASSTHROUGH;
      process.env[secretName] = 'must-not-reach-child';
      process.env[passthroughName] = 'named-passthrough';
      process.env.CQ_RUN_ENV_PASSTHROUGH = passthroughName;
      try {
        const calls: SpawnCall[] = [];
        const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
        await driver.run(invocation({ prompt: 'env canary' }));
        const env = calls[0]?.env ?? {};
        expect(env[secretName]).toBeUndefined();
        expect(env[passthroughName]).toBe('named-passthrough');
      } finally {
        if (oldSecret === undefined) delete process.env[secretName];
        else process.env[secretName] = oldSecret;
        if (oldPassthrough === undefined) delete process.env[passthroughName];
        else process.env[passthroughName] = oldPassthrough;
        if (oldConfigured === undefined) delete process.env.CQ_RUN_ENV_PASSTHROUGH;
        else process.env.CQ_RUN_ENV_PASSTHROUGH = oldConfigured;
      }
    });
  });

  test('absent binary: the pre-dispatch throw names the binary + install hint BEFORE any spawn (§3)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver({
        command: ['cq-acp-binary-definitely-absent'],
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(driver.run(invocation())).rejects.toThrow(
        /harness binary 'cq-acp-binary-definitely-absent' was not found .* install .* refusing pre-dispatch/,
      );
      // Pre-dispatch means PRE-dispatch: zero spawns — the sessions dir is
      // never even created (store.create would have mkdir'd it).
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  test('unknown endpoint + absent endpoint binary: loud registry throws (the default table untouched)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const table = AcpEndpointTableSchema.parse({
        endpoints: {
          ...defaultAcpEndpointTable().endpoints,
          'absent-harness': {
            command: ['cq-absent-harness-bin'],
            installHint: 'npm install -g some-absent-harness',
            notes: 'test endpoint: a registry name whose binary does not exist on this host',
          },
        },
      });
      const unknown = new AcpDriver({
        endpoint: 'nope',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(unknown.run(invocation())).rejects.toThrow(
        /unknown endpoint 'nope' .*zcode-acp-server, dsh-acp/,
      );
      const absent = new AcpDriver({
        endpoint: 'absent-harness',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(absent.run(invocation())).rejects.toThrow(
        /'cq-absent-harness-bin' was not found/,
      );
      await expect(absent.run(invocation())).rejects.toThrow(/npm install -g some-absent-harness/);
      expect(calls).toEqual([]);
    });
  });

  test('unknown sessionRef: the pre-dispatch throw, zero spawns (a fake resume is worse than a loud one)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, {}, calls));
      await expect(driver.run(invocation({ sessionRef: 'ses-never-created' }))).rejects.toThrow(
        /unknown sessionRef 'ses-never-created'/,
      );
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  test('envNames: a missing host env var throws pre-dispatch (names in config, never values)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, {}, calls),
        envNames: ['CQ_ACP_DEFINITELY_UNSET_VAR'],
      });
      await expect(driver.run(invocation())).rejects.toThrow(
        /envNames entry 'CQ_ACP_DEFINITELY_UNSET_VAR' is not set/,
      );
      expect(calls).toEqual([]);
    });
  });

  test.each(['CONTROL unchanged grants', 'TREATMENT mutated grants'])(
    'envNames constructor snapshot: %s retains grants while reading current values',
    async (leg) => {
      await withScratch(async (scratchDir) => {
        const allowed = 'CQ_ACP_SNAPSHOT_ALLOWED';
        const secret = 'CQ_ACP_SNAPSHOT_SECRET';
        const saved = new Map(
          [allowed, secret, 'CQ_RUN_ENV_PASSTHROUGH'].map((name) => [name, process.env[name]]),
        );
        try {
          delete process.env.CQ_RUN_ENV_PASSTHROUGH;
          process.env[allowed] = 'before-construction';
          process.env[secret] = 'withheld-test-canary';
          const grants = [allowed];
          const calls: SpawnCall[] = [];
          const driver = new AcpDriver({
            ...driverOptions(scratchDir, {}, calls),
            envNames: grants,
          });
          if (leg.startsWith('TREATMENT')) grants.splice(0, 1, secret);
          process.env[allowed] = 'rotated-after-construction';
          expect((await driver.run(invocation())).stopReason).toBe('complete');
          expect(calls).toHaveLength(1);
          expect(calls[0]?.env[allowed]).toBe('rotated-after-construction');
          expect(calls[0]?.env[secret]).toBeUndefined();
        } finally {
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      });
    },
  );
});
