/** The artifact capability declaration schema version emitted by the build. */
export const CAPABILITY_SCHEMA_VERSION = 1;

/**
 * Unit command strings this artifact implements as live effects.
 *
 * This is data for the existing adapter capability check. It is not a gate,
 * registry or override. The build emits it into the packaged artifact, and the
 * adapter reads it only after the whole artifact inventory and source proof
 * have been verified.
 */
export const LIVE_UNIT_COMMANDS = ['watchdog', 'publish'] as const;
