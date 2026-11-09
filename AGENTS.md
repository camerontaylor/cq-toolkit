# AGENTS.md

@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript
SDK of atomic code-quality operations, a deterministic plan runner, and
adoptable PR and doctrine policy templates. It is self-hosting —
the toolkit's own quality gates run on the toolkit itself.

## Gates (focused locally, full-gate authority in CI)

**Canonical contract: [docs/focused-checks-contract.md](docs/focused-checks-contract.md).**
It supersedes the old 3× full-gate rule everywhere that rule was stated.

pnpm is the package manager (`packageManager` in package.json); install
with `pnpm install`. `pnpm-workspace.yaml` enables the global virtual store,
so a warm install in a fresh worktree is a symlink pass. Paseo runs
`scripts/init-worktree.mjs` (via `paseo.json`) in every worktree it creates;
in a plain `git worktree add` worktree, run `node scripts/init-worktree.mjs`.

Your local duty, on a coherent change:

- `pnpm run check:static` — TS7 compiler ratchet plus typed Oxlint;
  `pnpm run lint` and `pnpm run typecheck` are aliases (run only one)
- `pnpm run format:check`
- `pnpm test:narrow` — the tests your diff affects, never the suite; the only
  local test command (see Local testing)
- `pnpm run knip` — whole-project, not file-scoped: run it when the diff
  touches entrypoints, exports, dependencies or configuration, adds a file,
  adds or changes an import (a new package or unresolvable specifier), or
  removes or rewires the last import of a file or package, and skip it
  otherwise (canonical condition: the contract's §1)

**Zero local full gates per PR.** Run focused checks locally; CI owns the full gates.
CI runs full TS checks on code/shared/unknown PR changes, and skips TS work
only for recognized prose/Python-only changes; formatting stays unconditional.
Python runs for Python/shared changes. Main pushes and nightly run full checks.
Required workflows keep unfiltered triggers; job selection avoids feature-push
duplicates. The merge bar remains
**green `static` and `denylist` on the exact PR head**, plus one independent
exact-head review comment, is the merge bar for PRs directly to `main`.
CRQ reviews after merge. See [merge policy](docs/promotion-policy.md).

Escalate a shared interface, dependency/tooling or config change — and any
impact you cannot classify — to the coordinator with the reason, rather than
launching a broad run yourself; broad selection is the coordinator's decision,
made after escalation (contract §2). Never alter source or baselines to hide a
failure; baselines only tighten (doctrine I5).

## Agent loop

Use `pnpm lint:fast <owned-file...>` for syntactic feedback and
`pnpm fix <owned-file...>` for safe lint fixes and formatting of those
files only (it runs no static gate and no tests; run `pnpm run check:static`
explicitly for dependents). Lists must be explicit; never format the repository per turn.
Changed-file lint does not establish correctness of dependents. `pnpm fix`
validates its list through `scripts/lib/owned-files.mjs` before any tool runs
(containment, deleted paths and the empty list: contract §3); never invoke the
leaf tools directly or without a file list.

`pnpm run check` is a composite of formatting checks, the static gate once,
the full suite and Knip; it is **not a local verification route** — it is
CI-only, like the suite (contract §1).

Any local timing cited as evidence carries a load stamp (host uptime + load
average at measurement time). Do not cite `--maxWorkers` as worker-count
tuning or as performance evidence in protocol steps or records. The runner
documentation describes its fixed setting (contract §5).

## Local testing

The only permitted local test command is `pnpm test:narrow …`. The full
suite (`pnpm run test`, `test:unit`, `test:e2e`, `check`, bare `vitest` or
`pnpm exec vitest`) is CI-only. Do not choose test files, vitest flags or
concurrency yourself (contract §2 is the selection it automates):

- `pnpm test:narrow` — the tests for your changes since the merge-base with
  `origin/main`, plus the working tree.
- `pnpm test:narrow <file...>` — named test files, or source files mapped to
  their tests. `--range <a>..<b>` selects a commit range; `--dry-run` prints
  the plan and runs nothing; `--help` lists the rest.

It re-execs under `nice -n 5`, checks MemAvailable and exits 75 immediately
below 2 GB, naming the top three memory users. Move to another host; no lock
or waiting. Tests and builds try a systemd user scope (3 GB memory, no swap,
CPUWeight50), retry without unsupported OOMScoreAdjust, and run directly
with a visible warning if scopes are unavailable. Linux children inherit
oom_score_adj500 where writable; Node uses a 2048 MB heap.
Selected dist-dependent tests rebuild dist only when stale; source-only tests
skip preparation. One serial Vitest invocation uses --maxWorkers=2 (Vitest
currently reduces serial file runs to one worker). There is no file-count cap.
Full-suite selections, watch, coverage and arbitrary Vitest flags remain
refused; integration/live suites require their include flags. Quote the final
`test:narrow result=…` line as evidence.

## GLM peak-hour blackout

> **SUSPENDED by the owner, 2026-11-02:** GLM work may run through the 14:00–18:00 SGT window.
> No pause/resume schedule is active. Do not pause or go dark for it. The text below is kept for
> when the owner reinstates it (toolkit-research `CLAUDE.md` carries the same banner).

No work on the `claude-zai` or `zcode` (Z.ai GLM) harnesses between
14:00–18:00 Asia/Singapore (UTC+8), Monday–Friday. That is Z.ai's GLM
Coding Plan peak-hour window, where quota consumption multiplies (~3×)
for flagship models. Paseo schedules `glm-peak-pause`/`glm-peak-resume`
stop GLM toolkit workers 5 minutes before the window and resume them
after it ends — don't manually restart GLM work during the blackout;
use a non-GLM provider or wait.

## Code review

CodeRabbit is advisory; handle its findings like any other review comment.
The merge bar is green `static` and `denylist` on the exact PR head plus
one independent exact-head `PASS`. Reviewer independence is between agents
or humans, not GitHub accounts. See [review guidance](docs/coderabbit-review.md).

## Doctrine

[policy/DOCTRINE.md](policy/DOCTRINE.md) is canonical: eleven behavioral
invariants. Workflow files under `.github/workflows/` are instantiated from
`policy/templates/` — never edit them directly.

Python modules in `apps/crq-python` use this same runner:
`pnpm test:narrow apps/crq-python/test_status_summary.py`. Source modules map
only to their matching `test_<module>.py`; unmapped changes and discovery-sized
selections are refused. Named modules run in one `python3 -m unittest`
invocation, serially with any selected TypeScript tests, under the same
nice priority, timeout and process-group cleanup. Local bare
unittest and discovery are prohibited; full Python discovery runs only in CI
on Python 3.14, the production minor reported by the owner.
