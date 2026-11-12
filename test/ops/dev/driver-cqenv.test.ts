import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { runWithCqEnv } from '../../../src/config/run-env.js';
import { AiSdkDriver } from '../../../src/driver/ai-sdk/index.js';
import { SessionBoundError } from '../../../src/driver/errors.js';
import * as factory from '../../../src/driver/factory.js';
import * as cycleModule from '../../../src/ops/dev/cycle.js';
import * as managed from '../../../src/ops/dev/managedReview.js';
import * as queue from '../../../src/ops/review/internal/queueClient.js';
import { SessionStore } from '../../../src/harness/session.js';
import { registry } from '../../../src/ops/dev/registry.js';

const entryOf = (name: 'dev.review' | 'dev.cycle') => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`dev family: no registry entry named ${name}`);
  return entry;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('dev registry driver snapshot wiring (issue 1185)', () => {
  // The dev importers bind their factory per DISPATCH (inside the returned
  // op), not at importer time — so each probe awaits the importer AND calls
  // the op with a dummy non-admission input. Every construction on that path
  // is inert (closure-only effects, catching file reads, scanner
  // constructors); the dummy then fails input-schema validation without
  // spawning anything, after the factory line has run.
  const dispatch = async (
    name: 'dev.review' | 'dev.cycle',
    wiring?: Parameters<ReturnType<typeof entryOf>['importer']>[0],
  ) => {
    const op = (await entryOf(name).importer(wiring)) as unknown as (
      input: unknown,
    ) => Promise<unknown>;
    await op({ action: 'cycle' });
  };

  test('dev.review forwards wiring.cqEnv into the cycle factory config', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await dispatch('dev.review', { cqEnv });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual({ cqEnv });
    } finally {
      spy.mockRestore();
    }
  });

  test.each(['explicit', 'missing', 'run', 'ambient'] as const)(
    'dev.review managed alias respects the %s snapshot at transport resolution',
    async (source) => {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'ambient-at-construction');
      const configured = vi.spyOn(managed, 'makeManagedReviewSubmit');
      const transport = async () => 'offline fixture';
      const ssh = vi.spyOn(queue, 'sshQueueTransport').mockReturnValue(transport);
      const wiring =
        source === 'explicit' || source === 'missing'
          ? {
              cqEnv: readCqEnv(
                source === 'explicit' ? { CQ_QUEUE_SSH_ALIAS: 'explicit-snapshot' } : {},
              ),
            }
          : undefined;
      await dispatch('dev.review', wiring);
      expect(ssh).not.toHaveBeenCalled();
      expect(configured).toHaveBeenCalledOnce();
      const resolveTransport = configured.mock.calls[0]?.[0];
      if (resolveTransport === undefined) throw new Error('managed transport binding missing');
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'ambient-at-submit');
      const runEnv = readCqEnv({ CQ_QUEUE_SSH_ALIAS: 'run-snapshot' });
      if (source === 'missing') {
        expect(() => runWithCqEnv(runEnv, resolveTransport)).toThrow(
          'Configure CQ_QUEUE_SSH_ALIAS for review-v1',
        );
        expect(ssh).not.toHaveBeenCalled();
      } else {
        expect(source === 'run' ? runWithCqEnv(runEnv, resolveTransport) : resolveTransport()).toBe(
          transport,
        );
        expect(ssh).toHaveBeenCalledExactlyOnceWith(
          source === 'explicit'
            ? 'explicit-snapshot'
            : source === 'run'
              ? 'run-snapshot'
              : 'ambient-at-submit',
          'review-v1',
        );
      }
    },
  );

  test('dev.cycle binds its default factory to the supplied wiring snapshot', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await dispatch('dev.cycle', { cqEnv });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual({ cqEnv });
    } finally {
      spy.mockRestore();
    }
  });

  test('unwired dev.review keeps the ambient read: no cqEnv key reaches the factory', async () => {
    // dev.review binds its factory before any input validation, so the dummy
    // dispatch reaches the factory line; dev.cycle builds its default inside
    // the guarded op body, so its unwired case is pinned via the deps object
    // below instead.
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await dispatch('dev.review');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  test('dev.cycle binds no drivers key without wiring and a wired factory with it', async () => {
    const seen: unknown[] = [];
    vi.spyOn(cycleModule, 'makeDevCycle').mockImplementation(((deps: unknown) => {
      seen.push(deps);
      return async () => ({ status: 'failed' as const, error: 'stubbed cycle' });
    }) as typeof cycleModule.makeDevCycle);
    try {
      await dispatch('dev.cycle');
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty('drivers');
      seen.length = 0;
      const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
      await dispatch('dev.cycle', { cqEnv });
      expect(seen).toHaveLength(1);
      expect((seen[0] as { drivers?: unknown }).drivers).toBeDefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('the dev.review snapshot governs the session-logs read against hostile ambient', async () => {
    // Hostile ambient: preservation ON. The snapshot says OFF — the factory
    // built from the importer's captured config must reap anyway.
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    vi.stubEnv('CQ_SESSION_LOGS', 'on');
    const spy = vi.spyOn(factory, 'createDriverFactory');
    await dispatch('dev.review', { cqEnv });
    const captured = spy.mock.calls[0]?.[0];
    if (captured?.cqEnv === undefined) throw new Error('dev.review importer dropped wiring.cqEnv');
    expect(captured.cqEnv).toBe(cqEnv);
    expect(captured.cqEnv.values['CQ_SESSION_LOGS']).toBe('off');
    expect(process.env['CQ_SESSION_LOGS']).toBe('on');
    // Drive the REAL factory from the captured config: a snapshot-off resolve
    // reaps the session record even while ambient says on.
    const remove = vi.spyOn(SessionStore.prototype, 'remove').mockResolvedValue(undefined);
    vi.spyOn(AiSdkDriver.prototype, 'run').mockRejectedValue(new SessionBoundError('stop', 's'));
    const drivers = factory.createDriverFactory(captured);
    const request = { role: 'fixer', modelSpec: { provider: 'openai', model: 'm' } };
    const invocation = {
      prompt: 'test',
      modelSpec: request.modelSpec,
      toolPolicy: { allow: [], mode: 'none' as const },
      sandboxPolicy: { level: 'none' as const },
      budget: {},
    };
    await expect(drivers.resolve(request).driver.run(invocation)).rejects.toThrow('stop');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('the dev.cycle snapshot governs the default factory against hostile ambient', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    vi.stubEnv('CQ_SESSION_LOGS', 'on');
    const spy = vi.spyOn(factory, 'createDriverFactory');
    await dispatch('dev.cycle', { cqEnv });
    const captured = spy.mock.calls[0]?.[0];
    if (captured?.cqEnv === undefined) throw new Error('dev.cycle importer dropped wiring.cqEnv');
    expect(captured.cqEnv).toBe(cqEnv);
    expect(process.env['CQ_SESSION_LOGS']).toBe('on');
    const remove = vi.spyOn(SessionStore.prototype, 'remove').mockResolvedValue(undefined);
    vi.spyOn(AiSdkDriver.prototype, 'run').mockRejectedValue(new SessionBoundError('stop', 's'));
    const drivers = factory.createDriverFactory(captured);
    const request = { role: 'fixer', modelSpec: { provider: 'openai', model: 'm' } };
    const invocation = {
      prompt: 'test',
      modelSpec: request.modelSpec,
      toolPolicy: { allow: [], mode: 'none' as const },
      sandboxPolicy: { level: 'none' as const },
      budget: {},
    };
    await expect(drivers.resolve(request).driver.run(invocation)).rejects.toThrow('stop');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('the snapshot rides alongside the deprecated-alias sink, not over it', async () => {
    const notices: string[] = [];
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await dispatch('dev.review', {
        cqEnv,
        onDeprecatedAlias: (message: string) => {
          notices.push(message);
        },
      });
      const config = spy.mock.calls[0]?.[0];
      expect(config?.cqEnv).toBe(cqEnv);
      expect(typeof config?.onDeprecatedAlias).toBe('function');
      expect(notices).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
