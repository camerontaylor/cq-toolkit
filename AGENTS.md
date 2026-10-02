# AGENTS.md

@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript
SDK of atomic code-quality operations, a deterministic plan runner, and
adoptable merge-queue and doctrine policy templates. It is self-hosting —
the toolkit's own quality gates run on the toolkit itself.

## Gates (focused locally, full-gate authority in CI)

**Canonical contract: [docs/focused-checks-contract.md](docs/focused-checks-contract.md).**
It supersedes the old 3× full-gate rule everywhere that rule was stated.

Your local duty, on a coherent change:

- `npm run check:static` — TS7 compiler ratchet plus typed Oxlint;
  `npm run lint` and `npm run typecheck` are aliases (run only one)
- `npm run format:check`
- `npx vitest run <affected test files>` — the tests your diff affects, not
  the suite
- `npm run knip` when entrypoints, exports, dependencies or config change

**Zero local full gates per PR.** No protocol step runs a local full
`npm run test` / `test:unit`, and a clean review adds no deterministic run.
The full suite — plus the build, the from-source smoke plan, the coverage
ratchet and the denylist scan + self-test — runs in required CI on every
push/PR, and **green required CI on the exact candidate SHA** (the
`merge-queue` commit the promotion gate resolves) is the sole full-gate
authority. A green PR head is not candidate evidence: required status checks
are not strict (`policy/templates/github-settings.json`), so a head can be
green while stale against its base. Local full runs remain legal as
coordinator-owned diagnostics or rollback evidence, recorded as such.

Escalate a shared interface, dependency/tooling or config change — or any
uncertain impact — to the coordinator with the reason, rather than launching a
broad run yourself. Never alter source or baselines to hide a failure;
baselines only tighten (doctrine I5).

## Agent loop

Use `npm run lint:fast -- <owned-file...>` for syntactic feedback. Lists must
be explicit; never format the repository per turn. Changed-file lint does not
establish correctness of dependents.

`npm run fix -- <owned-file...>` is **not** file-scoped: it always ends with
the full project static gate (`scripts/fix.mjs`), even for a deleted-only
list. For per-file fixes use the leaf tools on an explicit list:
`npx oxlint --config .oxlintrc.json --disable-nested-config --fix <files>`,
then `npx oxfmt <files>` (`npx oxfmt --check <files>` to verify). `npm run
check` is a composite — formatting, static gate, the full suite and Knip — and
its full-suite leg belongs to CI.

Any local timing cited as evidence carries a load stamp (host uptime + load
average at measurement time), and no protocol or record cites `--maxWorkers`:
`vitest.config.ts` sets `fileParallelism: false`, which makes it a no-op.

## GLM peak-hour blackout

No work on the `claude-zai` or `zcode` (Z.ai GLM) harnesses between
14:00–18:00 Asia/Singapore (UTC+8), Monday–Friday. That is Z.ai's GLM
Coding Plan peak-hour window, where quota consumption multiplies (~3×)
for flagship models. Paseo schedules `glm-peak-pause`/`glm-peak-resume`
stop GLM toolkit workers 5 minutes before the window and resume them
after it ends — don't manually restart GLM work during the blackout;
use a non-GLM provider or wait.

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
  include their addressing. Those gates are the cheap deterministic ones plus
  the affected tests — `npm run test` is CI's (see
  [docs/focused-checks-contract.md](docs/focused-checks-contract.md)).
  Whitespace/conflict-marker checks cover the pinned base through HEAD,
  staged changes, and unstaged tracked changes separately (commands in the
  protocol §5); stage your own new files first.
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
Reviewer independence is between agents or humans, not GitHub accounts. An
independent reviewer agent may share the author's GitHub account using the
enabled exact-head attestation path documented in the policy templates.

## Doctrine

[policy/DOCTRINE.md](policy/DOCTRINE.md) is canonical: eleven behavioral
invariants. Workflow files under `.github/workflows/` are instantiated from
`policy/templates/` — never edit them directly.
