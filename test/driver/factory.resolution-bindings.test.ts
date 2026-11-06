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
    // binding value outside the four lanes must fail at CONSTRUCTION time as a
    // structured 'config' throw — never as a wrapper around an
    // unconstructable lane whose run() dies unclassified mid-goal (PR #238
    // review round 2).
    const decoded = {
      fixer: { zai: 'not-a-lane' },
    } as unknown as NonNullable<DriverFactoryConfig['bindings']>;
    const thrown = (): unknown => {
      try {
        createDriverFactory({ bindings: decoded });
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
    expect(() =>
      createDriverFactory({
        bindings: {
          classifier: { '*': 'vendor' },
        } as unknown as NonNullable<DriverFactoryConfig['bindings']>,
      }),
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

describe('aggregate config errors', () => {
  const bad = (bindings: unknown) =>
    createDriverFactory({ bindings: bindings as NonNullable<DriverFactoryConfig['bindings']> });
  const msg = (f: () => unknown): string => {
    try {
      f();
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };

  test('two bad lane bindings give one error listing both, with suggestions', () => {
    const m = msg(() => bad({ fixer: { zai: 'claud-code' }, classifier: { '*': 'vendor' } }));
    expect(m).toContain('2 configuration problems');
    expect(m).toContain("role 'fixer' on provider 'zai' names unknown lane 'claud-code'");
    expect(m).toContain('did you mean `claude-code`?');
    expect(m).toContain("role 'classifier' on provider '*' names unknown lane 'vendor'");
    expect(m.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });

  test('a bad binding for role A fails at construction, whichever role is resolved later', () => {
    expect(msg(() => bad({ fixer: { zai: 'nope-lane-x' } }))).toContain(
      "unknown lane 'nope-lane-x'",
    );
    // Construction fails before any resolve() can name another role.
    expect(() => bad({ fixer: { zai: 'nope-lane-x' }, classifier: { zai: 'acp' } })).toThrow(
      DispatchError,
    );
  });

  test('a valid table with an unbound request still fails per request at resolve', () => {
    const f = bad({ fixer: { zai: 'acp' } });
    const m = msg(() => f.resolve({ role: 'fixer', modelSpec: { provider: 'nope', model: 'm' } }));
    expect(m).toContain("no lane binding for role 'fixer' on provider 'nope'");
  });

  test('misspelled provider and role get suggestions', () => {
    const f = createDriverFactory();
    expect(
      msg(() => f.resolve({ role: 'fixer', modelSpec: { provider: 'anthropc', model: 'm' } })),
    ).toContain('did you mean provider `anthropic`?');
    const g = createDriverFactory({ bindings: { fixer: { vendorx: 'acp' } } });
    expect(
      msg(() => g.resolve({ role: 'fixr', modelSpec: { provider: 'vendorx', model: 'm' } })),
    ).toContain('role `fixer`');
  });

  test('a single problem keeps the old one-line message', () => {
    const m = msg(() =>
      createDriverFactory().resolve({
        role: 'classifier',
        modelSpec: { provider: 'nope', model: 'm' },
      }),
    );
    expect(
      m.startsWith("driver factory: no lane binding for role 'classifier' on provider 'nope'"),
    ).toBe(true);
    expect(m).not.toContain('\n');
  });
});
