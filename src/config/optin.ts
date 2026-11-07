// The one permitted per-call route for a trust-boundary key (ADR-0009; ADR-0003
// named authorization): an in-process SDK `optIn` built with `trustedOptIn()`.
// The brand lives in a module-private WeakSet, so an object that arrived as JSON
// (plan data, op input, a CLI flag) can never carry it. Resolvers call
// `assertOptInAuthority`, which consults the registry `trust` flag: a per-call
// value for a trust key is refused with a `config` error unless the optIn is
// branded; a key whose flag is false is unaffected.
import { CQ_ENV_REGISTRY } from './env-registry.js';
import type { CqEnvRegistry } from './env-registry.js';

const TRUSTED = new WeakSet<object>();

/**
 * Mark an optIn object as authored in-process by SDK code. Never feed it from
 * plan JSON, op input or the CLI: the result is a frozen copy.
 */
export function trustedOptIn<T extends object>(optIn: T): Readonly<T> {
  const copy = Object.freeze({ ...optIn });
  TRUSTED.add(copy);
  return copy;
}

/** A `config`-class error (structurally a DispatchError; src/config cannot import the driver layer). */
function configError(message: string): Error {
  return Object.assign(new Error(message), { dispatchClass: 'config' as const });
}

/**
 * Refuse a per-call value for a trust key unless `optIn` was built by
 * `trustedOptIn`. `keyToEnv` maps each optIn key to its registry name.
 */
export function assertOptInAuthority(
  where: string,
  optIn: object,
  keyToEnv: Readonly<Record<string, string>>,
  registry: CqEnvRegistry = CQ_ENV_REGISTRY,
): void {
  if (TRUSTED.has(optIn)) return;
  for (const [key, value] of Object.entries(optIn)) {
    if (value === undefined) continue;
    const name = keyToEnv[key];
    const entry = name === undefined ? undefined : registry.entries.find((e) => e.name === name);
    if (entry?.trust === true) {
      throw configError(
        `${where}: a per-call value for ${entry.name} (${key}) is refused: trust keys take a per-call value only from an in-process trustedOptIn(), never from plan data, op input or the CLI`,
      );
    }
  }
}
