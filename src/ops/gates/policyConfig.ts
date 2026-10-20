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
// CLI `--opt-in` flag that would populate it is W3.6's. Since owner ruling
// D-P, a time-boxed revision window on the TRUST REF is a third source; see
// `applyRevisionWindow` below.

import { z } from 'zod';

/**
 * `human`: every finding needs a human. `diff-check`: plain protected-path
 * edits pass. `advisory`: only privileged-path, baseline-loosened,
 * target-removed and entry-removed findings need a human; the rest are
 * annotations.
 */
export type ProtectedPathsPosture = 'human' | 'diff-check' | 'advisory';

/** Every accepted posture value, in the error-message order. */
export const PROTECTED_PATHS_POSTURES: readonly ProtectedPathsPosture[] = Object.freeze([
  'human',
  'diff-check',
  'advisory',
]);

const POSTURE_LIST = "'human', 'diff-check' or 'advisory'";

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

const isPosture = (raw: string): raw is ProtectedPathsPosture =>
  (PROTECTED_PATHS_POSTURES as readonly string[]).includes(raw);

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
    optIn?: ProtectedPathsOptIn;
  } = {},
): ProtectedPathsConfig {
  const env = options.env ?? process.env;
  const optIn = options.optIn ?? {};

  const call = optIn[PROTECTED_PATHS_OPT_IN];
  if (call !== undefined) {
    if (!isPosture(call)) {
      throw new Error(`policy: ${PROTECTED_PATHS_OPT_IN} must be ${POSTURE_LIST}, got '${call}'`);
    }
    return Object.freeze({ posture: call, layer: 'call' });
  }

  const raw = env[PROTECTED_PATHS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return Object.freeze({ posture: 'human', layer: 'default' });
  }
  if (!isPosture(raw)) {
    throw new Error(`policy: ${PROTECTED_PATHS_ENV} must be ${POSTURE_LIST}, got '${raw}'`);
  }
  return Object.freeze({ posture: raw, layer: 'env' });
}

// THE D-P REVISION WINDOW (owner ruling D-P, 2026-10-16; docs/protected-scope.md).
// A third posture source beside the two above, amending Annex B §B.1 for
// this one shape: a time-boxed `diff-check` declared in the TRUST REF's
// `policy/protected-paths.json`. The subject never supplies it. The policy
// check reads the list at the trust ref only, so a PR cannot open, widen or
// extend a window for itself, and editing the list is itself a definition
// change that needs a human in every posture.
//
// The window relaxes ONLY the default layer: an explicit env or per-call
// posture is a deliberate statement and wins whichever way it points. A
// window that is not yet open, has expired, or is judged by an unusable
// clock leaves the posture `human` (fail closed, I5) and says so in the run
// report; a window the schema refuses fails the whole check instead.

/** Longest window a policy list may declare: an open-ended relaxation is a schema error. */
export const MAX_REVISION_WINDOW_DAYS = 31;

const DAY_MS = 86_400_000;

/** A real UTC second, `YYYY-MM-DDTHH:MM:SSZ` (round-trips, so `02-30` is refused). */
const UtcSecond = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((text) => {
    const ms = Date.parse(text);
    return Number.isFinite(ms) && new Date(ms).toISOString() === text.replace('Z', '.000Z');
  }, 'must be a real UTC second');

/** The policy-list `revisionWindow`: diff-check only, explicit bounds, never open-ended. */
export const RevisionWindowSchema = z
  .object({
    posture: z.literal('diff-check'),
    /** Inclusive start. */
    opens: UtcSecond,
    /** Exclusive end. */
    expires: UtcSecond,
    /** The owner ruling that authorised the window. */
    ruling: z.string().min(1),
  })
  .strict()
  .refine((w) => Date.parse(w.expires) > Date.parse(w.opens), {
    message: 'revisionWindow.expires must be after opens',
  })
  .refine((w) => Date.parse(w.expires) - Date.parse(w.opens) <= MAX_REVISION_WINDOW_DAYS * DAY_MS, {
    message: `revisionWindow may span at most ${String(MAX_REVISION_WINDOW_DAYS)} days`,
  });

/** A declared revision window, as parsed from the trust ref's policy list. */
export type RevisionWindow = z.infer<typeof RevisionWindowSchema>;

/** The posture after the window is applied, with its report lines. */
export interface EffectivePosture {
  readonly posture: ProtectedPathsPosture;
  readonly layer: ProtectedPathsConfig['layer'] | 'window';
  readonly lines: readonly string[];
}

/**
 * Apply a trust-ref revision window to a resolved posture at `nowMs`.
 *
 * Inside `[opens, expires)` a default-layer posture becomes `diff-check` at
 * the `window` layer. Everywhere else the resolved posture stands, and the
 * report says why, so a stale entry stays visible.
 */
export function applyRevisionWindow(
  config: ProtectedPathsConfig,
  window: RevisionWindow | undefined,
  nowMs: number,
): EffectivePosture {
  if (window === undefined) return { posture: config.posture, layer: config.layer, lines: [] };
  const span = `${window.opens}..${window.expires} (${window.ruling})`;
  const opens = Date.parse(window.opens);
  const expires = Date.parse(window.expires);
  const keep = (why: string): EffectivePosture => ({
    posture: config.posture,
    layer: config.layer,
    lines: [`revision window ${span}: ${why}`],
  });
  const closed = (why: string): EffectivePosture => ({
    posture: 'human',
    layer: 'default',
    lines: [`revision window ${span}: ${why} — posture human (fail closed)`],
  });
  if (config.layer !== 'default') {
    const expired = Number.isFinite(nowMs) && nowMs >= expires ? ' (expired)' : '';
    return keep(`not applied — posture set at the ${config.layer} layer${expired}`);
  }
  if (!Number.isFinite(opens) || !Number.isFinite(expires)) return closed('bounds unreadable');
  if (!Number.isFinite(nowMs)) return closed('clock unusable');
  if (nowMs < opens) return closed('not open yet');
  if (nowMs >= expires) return closed('EXPIRED');
  return {
    posture: window.posture,
    layer: 'window',
    lines: [`revision window ${span}: open — posture ${window.posture}`],
  };
}
