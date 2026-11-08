// Value vocabularies shared by the env registry and the runtime readers that
// enforce them (protected-paths posture, merge trust lists). They live here so
// src/config sits below src/ops and src/selfhost in the layering.

/**
 * The D11 protected-paths posture. `human`: every protected-path change needs
 * a human. `diff-check`: only unexpected edits do. `advisory`: only
 * privileged-path, baseline-loosened, target-removed and entry-removed
 * findings do.
 */
export type ProtectedPathsPosture = 'human' | 'diff-check' | 'advisory';

/** Every accepted posture value, in the error-message order. */
export const PROTECTED_PATHS_POSTURES: readonly ProtectedPathsPosture[] = Object.freeze([
  'human',
  'diff-check',
  'advisory',
]);

export const POSTURE_LIST = "'human', 'diff-check' or 'advisory'";

export const isPosture = (raw: string): raw is ProtectedPathsPosture =>
  (PROTECTED_PATHS_POSTURES as readonly string[]).includes(raw);

/** A GitHub login, optionally `[bot]`-suffixed: the only bot entry shape accepted. */
export const BOT_ENTRY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
export const ACCEPT_STATES: readonly string[] = Object.freeze(['APPROVED', 'COMMENTED']);
export const ASSOCIATIONS: readonly string[] = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Exactly one leading `refs/heads/` is stripped, nothing else: a branch
 * literally named `heads/x` is `refs/heads/heads/x`, never `x`. Normalise a
 * configured or supplied branch exactly once with this.
 */
export function stripRefsHeads(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Tolerant head-ref comparison form (`refs/heads/x` or `heads/x` -> `x`); never for configured values. */
export function bareBranch(ref: string): string {
  return ref.replace(/^(?:refs\/)?heads\//, '');
}
