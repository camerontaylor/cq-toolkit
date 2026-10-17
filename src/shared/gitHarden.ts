// Hardened git command-line constants shared by every caller that spawns git
// over an UNTRUSTED tree (migration Phase 1.3: moved here from
// src/ops/ratchet/git.ts so the analyzer and other ops no longer reach into
// the ratchet family for them).
//
//   - {@link GIT_HARDEN} prefixes every call (the #221 closed-form design
//     note): `--no-pager` (a configured pager is a program), `--literal-
//     pathspecs` (a pathspec is a path, never `:(glob)`/`:(exclude)` magic),
//     `core.fsmonitor=false` (a configured fsmonitor is a HOOK git would run
//     on any index read), `core.quotePath=true` (one pinned quoting form).
//   - Diffs carry W1.8's hardened flags ({@link HARDENED_DIFF_FLAGS}): no
//     external diff driver, no textconv (both are repository-configured
//     programs), no rename folding (a rename is reported as delete + add so
//     both sides are judged), fixed a/ b/ prefixes (overrides
//     diff.mnemonicPrefix/diff.noprefix), and additionally no colour and no
//     diff.relative (config that would otherwise reshape the patch text).

/** Global options prefixed to every git invocation (#221 closed-form hardening). */
export const GIT_HARDEN: readonly string[] = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=true',
];

/**
 * Diff flags for every hardened diff: W1.8's hardened set (text, no
 * external driver, no textconv, no renames, pinned prefixes) plus `--no-color`
 * and `--no-relative`, which pin repository config (`color.diff=always`,
 * `diff.relative=true`) that would otherwise reshape the patch text a parser
 * consumes.
 */
export const HARDENED_DIFF_FLAGS: readonly string[] = [
  '--text',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-color',
  '--no-relative',
];
