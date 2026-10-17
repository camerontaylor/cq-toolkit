// Dev family registry slice (strategy §8 lane 1) — the `dev.check`,
// `dev.review`, `dev.disposition`, and `dev.ready` op entries, typed against
// the FROZEN OpRegistryEntry (src/kernel/types.ts). THE LAZY RULE (the
// pr/merge precedent, kept exactly): module scope imports ONLY zod plus
// type-only imports (erased at compile time) — loading this registry never
// loads an op module, the subprocess effects, or the denylist parser; every
// op is reached through its entry's dynamic import at dispatch.
//
// DRIFT PINNING: every mirror is annotated `z.ZodType<T>` against the op's
// hand-written input type (type-only import) — a schema whose output drifts
// from the type fails typecheck.
//
// EFFECTS ARE BOUND PER DISPATCH (the pr family importer precedent): each
// entry's importer dynamically imports the op module AND effects.js (and,
// for dev.review, denylist.js), binding the subprocess effects from the
// INPUT's plain-JSON repoRoot — the registry entry carries no repo state.
// The construction is inert (closure-only; a process spawns only when an
// effect is CALLED), so resolving an entry never touches env, the network,
// the host lock, or the filesystem.
//
// BUILT-IN DEFAULTS (strategy §5): the target default and the reviewer
// choice vocabulary are the built-in constants from record.js/coderabbit.js
// until the protected policy/dev-protocol.json consumer batch lands; no
// provider or model names appear here — the fallback reviewer is an
// explicit `agent:<provider/model>` flag value.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import { CODERABBIT_REVIEWER } from './coderabbit.js';
import type { DevCheckInput } from './check.js';
import type { DevDispositionInput } from './disposition.js';
import type { DevIdentity } from './record.js';
import type { DevReadyInput } from './ready.js';
import type { DevReviewInput } from './review.js';

/** The reviewer choice: the shipped CLI reviewer, or the `agent:` fallback spelling. */
const REVIEWER_PATTERN = new RegExp(
  `^(${CODERABBIT_REVIEWER}|agent:[A-Za-z0-9][A-Za-z0-9._/@-]*)$`,
);

// Defaults are applied by the OPS (`target ?? DEFAULT_DEV_TARGET`), not the
// schemas — the drift pins mirror the hand-written optional input types, so
// every optional field is `.exactOptional()` (exactOptionalPropertyTypes).
export const DevCheckInputSchema: z.ZodType<DevCheckInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
    range: z.string().min(3).exactOptional(),
    knip: z.enum(['auto', 'force']).exactOptional(),
  })
  .strict();

export const DevReviewInputSchema: z.ZodType<DevReviewInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
    base: z
      .string()
      .regex(/^[0-9a-fA-F]{7,64}$/, 'base must be a commit sha (an immutable pin)')
      .exactOptional(),
    reviewer: z.string().regex(REVIEWER_PATTERN).exactOptional(),
    uncommitted: z.boolean().exactOptional(),
  })
  .strict();

export const DevDispositionInputSchema: z.ZodType<DevDispositionInput> = z
  .object({
    repoRoot: z.string().min(1),
    findingId: z.string().min(1),
    action: z.enum(['fixed', 'rejected', 'deferred']),
    why: z.string().min(1),
  })
  .strict();

export const DevReadyInputSchema: z.ZodType<DevReadyInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
  })
  .strict();

/**
 * The family's identity-contract drift pin: every dev record carries this
 * (base, head, dirty-diff) triple, and dev.review pins review evidence
 * against it. Owned here at the registry boundary — the same move as the
 * gates family's FingerprintConfigSchema — so SDK consumers composing dev
 * inputs validate the identity against ONE drift-pinned shape. Type-only
 * helper import (the lazy rule: the registry never loads record.js at
 * module scope).
 */
export const DevIdentitySchema: z.ZodType<DevIdentity> = z
  .object({
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
  })
  .strict();

/** Dev family op registry (strategy §8 lane 1: the pre-PR cycle as commands). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'dev.check',
    inputSchema: DevCheckInputSchema,
    importer: () =>
      import('./check.js').then(
        (m) =>
          (async (input: DevCheckInput) =>
            m.makeDevCheck((await import('./effects.js')).makeSubprocessDevEffects(input.repoRoot))(
              input,
            )) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.review',
    inputSchema: DevReviewInputSchema,
    // The secret scanner binds from the dispatched repoRoot (the repo's own
    // denylist classes); the reviewer subprocess and the host lock bind the
    // same way. Resolution stays inert.
    importer: () =>
      Promise.all([import('./review.js'), import('./effects.js'), import('./denylist.js')]).then(
        ([m, effects, denylist]) =>
          (async (input: DevReviewInput) => {
            const dev = effects.makeSubprocessDevEffects(input.repoRoot);
            // THE PRE-UPLOAD NET IS TWO-LAYERED: gitleaks DEFAULT rules AND
            // the repo's project denylist classes — either firing refuses
            // the upload (the protected scripts/denylist-scan is untouched;
            // this binds its rule FILE read-only).
            const scanner = denylist.composeScanners(
              denylist.makeGitleaksDefaultsScanner(dev),
              denylist.makeRepoDiffScanner(input.repoRoot),
            );
            return m.makeDevReview(dev, scanner)(input);
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.disposition',
    inputSchema: DevDispositionInputSchema,
    importer: () =>
      import('./disposition.js').then(
        (m) =>
          (async (input: DevDispositionInput) =>
            m.makeDevDisposition(
              (await import('./effects.js')).makeSubprocessDevEffects(input.repoRoot),
            )(input)) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.ready',
    inputSchema: DevReadyInputSchema,
    importer: () =>
      import('./ready.js').then(
        (m) =>
          (async (input: DevReadyInput) =>
            m.makeDevReady((await import('./effects.js')).makeSubprocessDevEffects(input.repoRoot))(
              input,
            )) as Op<unknown, unknown>,
      ),
  },
];
