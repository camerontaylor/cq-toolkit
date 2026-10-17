// gates.policyDiff's input schema, alone in its module so that its two
// carriers share it: the op registry (`gates.policyDiff` in ./registry.ts)
// and cq-policy's in-process entry (src/selfhost/policy-diff.ts, residual R1
// in docs/protected-scope.md). Module scope imports only zod, so neither
// carrier loads an op module by importing it.
import { z } from 'zod';

/**
 * Registry-time mirror of `PolicyDiffInput` (W1.9, D11): the full input, and
 * only it. STRICT and deliberately WITHOUT a posture field — the posture
 * comes from the project env / per-call opt-in at dispatch (RS-15 Annex B
 * §B.1), never from plan JSON or op input, so a subject cannot relax its own
 * check. Numeric ids are positive integers. Equally without
 * `authorization`: a D11Authorization ('./d11Authorization.js') is bound
 * in-process only, by the promotion gate and cq-verify's
 * `selfhost/verify-ratchet`, never carried by a CLI or plan input.
 */
export const PolicyDiffInputObject = z
  .object({
    repo: z.string().min(1),
    trustRef: z.string().min(1),
    subject: z.string().min(1),
    subjectKind: z.enum(['pr', 'push']),
    base: z.string().min(1),
    pr: z.number().int().positive().exactOptional(),
    repository: z.string().min(1).exactOptional(),
    ownerId: z.number().int().positive().exactOptional(),
    labelEventsPath: z.string().min(1).exactOptional(),
    settleRef: z.string().min(1).exactOptional(),
  })
  .strict();
