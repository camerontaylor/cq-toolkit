// Driver family public-surface barrel — the frozen seam types, re-export
// only, no logic.
export * from './types.js';
export * from './errors.js';
export * from './served-model.js';
export * from './factory.js';
// The shared structured-output seam (ADR-0002 §2.3): the invocation-schema
// builder and the shared validator behind the lanes' uniform verdict.
export { toOutputSchema, validateStructured } from './common/structured.js';
// The shipped driver-conformance suite (ADR-0002 §4): `runDriverConformance(
// makeDriver, { describe, test, expect })` — the runner is injected, so this
// module imports no test framework (and no kernel module, per the seam rule).
export * from './conformance.js';
