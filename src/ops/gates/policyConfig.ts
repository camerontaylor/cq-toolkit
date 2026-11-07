// D11 protected-path posture (W1.9, ADR-0004 D-G; key naming per RS-15
// Annex B): which changed protected paths need a human.
//
// The resolver is deliberately pure, following W1.11's sandbox resolver
// (`src/sandbox/config.ts`): the caller injects the environment and the
// explicit per-call opt-in. Unset or blank is the conservative `human`
// posture (P8); any value other than `human`/`diff-check`/`advisory` is a
// configuration error, never a silent fallback.
//
// THE ADVISORY POSTURE (development posture, 2026-10-20; docs/protected-scope.md
// "Advisory posture"): only privileged paths (the trust ref's project
// `protectedPaths` list), loosened baselines and removed ratchet targets or
// definition/policy-list entries still need a human; every other finding is
// an annotation in the run report. `lint` stays `fail` in every posture.
//
// WHERE THE POSTURE MAY COME FROM (Annex B §B.1): only the project env
// (`CQ_MERGE_PROTECTED_PATHS`) and an explicit per-call opt-in. Plan JSON, op
// input and workspace files never carry it — the policy op's input schema is
// strict and has no posture field, so a subject cannot relax its own check.
// The per-call object shape follows W1.11's `SandboxOptIn` and plan §3.1; the
// CLI `--opt-in` flag that would populate it is W3.6's.

import type { CqEnv } from '../../config/env.js';
import {
  POSTURE_LIST,
  PROTECTED_PATHS_POSTURES,
  isPosture,
  type ProtectedPathsPosture,
} from '../../config/values.js';
import { assertCqEnvName } from '../../config/entry.js';
import { processEnv } from '../../config/process-env.js';
import type { CqEnvRegistry } from '../../config/env-registry.js';
import { assertOptInAuthority } from '../../config/optin.js';

/**
 * `human`: every finding needs a human. `diff-check`: plain protected-path
 * edits pass. `advisory`: only privileged-path, baseline-loosened,
 * target-removed and entry-removed findings need a human; the rest are
 * annotations.
 */
export type { ProtectedPathsPosture };
export { PROTECTED_PATHS_POSTURES };

/** The project env key selecting the posture. */
export const PROTECTED_PATHS_ENV = 'CQ_MERGE_PROTECTED_PATHS';

/** The explicit per-call opt-in key. */
export const PROTECTED_PATHS_OPT_IN = 'merge.protectedPaths';

/** The per-call opt-in object (W1.11 `SandboxOptIn` shape). */
export interface ProtectedPathsOptIn {
  'merge.protectedPaths'?: string;
}

/** The resolved posture and the layer that supplied it, for the run report. */
export interface ProtectedPathsConfig {
  readonly posture: ProtectedPathsPosture;
  readonly layer: 'default' | 'env' | 'call';
}

/**
 * Resolve the D11 posture: explicit per-call opt-in, then project env, over
 * the conservative `human` default.
 *
 * The opt-in wins whichever way it points. Moving to `human` is a
 * tightening; moving to `diff-check` or `advisory` is a relaxation,
 * authorised only because the key is named explicitly — there is no
 * wildcard opt-in. Unlike the env,
 * a present-but-blank opt-in is an error: naming the key is a deliberate act,
 * so an empty value is a mistake rather than "unset".
 */
export function resolveProtectedPathsConfig(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    /** The entry point's resolved snapshot; wins over `env` so nothing re-reads the process env. */
    cqEnv?: CqEnv;
    optIn?: ProtectedPathsOptIn;
    /** Registry consulted for the `trust` flag; default the shipped registry (a test seam). */
    registry?: CqEnvRegistry;
  } = {},
): ProtectedPathsConfig {
  const env =
    options.cqEnv !== undefined
      ? { [PROTECTED_PATHS_ENV]: options.cqEnv.values[PROTECTED_PATHS_ENV] as string | undefined }
      : (options.env ?? processEnv());
  const optIn = options.optIn ?? {};
  assertOptInAuthority(
    'policy',
    optIn,
    { [PROTECTED_PATHS_OPT_IN]: PROTECTED_PATHS_ENV },
    options.registry,
  );

  const call = optIn[PROTECTED_PATHS_OPT_IN];
  if (call !== undefined) {
    if (!isPosture(call)) {
      throw new Error(`policy: ${PROTECTED_PATHS_OPT_IN} must be ${POSTURE_LIST}, got '${call}'`);
    }
    return Object.freeze({ posture: call, layer: 'call' });
  }

  // An invalid snapshot value is unset in `values`: refuse it, never default to `human` silently.
  if (options.cqEnv !== undefined) assertCqEnvName(options.cqEnv, 'policy', PROTECTED_PATHS_ENV);
  const raw = env[PROTECTED_PATHS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return Object.freeze({ posture: 'human', layer: 'default' });
  }
  if (!isPosture(raw)) {
    throw new Error(`policy: ${PROTECTED_PATHS_ENV} must be ${POSTURE_LIST}, got '${raw}'`);
  }
  return Object.freeze({ posture: raw, layer: 'env' });
}
