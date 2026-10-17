// ratchet.recomputeTypecheck's input schema, alone in its module so that its
// two carriers share it: the op registry (./registry.ts) and cq-verify's
// in-process entry (src/selfhost/recompute-typecheck.ts, residual R1 in
// docs/protected-scope.md). Module scope imports only zod (the registry's
// LAZY RULE), so neither carrier loads an op module by importing it.
import { z } from 'zod';

/** The `ratchet.recomputeTypecheck` registry input (the trusted recompute, W1.7). */
export const RecomputeTypecheckCommandInputSchema = z
  .object({
    repo: z.string().min(1),
    subject: z.string().min(1),
    scratch: z.string().min(1),
    timeoutMs: z.number().int().positive().exactOptional(),
  })
  .strict();
