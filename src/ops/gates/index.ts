// Gates lane (C1) — public surface. Re-export only, no logic: the
// CheckRunner contract + pure parse core + op factory, and the three named
// wire-format adapters.
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
