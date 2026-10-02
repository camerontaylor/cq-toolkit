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

- Gates before review (focused set: static / format / affected tests / knip per its condition / diff checks — base-to-HEAD, staged, unstaged exits):
- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time -->
- Dirty-diff identity: <!-- sha256 of `git diff --binary --full-index HEAD` after staging own new files; "clean tree" if committed -->
- Log location: <!-- saved NDJSON path, outside the repo -->
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (focused set: static / format / affected tests / knip per its condition / diff checks — base-to-HEAD, staged, unstaged exits):

### Cycle 2

- Command (verbatim):
- Reviewed HEAD: <!-- sha at review time — differs from cycle 1 when fixes landed -->
- Dirty-diff identity: <!-- re-recorded after cycle-1 addressing -->
- Log location:
- Completion:
- Findings (critical / major / minor / trivial):
- Gates after addressing (focused set: static / format / affected tests / knip per its condition / diff checks — base-to-HEAD, staged, unstaged exits):

## Adjudications — every critical/major; remaining minors if material

| Finding (file:line) | Severity | Disposition | Commit / reason |
| ------------------- | -------- | ----------- | --------------- |
|                     |          |             |                 |

## Final gates (actual exits, final implementation state)

Focused set, per [docs/focused-checks-contract.md](../docs/focused-checks-contract.md) —
the static gate once (`lint`/`typecheck` are its aliases), the format check, the
affected tests, Knip under its condition, and the three diff checks:

- [ ] `npm run check:static` — exit 0 (once; `lint`/`typecheck` are aliases)
- [ ] `npm run format:check` — exit 0
- [ ] `npx vitest run <affected test files>` — exit 0, or not applicable (zero affected tests: record the determination and why the diff cannot affect any)
- [ ] `npm run knip` — exit 0, or not applicable (diff touches no entrypoints, exports, dependencies or configuration)
- [ ] `git diff --check "$BASE" HEAD` — clean (immutable base above)
- [ ] `git diff --check --cached` — clean (staged)
- [ ] `git diff --check` — clean (unstaged tracked)

No local full-suite gate: `npm run test` / `test:unit` is CI's obligation (green
required CI on the exact candidate SHA is the sole full-gate authority).

CI on the PR: the full suite, build, from-source smoke, denylist scan + self-test.

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
