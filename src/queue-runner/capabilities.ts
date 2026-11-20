/** The artifact capability declaration schema version emitted by the build. */
export const CAPABILITY_SCHEMA_VERSION = 1;

/**
 * Unit command strings this artifact implements as live effects.
 *
 * This is data for the existing adapter capability check. It is not a gate,
 * registry or override. The build emits it into the packaged artifact, and the
 * adapter reads it only after the whole artifact inventory and source proof
 * have been verified.
 *
 * Only systemd unit commands belong here: the deploy-side `artifact_identity`
 * (`apps/crq-python/ops/prepare-host.py` and its port
 * `src/ops/crq/deploy/artifactIdentity.ts`) refuses a declaration naming any
 * command outside `UNIT_COMMANDS`, which would block every unit switch to the
 * artifact. The SSH forced command `dispatch` and the operator commands
 * (`LIVE_OPERATOR_COMMANDS`) are routed in `crq.ts` and are never declared.
 */
export const LIVE_UNIT_COMMANDS = ['watchdog', 'publish'] as const;
