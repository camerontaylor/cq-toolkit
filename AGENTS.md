# AGENTS.md

@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript
SDK of atomic code-quality operations, a deterministic plan runner, and
adoptable merge-queue and doctrine policy templates. It is self-hosting —
the toolkit's own quality gates run on the toolkit itself.

## Gates (green before claiming done)

- `npm run check:static` — TS7 compiler ratchet plus typed Oxlint;
  `npm run lint` and `npm run typecheck` are aliases (run only one)
- `npm run format:check`
- `npm run test`

CI additionally runs the build, the from-source smoke plan, and the
denylist scan + self-test. Never alter source or baselines to hide a
failure; baselines only tighten (doctrine I5).

## Agent loop

Use `npm run lint:fast -- <owned-file...>` for syntactic feedback and
`npm run fix -- <owned-file...>` for safe lint fixes, formatting and the full
static gate. Lists must be explicit; never format the repository per turn.
`npm run check` runs formatting checks, the static gate once and tests.
Changed-file lint does not establish correctness of dependents.

## Code review — mandatory before every PR

Exactly TWO completed CodeRabbit CLI review-and-address cycles over the
full intended PR diff before creating a PR. Full protocol:
[docs/coderabbit-review.md](docs/coderabbit-review.md).

- Pin ONE immutable base per task: the merge-base against the task's
  EXPLICIT intended PR target (`origin/merge-queue` per documented policy;
  `origin/main` when that is the task's actual target). Never a moving
  branch, never blindly task-start HEAD when the branch carries previous
  work. Same base for both passes; record target, base, reviewed HEAD, and
  the dirty-diff identity when uncommitted work is in scope.
- A cycle counts only when the CLI exits successfully, the output ends
  with a terminal non-skipped completion, and no error/action_required
  occurred — a `complete` event alone is insufficient. Failed, skipped,
  interrupted, auth-failed, or rate-limited runs do not count: report the
  blocker — a blocker prevents opening the PR. Never replace a required
  review with another reviewer, never waive the rule, never fabricate
  results.
- Run the deterministic gates three times: before cycle 1, after cycle-1
  addressing (before cycle 2), and after cycle-2 addressing. Both cycles
  include their addressing. Whitespace/conflict-marker checks cover the
  pinned base through HEAD, staged changes, and unstaged tracked changes
  separately (commands in the protocol §5); stage your own new files first.
- Adjudicate every critical/major finding: fix the technically valid ones,
  reject false positives with concrete reasons. Minor findings only when
  materially beneficial. Record dispositions concisely.
- STOP after two completed cycles — no third loop. Significant scope change
  after reviews means a new task, not a bigger diff.
- No valid unresolved critical/major finding may coexist with a
  ready-to-merge claim. Fixes after cycle 2 require independent non-author
  review on the final PR head before that claim; passing gates alone is
  insufficient. This does not add a third CLI cycle.

The GitHub CodeRabbit App reviews the opened PR (already installed and
active on this repo). CLI cycles are the author-side pre-PR pass and stay
distinct from the PR review and from non-author acceptance (doctrine I2).

## Doctrine

[policy/DOCTRINE.md](policy/DOCTRINE.md) is canonical: eleven behavioral
invariants. Workflow files under `.github/workflows/` are instantiated from
`policy/templates/` — never edit them directly.
