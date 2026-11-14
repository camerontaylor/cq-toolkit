// The CLI layer may import only src/registry and src/kernel (lint rule
// no-cli-beyond-registry-kernel), so the CLI reaches the env snapshot through
// this registry-boundary seam (the same precedent as ./plans.ts). The implementation lives in src/config/entry.ts.
export {
  CqEnvError,
  assertCqEnv,
  checkEntryEnv,
  enterWithCqEnv,
  enterWithEntryEnv,
  type EntryEnvCheck,
} from '../config/entry.js';
export type { CqEnv } from '../config/env.js';
export type { EntryEnv } from '../config/run-env.js';
export { currentEntryEnv, runWithCqEnv } from '../config/run-env.js';
