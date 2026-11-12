// Issue 1185 — the analyze family's driver-constructing importers forward
// the host's run snapshot (wiring.cqEnv) into createDriverFactory, following
// the fix.run precedent (test/ops/fix/registry.test.ts). The snapshot governs
// the factory's session-logs read; absent wiring the factory keeps its
// ambient read (the library default), and the other factory options ride
// alongside unchanged.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import * as factory from '../../../src/driver/factory.js';
import { registry } from '../../../src/ops/analyze/registry.js';

/** Every analyze entry that constructs a driver factory in its importer. */
const DRIVER_ENTRIES = ['analyze.fix', 'analyze.agenticRemediation'] as const;

const entryOf = (name: (typeof DRIVER_ENTRIES)[number]) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`analyze family: no registry entry named ${name}`);
  return entry;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('analyze registry driver snapshot wiring (issue 1185)', () => {
  test('every driver-constructing entry forwards wiring.cqEnv into the factory config', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      for (const name of DRIVER_ENTRIES) {
        spy.mockClear();
        await entryOf(name).importer({ cqEnv });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toEqual({ cqEnv });
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('unwired importers keep the ambient read: no cqEnv key reaches the factory', async () => {
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      for (const name of DRIVER_ENTRIES) {
        spy.mockClear();
        await entryOf(name).importer();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toEqual({});
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('the snapshot rides alongside the other factory options, not over them', async () => {
    const notices: string[] = [];
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await entryOf('analyze.agenticRemediation').importer({
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

  test('the forwarded snapshot disagrees with ambient: the factory reads the snapshot, not the room', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    vi.stubEnv('CQ_SESSION_LOGS', 'on');
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      await entryOf('analyze.fix').importer({ cqEnv });
      const captured = spy.mock.calls[0]?.[0];
      if (captured?.cqEnv === undefined)
        throw new Error('analyze.fix importer dropped wiring.cqEnv');
      expect(captured.cqEnv).toBe(cqEnv);
      expect(captured.cqEnv.values['CQ_SESSION_LOGS']).toBe('off');
      expect(process.env['CQ_SESSION_LOGS']).toBe('on');
    } finally {
      spy.mockRestore();
    }
  });
});
