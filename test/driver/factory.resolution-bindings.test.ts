// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the resolve-time binding validation and explicit-only lane
// subjects. The suite-wide header and shared fixtures live in
// ./factory.helpers.ts.
import { describe, expect, test } from 'vitest';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import type { DriverFactoryConfig } from '../../src/driver/factory.js';
import { probe } from './factory.helpers.js';

describe('driver factory — resolution', () => {
  test('claude-code is never a default: an unbound non-default provider is a config throw', () => {
    const factory = createDriverFactory({ bindings: { fixer: { zai: 'claude-code' } } });
    const thrownBy = (): unknown => {
      try {
        factory.resolve({ role: 'classifier', modelSpec: { provider: 'nope', model: 'm' } });
        return undefined;
      } catch (err) {
        return err;
      }
    };
    const err = thrownBy();
    expect(err).toBeInstanceOf(DispatchError);
    expect(errorClassOf(err)).toBe('config');
    expect((err as Error).message).toMatch(
      /no lane binding for role 'classifier' on provider 'nope'/,
    );
  });

  test('a binding naming an unknown lane is a pre-dispatch config throw (exact and wildcard)', () => {
    // Decoded/JS config is plain data the compiler already trusted: a
    // binding value outside the four lanes must fail at RESOLVE time as a
    // structured 'config' throw — never as a wrapper around an
    // unconstructable lane whose run() dies unclassified mid-goal (PR #238
    // review round 2).
    const decoded = {
      fixer: { zai: 'not-a-lane' },
    } as unknown as NonNullable<DriverFactoryConfig['bindings']>;
    const exact = createDriverFactory({ bindings: decoded });
    const thrown = (): unknown => {
      try {
        exact.resolve({ role: 'fixer', modelSpec: { provider: 'zai', model: 'glm-4.6' } });
        return undefined;
      } catch (err) {
        return err;
      }
    };
    const err = thrown();
    expect(err).toBeInstanceOf(DispatchError);
    expect(errorClassOf(err)).toBe('config');
    expect((err as Error).message).toMatch(/unknown lane 'not-a-lane'/);
    expect((err as Error).message).toMatch(/role 'fixer' on provider 'zai'/);
    // The wildcard row flows through the same validation.
    const wild = createDriverFactory({
      bindings: {
        classifier: { '*': 'vendor' },
      } as unknown as NonNullable<DriverFactoryConfig['bindings']>,
    });
    expect(() =>
      wild.resolve({ role: 'classifier', modelSpec: { provider: 'anything', model: 'm' } }),
    ).toThrow(/unknown lane 'vendor'/);
  });

  test('the acp and claude-code lanes exist only through explicit bindings', async () => {
    const factory = createDriverFactory({
      bindings: { remediator: { vendor: 'acp' }, fixer: { vendor: 'claude-code' } },
      lanes: {
        acp: {
          // A deliberately unresolvable binary: the lane's own pre-dispatch
          // throw names the class without spawning anything.
          endpoint: 'vendor-acp',
          endpointTable: {
            endpoints: {
              'vendor-acp': {
                command: ['/nonexistent/cq-factory-vendor-acp'],
                installHint: 'offline test fixture',
                notes: 'Offline factory-test fixture; never resolved',
              },
            },
          },
        },
      },
    });
    const acp = factory.resolve({
      role: 'remediator',
      modelSpec: { provider: 'vendor', model: 'm' },
    });
    expect(acp.lane).toBe('acp');
    await probe(acp.driver, /acp driver: the harness binary '.*vendor-acp' was not found/);
    const agent = factory.resolve({ role: 'fixer', modelSpec: { provider: 'vendor', model: 'm' } });
    expect(agent.lane).toBe('claude-code');
    await probe(agent.driver, /claude-code driver: unknown provider/);
  });
});
