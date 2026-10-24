/**
 * JSON-LOSSLESSNESS check for op results (the journal line is a JSON.stringify
 * of the result; replay reconstructs from that line). stringify-throwing
 * values (BigInt, circular) are caught by the stringify probe; this walk
 * catches the SILENTLY lossy ones — Map/Set/Date/RegExp/class instances
 * stringify as `{}` or strings, function members, symbol-keyed or non-enumerable (hidden) members vanish, undefined
 * array elements become null — where the journal would otherwise disagree
 * with the value the run produced. One normalization is accepted, matching
 * JSON semantics: an undefined-valued member of a nested object IS absent
 * data ({a: undefined} and {} are the same JSON record) — required-field
 * positions (the ok variant's `value`) are guarded by the caller.
 * Plain objects: prototype null or Object.prototype only.
 * Requires cycle-freedom — call only after the stringify probe passed.
 */
export function assertJsonLossless(value: unknown): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`non-finite number ${String(value)}`);
      return;
    case 'object': {
      if (value === null) return;
      if (Array.isArray(value)) {
        // Arrays carry ONLY their indexed elements and `length`: any other
        // own key — a symbol, a hidden non-enumerable toJSON, an enumerable
        // `extra` property — is dropped by JSON.stringify exactly like the
        // object-side cases (PR #103 review, Codex P1; this branch returned
        // before the Reflect.ownKeys loop below, leaving arrays unvalidated).
        for (const key of Reflect.ownKeys(value)) {
          if (key === 'length') continue;
          if (typeof key === 'symbol') {
            throw new Error(
              `symbol-keyed own member '${key.toString()}' — JSON.stringify drops it`,
            );
          }
          const index = Number(key);
          // A real array index is 0..2^32-2 (PR #114 review, CodeRabbit
          // Major + Codex P2): "4294967295" is a plain property — length
          // never grows, JSON.stringify drops it — so it must NOT pass as
          // an index here.
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index <= 2 ** 32 - 2 &&
            String(index) === key
          ) {
            continue;
          }
          throw new Error(
            key === 'toJSON'
              ? "own 'toJSON' on an array — JSON.stringify invokes the hook, so the serialized shape diverges from the walked one"
              : `non-index own member '${key}' on an array — JSON.stringify drops it`,
          );
        }
        for (let i = 0; i < value.length; i++) {
          const element: unknown = value[i];
          if (element === undefined) throw new Error(`undefined array element at [${i}]`);
          assertJsonLossless(element);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as object).constructor?.name ?? 'unknown';
        throw new Error(`non-plain object of type '${name}'`);
      }
      // ALL own keys, not just the enumerable string-keyed ones (PR #31
      // review, Codex P1 + review-debt #76): a SYMBOL-keyed member is
      // dropped by JSON.stringify, so the journal would reconstruct less
      // than the walk accepted; a NON-ENUMERABLE own member is the worse
      // divergence when it is a hidden `toJSON` hook — Object.values
      // skips it while stringify INVOKES it, so the journal would
      // reconstruct the hook's output instead of the walked shape (and
      // any non-enumerable member is data invisible to the serialization
      // either way). An ENUMERABLE own toJSON needs no special case: the
      // member walk below reaches it as a function value and throws.
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new Error(`symbol-keyed own member '${key.toString()}' — JSON.stringify drops it`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && !descriptor.enumerable) {
          throw new Error(
            key === 'toJSON'
              ? "non-enumerable own 'toJSON' — JSON.stringify invokes the hidden hook, so the journal would reconstruct its output instead of the walked shape"
              : `non-enumerable own member '${key}' — invisible to JSON.stringify`,
          );
        }
      }
      for (const memberValue of Object.values(value)) {
        if (memberValue === undefined) continue; // absent-key semantics
        assertJsonLossless(memberValue);
      }
      return;
    }
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
    default:
      throw new Error(`non-JSON value of type '${typeof value}'`);
  }
}
