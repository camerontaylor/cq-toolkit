// Gates lane C1 — registry slice: the `gates.checkRunner` op entry, typed
// against the FROZEN OpRegistryEntry (src/kernel/types.ts). The importer
// binds the op to the default subprocess runner — the lane's only I/O
// wiring, sitting behind the injected RunCheck seam.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { CheckRunnerInput } from './checkRunner.js';

/**
 * Registry-time mirror of {@link CheckRunnerInput}: the full input, and only
 * it. `timeoutMs` defaults to 600_000 here — a 10-minute floor applied at
 * the OP boundary only, so a JSON-dispatched check can never run uncapped
 * (a watch-mode command hangs at most one timeout, not the job). The
 * library-level {@link CheckCommand} stays timeout-optional.
 */
export const CheckRunnerInputSchema: z.ZodType<CheckRunnerInput> = z
  .object({
    adapter: z.enum(['vitest-json', 'eslint-json', 'tsc-lines']),
    command: z.object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(600_000),
    }),
  })
  .strict();

/** Gates-lane op registry (C1: one entry; C2 adds the probe/gate ops). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'gates.checkRunner',
    inputSchema: CheckRunnerInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here.
    importer: () =>
      import('./checkRunner.js').then(
        (m) => m.makeCheckRunner(m.subprocessRunCheck) as Op<unknown, unknown>,
      ),
  },
];
