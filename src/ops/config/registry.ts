// Config lane — registry slice: the `config` op entry (`cq config`), typed
// against the FROZEN OpRegistryEntry (src/kernel/types.ts). Module scope
// imports only zod and types; the op loads through a dynamic import.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';

/** Registry-time mirror of ConfigShowInput: the full input, and only it. */
export const ConfigShowInputSchema = z.object({ strict: z.boolean().exactOptional() }).strict();

/** Config-lane op registry (`cq config [--strict]`). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'config',
    inputSchema: ConfigShowInputSchema,
    importer: async (wiring) =>
      (await import('./show.js')).makeConfigShow(wiring?.cqEnv) as Op<unknown, unknown>,
  },
];
