## Summary

<!-- what this PR does and why -->

## Scope (shared across cycles)

- Intended PR target: <!-- merge-queue (documented queue flow) or main — this task's actual target; state which -->
- Base (immutable): <!-- merge-base sha vs the intended target; the SAME base for both cycles -->

## CodeRabbit CLI cycles — both required, each including addressing ([docs/coderabbit-review.md](../docs/coderabbit-review.md))

A cycle counts only when the CLI exits successfully, the stream ends with a
terminal non-skipped completion, and no error/action_required occurred.
Failed/skipped/interrupted/auth/rate-limited runs do not count; a blocker
prevents opening the PR.

### Cycle 1

- Gates before review (ratchet / lint / test / diff checks: base-to-HEAD, staged, unstaged exits):
- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time -->
- Dirty-diff identity: <!-- sha256 of `git diff --binary --full-index HEAD` after staging own new files; "clean tree" if committed -->
- Log location: <!-- saved NDJSON path, outside the repo -->
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (ratchet / lint / test / diff checks: base-to-HEAD, staged, unstaged exits):

### Cycle 2

- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time — differs from cycle 1 when fixes landed -->
- Dirty-diff identity: <!-- re-recorded after cycle-1 addressing -->
- Log location:
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (ratchet / lint / test / diff checks: base-to-HEAD, staged, unstaged exits):

## Adjudications — every critical/major; remaining minors if material

| Finding (file:line) | Severity | Disposition | Commit / reason |
| ------------------- | -------- | ----------- | --------------- |
|                     |          |             |                 |

## Final gates (actual exits, final implementation state)

- [ ] `node scripts/ratchet-typecheck.mjs` — exit 0
- [ ] `npm run lint` — exit 0
- [ ] `npm run test` — exit 0
- [ ] `git diff --check "$BASE" HEAD` — clean (immutable base above)
- [ ] `git diff --check --cached` — clean (staged)
- [ ] `git diff --check` — clean (unstaged tracked)

CI on the PR: build, from-source smoke, denylist scan + self-test.

CLI cycles are author-side pre-PR evidence; the CodeRabbit App's PR review
and non-author acceptance (doctrine I2) are judged on the opened PR at its
final head.

## Final-head acceptance (pending until PR review)

- [ ] Non-author review covers the final PR head, including cycle-2 and PR-feedback fixes.
- Final HEAD SHA:
- Reviewer and review evidence link: <!-- pending when opening the PR -->
- I2 acceptance: <!-- explicit all-clear after this commit, or at least 10 minutes settled since it; record evidence -->
- [ ] All external review threads addressed; complete paginated review data checked.

Passing gates and completed CLI cycles alone do not complete this section.
Reset this evidence after any further commit; earlier-head reviews do not qualify.
