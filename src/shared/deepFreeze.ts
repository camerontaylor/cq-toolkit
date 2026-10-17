/**
 * Deep-freeze a plain-data value in place (recursively — objects and arrays)
 * and return it. Shared default CONFIG must be immutable: a caller mutating
 * a nested object of a shared default would otherwise silently change
 * every later consumer's behavior — freezing makes that write THROW loudly
 * (strict mode) instead of poisoning the shared default.
 *
 * (Migration Phase 1.3: moved here from src/harness/config.ts, which kept
 * only its harness-specific defaults; plans, drivers, selfhost config and
 * ops review share the helper itself.)
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
