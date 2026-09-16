// Analyze family (G1) — public surface. Re-export only, no logic: the
// FailureSet union across packages/runs (single-tool, exact-identity
// duplicate collapse), the signature clustering with honest confidence and
// the ledger noise seam, and the family's registry slice.
export type { CollectFailuresInput } from './collectFailures.js';
export {
  collectFailures,
  collectFailuresOp,
  failureIdentity,
  sortByIdentity,
} from './collectFailures.js';
export type {
  Cluster,
  ClusterConfidence,
  ClusterErrorsInput,
  ClusterErrorsReport,
} from './clusterErrors.js';
export {
  clusterErrors,
  clusterErrorsOp,
  clusterSignature,
  messageTemplate,
} from './clusterErrors.js';
// The registry ARRAY is deliberately not re-exported here (the gates
// precedent): `registry` would collide with the ledger family's export on
// the root barrel (star-export ambiguity is a compile error, TS2308) — the
// central op-registry scanner and tests import ./registry.js directly.
export {
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  LedgerViewSchema,
} from './registry.js';
