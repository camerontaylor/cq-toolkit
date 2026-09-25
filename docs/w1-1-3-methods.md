# W1.1 + W1.3 methods note

This note records the implementation approach for the reviewer trust set and
path-anchored review threads.

- `fetchReviewState` preserves review actor type, association, and `commit.oid`,
  and carries caller-supplied claimed paths without treating PR content as
  configuration.
- `classifyPrs` folds the latest opinion per actor under the resolved trust
  policy, requires the current head SHA, excludes the PR author and automation
  identity, and uses the D3 `merge.trustedBots` / association policy.
- `classifyThreads` blocks untrusted or unanchored input (never dispatches it to
  a fixer); automation-only skip markers are privileged. Bot-authored threads
  remain data and are not self-resolved by the fixer.
- The acceptance test set covers bot/author/stale-SHA evidence, path-anchor
  mismatch, and an untrusted review shape.
