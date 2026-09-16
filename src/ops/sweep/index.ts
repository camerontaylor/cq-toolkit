// Sweep lane (WS-D, goal D1) — public surface. Re-export only, no logic:
// the planner (decision factory + subprocess effects binding + THE
// gates→ledger signature recipe), the git-mutation mutex (library utility —
// deliberately NOT a registry op), the worktree provider (decision factory
// + subprocess effects binding + its wire-format parsers), and the family
// registry with its registry-time input schemas. Names stay sweep-prefixed
// or domain-specific: star exports are COLLISION-SILENT across the root
// barrel (src/ops/README.md), so no generic `list`/`get`-class names leave
// this family.
export type {
  PlanSweepBaseline,
  PlanSweepDeps,
  PlanSweepInput,
  PlanSweepLedgerConfig,
  PlanSweepPackage,
  PlanSweepReport,
  PlanSweepSelector,
  WorkUnit,
} from './planSweep.js';
export {
  SWEEP_UNIT_OP,
  ledgerSignature,
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  parseNullDelimitedPaths,
} from './planSweep.js';
export type { GitMutex, GitMutexConfig, GitMutexEvent } from './gitMutex.js';
export {
  DEFAULT_GIT_MUTEX_RETRIES,
  DEFAULT_GIT_MUTEX_RETRY_BASE_MS,
  DEFAULT_GIT_MUTEX_STALE_MS,
  makeGitMutex,
} from './gitMutex.js';
export type {
  SubprocessWorktreeEffectsOptions,
  WorktreeAddRequest,
  WorktreeEffects,
  WorktreeForInput,
  WorktreeMutexConfig,
  Workspace,
} from './worktreeFor.js';
export {
  makeSubprocessWorktreeEffects,
  makeWorktreeFor,
  parseBranchRefs,
  parseRemoteHeads,
  parseWorktreePorcelain,
} from './worktreeFor.js';
export {
  PlanSweepInputSchema,
  registry as sweepRegistry,
  WorktreeForInputSchema,
} from './registry.js';
// The registry re-export is ALIASED: the ledger family barrel already sends
// `registry` up the root barrel's `export *`, and a second plain `registry`
// is a root-barrel collision (TS2308 at build; ESM would silently drop one
// at runtime). `sweepRegistry` keeps both families reachable by name; the
// central registry does not consume barrels — it scans src/ops/*/registry.ts.
