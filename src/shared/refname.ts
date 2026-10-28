/**
 * The ONE canonical git-branch grammar in this repo.
 *
 * This module is deliberately a zero-import leaf. Two consumers must agree on the
 * same rules and neither may host them: the dev ledger's branch-path validator
 * (`ops/dev/record.ts`) and the queue wire/origin schemas
 * (`ops/review/internal/queueProtocol.ts`, `ops/dev/internal/deferredReview.ts`).
 * Putting the grammar in `record.ts` would close a REAL runtime cycle —
 * `queueProtocol -> record -> deferredReview -> queueProtocol` — and
 * `deferredReview` reads `QueueToken` at module-evaluation time, so the cycle would
 * surface as a TDZ `ReferenceError` in one evaluation order and not the other.
 *
 * A branch name is joined into a path under `.cq/dev/` and carried as a deferred
 * target, so it must satisfy both git's refname rules and path safety:
 *
 * - non-empty, and not the single character `@`;
 * - no leading or trailing `/`, and no empty component (`//`);
 * - no C0 control character (0x00–0x1F) and no DEL (0x7F);
 * - no space, and none of `~ ^ : ? * [ ] \`;
 * - no `..` anywhere, and no `@{`;
 * - no trailing `.`, no component ending in `.lock`, no component starting `.`.
 *
 * No length cap lives here on purpose. The queue wire bound (8192 bytes) is the
 * ceiling for a transported target and the dev ledger's file name is bounded
 * separately by `encodeBranchForFilename`; an arbitrary numeric cap here would be
 * a second, unexplained rule.
 */
export function branchPathFault(branch: string): string | null {
  if (branch === '' || branch.startsWith('/') || branch.endsWith('/')) {
    return `branch '${branch}' must be a non-empty relative refname`;
  }
  if (branch === '@') return `branch '${branch}' is the single character '@'`;
  // Written as an explicit code-point test: a control-character regex literal is
  // what eslint(no-control-regex) forbids, and suppressing that rule here would
  // hide the intent instead of stating it.
  for (const char of branch) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return `branch '${branch}' contains a control character`;
  }
  if (branch.endsWith('.')) return `branch '${branch}' must not end with '.'`;
  if (branch.includes('@{')) return `branch '${branch}' contains the forbidden '@{' sequence`;
  for (const segment of branch.split('/')) {
    if (
      segment === '' ||
      segment.startsWith('.') ||
      segment.endsWith('.lock') ||
      segment.includes('..') ||
      /[\s~^:?*[\]\\]/.test(segment)
    ) {
      return `branch '${branch}' is not a path-safe refname (segment '${segment}')`;
    }
  }
  return null;
}
