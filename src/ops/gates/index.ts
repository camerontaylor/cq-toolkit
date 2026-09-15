// Gates lane (C1+C2) — public surface. Re-export only, no logic: the
// CheckRunner contract + pure parse core + op factory, the three named
// wire-format adapters, and the C2 baseline tooling — fingerprints, the
// regression gate, and the baseline probe.
export type {
  AdapterName,
  CheckAdapter,
  CheckCommand,
  CheckFailure,
  CheckParseResult,
  CheckRunnerInput,
  FailureSet,
  RawCheckOutput,
  RunCheck,
} from './checkRunner.js';
export {
  adapterByName,
  makeCheckRunner,
  parseCheckOutput,
  subprocessRunCheck,
} from './checkRunner.js';
export { vitestJsonAdapter } from './adapters/vitest.js';
export { eslintJsonAdapter } from './adapters/eslint.js';
export { tscLinesAdapter } from './adapters/tsc.js';
export type {
  BailConfig,
  BaselineProbeInput,
  ProbeReport,
  ProbeVerdict,
} from './baselineProbe.js';
export { DEFAULT_BAIL_PATTERNS, makeBaselineProbe } from './baselineProbe.js';
export type { FingerprintConfig } from './fingerprint.js';
export {
  fingerprintFailure,
  fingerprintKey,
  fingerprintPairs,
  fingerprintSet,
  fnv1a32Hex,
} from './fingerprint.js';
export type {
  RegressionGateInput,
  RegressionReport,
  RegressionVerdict,
} from './regressionGate.js';
export { regressionGate } from './regressionGate.js';
export { CheckFailureSchema, FailureSetSchema, FingerprintConfigSchema } from './registry.js';
