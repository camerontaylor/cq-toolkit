// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the ONE systematic entry-guard suite (owner 15:30) over the
// unsupported lanes plus the ai-sdk provider-factory and default-registry legs.
// Shared fixtures live in ./strict-token-budget-guard.helpers.ts.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { ClaudeCodeDriver } from '../../src/driver/claude-code/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import type { DriverFactoryConfig } from '../../src/driver/factory.js';
import type { Driver, ModelSpec, OpInvocation } from '../../src/driver/types.js';
import { invocation, scratch } from './strict-token-budget-guard.helpers.js';

// ---------------------------------------------------------------------------
// 6. ONE systematic entry-guard SUITE (owner 15:30): a 3-lane table for the
//    UNSUPPORTED lanes (subprocess / claude-agent / acp) x (direct + factory)
//    x (strict-capability refusal + pre-abort), PLUS explicit ai-sdk cases
//    (injected mock provider factory: direct + factory; the DEFAULT registry:
//    an honest key-guard pair) — not ai-sdk table rows. Every strict/pre-abort
//    leg uses a REAL recording setup seam or inner-lane prototype.run spy
//    proving ZERO setup side effect, asserts the SPECIFIC guard/capability
//    message, and pins no session store. Nonstrict controls pin each lane's own
//    setup fault/reach. Every leg pins ANTHROPIC_API_KEY to the empty string,
//    so a reached credential/env setup would surface its own key error rather
//    than the refusal phrase.
// ---------------------------------------------------------------------------

