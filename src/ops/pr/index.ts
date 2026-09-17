// pr op family barrel — goal D3 (ws-d item 4; R2 D9; UC §1 row 22).
// Re-export only, no logic: the tracker-first PR assembler, the fleet run
// report (merge-readiness artifact, three-valued checks, never
// auto-merges), the real gh subprocess effects adapter (the registry
// importer's binding, with its exported pure gh-output parsers), and the
// family registry with its registry-time input schemas. Names stay
// pr-prefixed or domain-specific: star exports are COLLISION-SILENT across
// the root barrel (src/ops/README.md), so no generic `list`/`get`-class
// names leave this family.
export type {
  AssemblePrsInput,
  AssemblePrsPackageReport,
  AssemblePrsReport,
  AssemblePrsTrackerReport,
  PrChecks,
  PrCreateRequest,
  PrCreateResult,
  PrEffects,
  PrMeta,
  PrReviewState,
  PrSearchResult,
  PrState,
} from './assemblePrs.js';
export {
  composeSection,
  makeAssemblePrs,
  MANIFEST_SECTION_END_MARKER,
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_END_MARKER,
  READINESS_SECTION_MARKER,
} from './assemblePrs.js';
// The run report's value type is exported ALIASED: the kernel's frozen
// runner report already owns `RunReport` on the root barrel, and a second
// plain `RunReport` would be silently EXCLUDED from the root barrel's
// `export *` (collision-silent star exports). `PrRunReport` keeps this
// family's report reachable by name everywhere.
export type { PrReadiness, PrRunReport, RunReportInput, RunReportRow } from './runReport.js';
export { makeRunReport } from './runReport.js';
export type { SubprocessPrEffectsOptions } from './ghEffects.js';
export {
  bodyOf,
  checksOfRollup,
  makeSubprocessPrEffects,
  mapGhFault,
  metaOf,
  parseCreatedPr,
  parsePrList,
  reviewStateOfDecision,
  selectPrMatch,
} from './ghEffects.js';
export {
  AssemblePrsInputSchema,
  registry as prRegistry,
  RunReportInputSchema,
} from './registry.js';
// The registry re-export is ALIASED (the sweep precedent): the ledger
// family barrel already sends plain `registry` up the root barrel's
// `export *`, and a second plain `registry` is a root-barrel collision
// (ESM would silently drop one at runtime). The central registry does not
// consume barrels — it scans src/ops/*/registry.ts.
