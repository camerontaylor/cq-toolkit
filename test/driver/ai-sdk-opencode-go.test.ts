// The `opencode-go` provider handle (dev-strategy §8 item 7) — the
// OpenCode Go subscription wire on the ai-sdk lane.
//
// Pins, all OFFLINE (no network, no credential):
//   - BOTH env reads are pre-dispatch and required: OPENCODE_GO_API_KEY and
//     OPENCODE_GO_BASE_URL. There is deliberately NO built-in default
//     route — the model AND the route are configuration (owner ruling
//     2026-10-16), so a missing URL is the same loud config error as a
//     missing key.
//   - The factory receives exactly the configured credential + route and
//     the EXACT ModelSpec.model id — `.chat(modelId)`, chat completions
//     only, no id rewriting (the wire echoes requested ids; RS-14).
//   - The abort-during-resolution leg doubles as the no-dispatch proof:
//     the driver's LATE governed-cancellation recheck settles 'aborted'
//     before any session state exists, so the mock never reaches a wire.
//   - The served-model alias row for this handle is CONFIG-OWNED data,
//     keyed `aliases['ai-sdk']['opencode-go']`, and provider-scoped: a row
//     declared for this handle never admits another provider's mismatch.
import { describe, expect, test, vi } from 'vitest';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { servedModelCheck } from '../../src/driver/served-model.js';
import type { ServedModelPolicy } from '../../src/driver/served-model.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';

const handle = vi.hoisted(() => ({
  controller: new AbortController(),
  factoryCalls: [] as Array<{ apiKey: string; baseURL: string }>,
  chatModelIds: [] as string[],
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (settings: { apiKey: string; baseURL: string }) => {
    handle.factoryCalls.push(settings);
    // Abort DURING provider resolution: the driver's late governed-
    // cancellation recheck then returns before any session store, so this
    // suite proves the factory wiring with zero wire traffic.
    handle.controller.abort();
    return {
      chat: (modelId: string) => {
        handle.chatModelIds.push(modelId);
        // Never used — the run settles 'aborted' right after resolution.
        return { mockOnly: true };
      },
    };
  },
}));

const invocation = (model: string): OpInvocation => ({
  prompt: 'opencode-go handle test',
  modelSpec: { provider: 'opencode-go', model },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
});

/** Save/delete the handle's env names; the caller restores in finally. */
const takeEnv = (): Map<string, string | undefined> => {
  const names = ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  return saved;
};

const restoreEnv = (saved: Map<string, string | undefined>): void => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

describe('the opencode-go provider handle (default registry)', () => {
  test('missing OPENCODE_GO_API_KEY throws config before dispatch', async () => {
    const saved = takeEnv();
    try {
      const driver = new AiSdkDriver();
      const err = await driver.run(invocation('probe-model')).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).message).toContain(
        "provider 'opencode-go' requires OPENCODE_GO_API_KEY",
      );
      expect(errorClassOf(err)).toBe('config');
      expect(handle.factoryCalls).toEqual([]);
    } finally {
      restoreEnv(saved);
    }
  });

  test('missing OPENCODE_GO_BASE_URL throws the same config error — no default route exists', async () => {
    const saved = takeEnv();
    try {
      process.env.OPENCODE_GO_API_KEY = 'offline-handle-key';
      const driver = new AiSdkDriver();
      const err = await driver.run(invocation('probe-model')).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).message).toContain(
        "provider 'opencode-go' requires OPENCODE_GO_BASE_URL",
      );
      expect(errorClassOf(err)).toBe('config');
      expect(handle.factoryCalls).toEqual([]);
    } finally {
      restoreEnv(saved);
    }
  });

  test('the factory rides the configured key+route verbatim and requests the exact model id', async () => {
    const saved = takeEnv();
    handle.factoryCalls.length = 0;
    handle.chatModelIds.length = 0;
    handle.controller = new AbortController();
    try {
      process.env.OPENCODE_GO_API_KEY = 'offline-handle-key';
      process.env.OPENCODE_GO_BASE_URL = 'https://go-wire.invalid/v1';
      const driver = new AiSdkDriver();
      const result: WorkerResult = await driver.run(invocation('config-owned-model-id'), {
        signal: handle.controller.signal,
      });
      // The configured route + credential reached the OpenAI factory
      // UNCHANGED (no default route, no rewriting), and the requested id is
      // exactly ModelSpec.model — the chat-completions handle aliases
      // nothing.
      expect(handle.factoryCalls).toEqual([
        { apiKey: 'offline-handle-key', baseURL: 'https://go-wire.invalid/v1' },
      ]);
      expect(handle.chatModelIds).toEqual(['config-owned-model-id']);
      // The abort fired inside the mock, so the LATE governed-cancellation
      // recheck settled the run before any session state: zero usage, no
      // session, no dispatch.
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.sessionId).toBeUndefined();
    } finally {
      restoreEnv(saved);
    }
  });
});

describe('the opencode-go served-model alias row (config-owned)', () => {
  // The deployment's row lives HERE — lane 'ai-sdk', provider
  // 'opencode-go' — never as a built-in (ADR-0002 §2.6 keeps the built-in
  // layer empty pending O-2; the Go wire echoes requested ids per RS-14, so
  // a row only exists where a deployment OBSERVED a remap). Ids below are
  // synthetic test data, not a selected model.
  const policy: ServedModelPolicy = {
    aliases: { 'ai-sdk': { 'opencode-go': { 'requested-a': ['echoed-b'] } } },
  };

  test("a declared echoed id passes via 'alias' on the ai-sdk lane", () => {
    const check = servedModelCheck(
      invocation('requested-a'),
      { ...completeResult(), model: 'echoed-b' },
      { lane: 'ai-sdk', policy },
    );
    expect(check).toEqual({ pass: true, via: 'alias' });
  });

  test('an undeclared served id fails closed, and the row never admits another provider', () => {
    expect(
      servedModelCheck(
        invocation('requested-a'),
        { ...completeResult(), model: 'undeclared-c' },
        { lane: 'ai-sdk', policy },
      ),
    ).toEqual({ pass: false, reason: "requested 'requested-a', served 'undeclared-c'" });
    // Provider-scoped: the SAME pair under another handle is still a
    // mismatch — an opencode-go row cannot whitelist zai's wire.
    expect(
      servedModelCheck(
        { ...invocation('requested-a'), modelSpec: { provider: 'zai', model: 'requested-a' } },
        { ...completeResult(), model: 'echoed-b' },
        { lane: 'ai-sdk', policy },
      ),
    ).toEqual({ pass: false, reason: "requested 'requested-a', served 'echoed-b'" });
  });
});

function completeResult(): WorkerResult {
  return {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
    stopReason: 'complete',
  };
}