describe('entry guards precede every lane setup side effect (systematic suite)', () => {
  const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const STRICT_BUDGET: OpInvocation['budget'] = {
    strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 },
  };
  const GUARD_PHRASE = 'does not enforce a pre-request token ceiling';
  const CAPABILITY_PHRASE = 'no trusted token capability';

  /** A spy handle: only the call count is read (real spy, never vacuous). */
  type RunSpy = { mock: { calls: ReadonlyArray<unknown> } };

  interface SweepRow {
    readonly name: string;
    /** The distinctive refusal text this row MUST produce. */
    readonly refusalPhrase: string;
    /** A lane id the refusal text must also name. */
    readonly refusalLane: string;
    /** Direct driver whose setup seam RECORDS into `reached` then throws. */
    readonly direct: (reached: () => void, sessionsDir: string) => Driver;
    readonly directModelSpec: ModelSpec;
    readonly factoryModelSpec: ModelSpec;
    /** Role 'fixer' / provider 'probe' binding for THIS lane. */
    readonly bindings: NonNullable<DriverFactoryConfig['bindings']>;
    /**
     * Install a real spy on the inner lane's prototype.run. The factory's
     * outermost guard must invoke the lane ZERO times on refusal/pre-abort, so
     * a zero count here is a REAL setup-side-effect proof.
     */
    readonly spyInnerRun: () => RunSpy;
    /** The setup fault a NON-strict run of this lane must still hit. */
    readonly nonstrictMessage: string;
    /**
     * Per-lane factory knobs applied at the factory legs' construction, so a
     * row can pin its transport (the claude-code sdk row).
     */
    readonly lanes?: DriverFactoryConfig['lanes'];
  }

  const rows: readonly SweepRow[] = [
    {
      name: 'claude-code',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'claude-code',
      direct: (reached, sessionsDir) =>
        new ClaudeCodeDriver({
          spawn: () => {
            reached();
            throw new Error('subprocess-setup-reached');
          },
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'claude-code' } },
      spyInnerRun: () => vi.spyOn(ClaudeCodeDriver.prototype, 'run'),
      nonstrictMessage: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'claude-code',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'claude-code',
      direct: (reached, sessionsDir) =>
        new ClaudeCodeDriver({
          transport: 'sdk',
          sdkLoader: () => {
            reached();
            throw new Error('claude-code-sdk-setup-reached');
          },
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'claude-code' } },
      // The factory legs resolve the SDK transport too, so the row proves
      // the guard on the lane's OPTIONAL substrate path, not just the CLI one.
      lanes: { claudeCode: { transport: 'sdk' } },
      spyInnerRun: () => vi.spyOn(ClaudeCodeDriver.prototype, 'run'),
      nonstrictMessage: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'acp',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'acp',
      direct: (reached, sessionsDir) =>
        new AcpDriver({
          spawn: () => {
            reached();
            throw new Error('acp-setup-reached');
          },
          // A definitely-missing explicit binary, so a NON-strict run hits the
          // deterministic missing-binary config instead of probing/PATH/spawn.
          command: ['/nonexistent/cq-acp-sweep-probe'],
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'acp' } },
      spyInnerRun: () => vi.spyOn(AcpDriver.prototype, 'run'),
      nonstrictMessage: 'acp driver',
    },
  ];

  function setupCounter(): { bump: () => void; calls: () => number } {
    let n = 0;
    return {
      bump: () => {
        n += 1;
      },
      calls: () => n,
    };
  }

  function preAbortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  for (const row of rows) {
    test(`${row.name} / direct: strict refusal precedes all setup (zero setup calls, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const err = await driver
          .run(invocation(row.directModelSpec, STRICT_BUDGET))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DispatchError);
        expect(errorClassOf(err)).toBe('config');
        expect((err as Error).message).toContain(row.refusalPhrase);
        expect((err as Error).message).toContain(row.refusalLane);
        expect(counter.calls()).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / direct: pre-abort precedes all setup (zero setup calls, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const result = await driver.run(invocation(row.directModelSpec, STRICT_BUDGET), {
          signal: preAbortedSignal(),
        });
        expect(result.stopReason).toBe('aborted');
        expect(result.usage).toEqual(ZERO_USAGE);
        expect(counter.calls()).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / factory: strict refusal never invokes the lane (spy zero, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const innerRun = row.spyInnerRun();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const factory = createDriverFactory({
          sessionsDir,
          bindings: row.bindings,
          ...(row.lanes !== undefined ? { lanes: row.lanes } : {}),
        });
        const resolved = factory.resolve({ role: 'fixer', modelSpec: row.factoryModelSpec });
        expect(resolved.lane).toBe(row.refusalLane);
        const err = await resolved.driver
          .run(invocation(row.factoryModelSpec, STRICT_BUDGET))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DispatchError);
        expect(errorClassOf(err)).toBe('config');
        expect((err as Error).message).toContain(row.refusalPhrase);
        expect((err as Error).message).toContain(row.refusalLane);
        expect(innerRun.mock.calls.length).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / factory: pre-abort never invokes the lane (spy zero, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const innerRun = row.spyInnerRun();
      try {
        const factory = createDriverFactory({
          sessionsDir,
          bindings: row.bindings,
          ...(row.lanes !== undefined ? { lanes: row.lanes } : {}),
        });
        const resolved = factory.resolve({ role: 'fixer', modelSpec: row.factoryModelSpec });
        const result = await resolved.driver.run(invocation(row.factoryModelSpec, STRICT_BUDGET), {
          signal: preAbortedSignal(),
        });
        expect(result.stopReason).toBe('aborted');
        expect(result.usage).toEqual(ZERO_USAGE);
        expect(innerRun.mock.calls.length).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / direct: a nonstrict budget hits the lane's OWN setup fault, not the strict refusal`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const err = await driver
          .run(invocation(row.directModelSpec, { maxUsd: 1 }))
          .catch((e: unknown) => e);
        // The lane's own pre-dispatch fault (missing key / missing binary) is
        // pinned, and the seam is NOT reached; the strict refusal did not fire.
        expect((err as Error).message).toContain(row.nonstrictMessage);
        expect((err as Error).message).not.toContain(row.refusalPhrase);
        expect(counter.calls()).toBe(0);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  // -------------------------------------------------------------------------
  // ai-sdk, direct + factory, with a REAL injected provider-factory spy (both
  // `AiSdkDriverOptions.providers` and `DriverFactoryConfig.lanes.aiSdk
  // .providers`). A zero count proves the capability refusal/pre-abort fired
  // BEFORE any provider-model resolution.
  // -------------------------------------------------------------------------

  function aiSdkMockDriver(reached: () => void, sessionsDir: string): AiSdkDriver {
    return new AiSdkDriver({
      providers: {
        anthropic: () => {
          reached();
          throw new Error('ai-sdk-provider-factory-reached');
        },
      },
      sessionsDir,
    });
  }

  const AI_SDK_SPEC: ModelSpec = { provider: 'anthropic', model: 'claude-test' };

  test('ai-sdk (mock providers) / direct: capability refusal precedes the provider factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await aiSdkMockDriver(counter.bump, sessionsDir)
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / direct: pre-abort precedes the provider factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const result = await aiSdkMockDriver(counter.bump, sessionsDir).run(
        invocation(AI_SDK_SPEC, STRICT_BUDGET),
        { signal: preAbortedSignal() },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO_USAGE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function aiSdkMockFactory(counter: { bump: () => void }, sessionsDir: string) {
    const factory = createDriverFactory({
      sessionsDir,
      lanes: {
        aiSdk: {
          providers: {
            anthropic: () => {
              counter.bump();
              throw new Error('ai-sdk-factory-setup-reached');
            },
          },
        },
      },
    });
    return factory.resolve({ role: 'fixer', modelSpec: AI_SDK_SPEC }).driver;
  }

  test('ai-sdk (mock providers) / factory: capability refusal precedes the injected factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await aiSdkMockFactory(counter, sessionsDir)
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / factory: pre-abort precedes the injected factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const result = await aiSdkMockFactory(counter, sessionsDir).run(
        invocation(AI_SDK_SPEC, STRICT_BUDGET),
        { signal: preAbortedSignal() },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO_USAGE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / direct: a nonstrict budget REACHES the provider factory (reach proof)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const err = await aiSdkMockDriver(counter.bump, sessionsDir)
        .run(invocation(AI_SDK_SPEC, { maxUsd: 1 }))
        .catch((e: unknown) => e);
      expect(counter.calls()).toBe(1);
      expect((err as Error).message).toContain('ai-sdk-provider-factory-reached');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // ai-sdk DEFAULT provider registry: an honest KEY-GUARD pair. The default
  // registry has no injectable factory (no production seam is added for tests),
  // so the honest claim is: with ANTHROPIC_API_KEY pinned EMPTY, the capability
  // refusal fires INSTEAD OF the registry's own missing-key error — proving the
  // registry was never read.
  // -------------------------------------------------------------------------

  test('ai-sdk (default registry) / direct: capability refusal, NOT the registry missing-key error', async () => {
    const { root, sessionsDir } = await scratch();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await new AiSdkDriver({ sessionsDir })
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect((err as Error).message).not.toContain('ANTHROPIC_API_KEY');
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (default registry) / factory: capability refusal, NOT the registry missing-key error', async () => {
    const { root, sessionsDir } = await scratch();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const factory = createDriverFactory({ sessionsDir });
      const resolved = factory.resolve({ role: 'fixer', modelSpec: AI_SDK_SPEC });
      expect(resolved.lane).toBe('ai-sdk');
      const err = await resolved.driver
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect((err as Error).message).not.toContain('ANTHROPIC_API_KEY');
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
