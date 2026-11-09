// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the reap-on-settle retention and cleanup-failure subject. The
// suite-wide header and shared fixtures live in ./factory.helpers.ts.
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory, withReapOnSettle } from '../../src/driver/factory.js';
import type { Driver } from '../../src/driver/types.js';
import { SessionStore } from '../../src/harness/session.js';
import * as harnessSurface from '../../src/harness/surface.js';
import { invocation, scratch, stubKey, subprocessConfig, temporary } from './factory.helpers.js';

describe('driver factory — wrapping', () => {
  test.each([
    ['keep', false, 1],
    ['reap-on-settle', false, 0],
    ['reap-on-settle', true, 1],
  ] as const)(
    '%s (resumed=%s) leaves %i record(s) after a pre-dispatch rejection',
    async (retention, resume, count) => {
      stubKey();
      const dir = await scratch();
      const store = new SessionStore(join(dir, 'sessions'));
      const prior = resume ? await store.create(await mkdtemp(join(dir, 'ws-'))) : undefined;
      vi.spyOn(harnessSurface, 'buildManifest').mockRejectedValue(
        new DispatchError('config', 'manifest setup failed'),
      );
      const driver = createDriverFactory(subprocessConfig(dir, [])).resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: retention,
      }).driver;
      const error = await driver
        .run({
          ...invocation(),
          ...(prior !== undefined ? { sessionRef: prior.sessionId } : {}),
        })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('manifest setup failed');
      expect(errorClassOf(error)).toBe('config');
      expect(
        (await readdir(join(dir, 'sessions'))).filter((name) => name.endsWith('.jsonl')),
      ).toHaveLength(count);
    },
  );

  test('reap-on-settle deletes the FRESH record after a completed run', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      sessionRetention: 'reap-on-settle',
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    expect(verdict.sessionId).toBeUndefined();
    expect(
      (await readdir(join(dir, 'sessions'))).filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(0);
  });

  test('reap-on-settle deletes the fresh record on an ERROR verdict too', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, ['FAKE_AGENT_MODE=error-result']));
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      sessionRetention: 'reap-on-settle',
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.sessionId).toBeUndefined();
    expect(
      (await readdir(join(dir, 'sessions'))).filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(0);
  });

  test.each([false, true])(
    'cleanup failure preserves the resolved link or original rejection (reject=%s)',
    async (reject) => {
      stubKey();
      const dir = await scratch();
      const remove = vi
        .spyOn(SessionStore.prototype, 'remove')
        .mockRejectedValue(new Error('cleanup unavailable'));
      if (reject) {
        vi.spyOn(harnessSurface, 'buildManifest').mockRejectedValue(
          new DispatchError('config', 'manifest setup failed'),
        );
      }
      const driver = createDriverFactory(subprocessConfig(dir, [])).resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: 'reap-on-settle',
      }).driver;
      const running = driver.run(invocation());
      if (reject) {
        await expect(running).rejects.toMatchObject({
          message: 'manifest setup failed',
          dispatchClass: 'config',
        });
      } else {
        const result = await running;
        expect(result.stopReason).toBe('complete');
        expect(result.sessionId).toBeDefined();
        await expect(
          new SessionStore(join(dir, 'sessions')).load(result.sessionId as string),
        ).resolves.toBeDefined();
        expect(remove).toHaveBeenCalledWith(result.sessionId);
      }
      expect(remove).toHaveBeenCalledTimes(1);
      expect(
        (await readdir(join(dir, 'sessions'))).filter((name) => name.endsWith('.jsonl')),
      ).toHaveLength(1);
    },
  );

  test('a foreign throw carrying a sessionId is NOT ownership: an existing session survives', async () => {
    const dir = await scratch();
    const sessionsDir = join(dir, 'sessions');
    const store = new SessionStore(sessionsDir);
    const workspace = await mkdtemp(join(dir, 'ws-'));
    temporary.push(workspace);
    // A record that predates the run — NOT this run's handle.
    const existing = await store.create(workspace);
    // An injected provider (or any hostile object) throws a plausible-looking
    // rejection BEFORE any record exists. A shape probe on `sessionId` would
    // reap the pre-existing record; ownership evidence is required instead.
    const hostile: Driver = {
      async run() {
        throw Object.assign(new Error('provider blew up'), { sessionId: existing.sessionId });
      },
    };
    const error = await withReapOnSettle(hostile, sessionsDir)
      .run(invocation())
      .catch((err: unknown) => err);
    expect((error as Error).message).toBe('provider blew up');
    await expect(store.load(existing.sessionId)).resolves.toBeDefined();
    expect((await readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
  });

  test('a sessionRef-resumed record is NEVER reaped', async () => {
    stubKey();
    const dir = await scratch();
    const sessionsDir = join(dir, 'sessions');
    const store = new SessionStore(sessionsDir);
    const workspace = await mkdtemp(join(dir, 'ws-'));
    temporary.push(workspace);
    const resumed = await store.create(workspace);
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: 'reap-on-settle',
      })
      .driver.run({ ...invocation(), sessionRef: resumed.sessionId });
    expect(verdict.stopReason).toBe('complete');
    expect(verdict.sessionId).toBe(resumed.sessionId); // the resumed record, not a fresh one
    await expect(store.load(resumed.sessionId)).resolves.toBeDefined();
  });

  test("the default retention is 'keep': the fresh record survives", async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    const store = new SessionStore(join(dir, 'sessions'));
    const record = await store.load(verdict.sessionId as string);
    expect(record).toBeDefined();
  });

  test('reap-on-settle is RUN-SPECIFIC: a concurrent run sharing the sessionsDir never gets its record reaped', async () => {
    stubKey();
    const dir = await scratch();
    const sessionsDir = join(dir, 'sessions');
    const store = new SessionStore(sessionsDir);
    const workspace = await mkdtemp(join(dir, 'ws-'));
    temporary.push(workspace);
    // The CONCURRENT run's record: created while the wrapped run is in
    // flight (after its dispatch, before its settle). The wrapped run's
    // reap is keyed on its OWN verdict sessionId — a directory-wide
    // "created since we started" delta would delete this record (PR #238
    // review round 5).
    const concurrent = await store.create(workspace);
    const resolved = createDriverFactory(subprocessConfig(dir, [])).resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      sessionRetention: 'reap-on-settle',
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    expect(verdict.sessionId).not.toBe(concurrent.sessionId);
    // The wrapped run's fresh record is reaped...
    expect(verdict.sessionId).toBeUndefined();
    // ...and the concurrent run's record is UNTOUCHED.
    await expect(store.load(concurrent.sessionId)).resolves.toBeDefined();
  });
});
