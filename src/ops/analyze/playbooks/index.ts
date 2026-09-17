// Playbooks (G3) — public surface. Re-export only, no logic: the authored
// playbook format (strict zod schema + schema version), the verifier (the
// exit-to-verdict mapping over the injected runner), the quarantine lane
// (the pure fail-closed state machine), and the playbook registry +
// dispatch op factory. The op REGISTRY entries for the three playbook ops
// live in the family's registry.ts, per the family convention.
export {
  PLAYBOOK_ID_PATTERN,
  PLAYBOOK_SCHEMA_VERSION,
  PlaybookSchema,
  VerifierCommandSchema,
} from './format.js';
export type { Playbook, VerifierCommand } from './format.js';
export { makePlaybookVerifier } from './verifier.js';
export type { PlaybookVerifierOutcome } from './verifier.js';
export { QUARANTINE_PHASE, makeQuarantineLedger } from './quarantine.js';
export type { QuarantineLedger, QuarantinePhase, QuarantineRecord } from './quarantine.js';
export {
  makePlaybookDispatchOp,
  makePlaybookQuarantineListOp,
  makePlaybookRegisterOp,
  makePlaybookRegistry,
} from './registry.js';
export type {
  PlaybookDispatchDeps,
  PlaybookDispatchInput,
  PlaybookDispatchOutcome,
  PlaybookDispatchRecord,
  PlaybookQuarantineListInput,
  PlaybookQuarantineListReport,
  PlaybookRegisterInput,
  PlaybookRegistered,
  PlaybookRegistry,
} from './registry.js';
