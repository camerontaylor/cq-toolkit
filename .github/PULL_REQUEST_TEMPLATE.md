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

- Gates before review (ratchet / lint / test / git diff --check exits):
- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time -->
- Dirty-diff identity: <!-- sha256 of `git diff --binary --full-index HEAD` after staging own new files; "clean tree" if committed -->
- Log location: <!-- saved NDJSON path, outside the repo -->
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (ratchet / lint / test / git diff --check exits):

### Cycle 2

- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time — differs from cycle 1 when fixes landed -->
- Dirty-diff identity: <!-- re-recorded after cycle-1 addressing -->
- Log location:
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (ratchet / lint / test / git diff --check exits):

## Adjudications — every critical/major; remaining minors if material

| Finding (file:line) | Severity | Disposition | Commit / reason |
|---------------------|----------|-------------|-----------------|
| | | | |

## Final gates (actual exits, final reviewed state)

- [ ] `node scripts/ratchet-typecheck.mjs` — exit 0
- [ ] `npm run lint` — exit 0
- [ ] `npm run test` — exit 0
- [ ] `git diff --check` — clean

CI on the PR: build, from-source smoke, denylist scan + self-test.

CLI cycles are author-side pre-PR evidence; the CodeRabbit App's PR review
and non-author acceptance (doctrine I2) are judged on the opened PR at its
final head.
