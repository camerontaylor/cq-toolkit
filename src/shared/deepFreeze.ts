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
  const visited = new WeakSet<object>();
  function freeze(current: unknown): void {
    if (current === null || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    // `Object.freeze` is shallow, so an already-frozen object can still hold
    // mutable children: always traverse them, and only skip the redundant
    // final freeze of a value that is already frozen.
    for (const key of Object.keys(current)) {
      freeze((current as Record<string, unknown>)[key]);
    }
    if (!Object.isFrozen(current)) {
      Object.freeze(current);
    }
  }
  freeze(value);
  return value;
}
