/**
 * crq family registry shell.
 *
 * The C1 repair-prepare slice lands `internal/repairPrepare.ts` as an offline
 * library helper, not an op: it registers no name, defines no input schema and
 * has no importer. The central registry still requires every `src/ops/<family>`
 * directory to export a `registry` array (an absent or non-array export is
 * surfaced in `skippedFamilies`, and the subcommand-surface test requires that
 * list to be empty). This empty array is that conformance surface; it is not
 * an op registration.
 */
import type { OpRegistryEntry } from '../../kernel/types.js';

export const registry: OpRegistryEntry[] = [];
