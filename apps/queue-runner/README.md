# CRQ TypeScript runner

The runner entry point is `src/queue-runner/crq.ts`, built as
`dist/queue-runner/crq.js` and exposed as `crq`. Run `crq tick --dry-run` from
its state directory (containing `queue.json`) to write a unique file under
`shadow/`. The recorded plan currently covers only the queue's `last_tick`
update; it explicitly marks itself incomplete because discovery, harvest and
admission are not ported. A `runner-disabled` marker produces an empty plan.
Incomplete plans exit 1 with an indeterminate result and must not be used as
parity or C2 comparison evidence.

Other commands and live execution refuse until their Python equivalents are
ported. No heartbeat is emitted. Planners must not perform mutations themselves;
later ports must preserve the shared locking contract.

`apps/crq-python/ops/build-runner.py` is the locked build/staging route. It
requires a clean checkout whose HEAD is the requested full commit SHA and whose
`packageManager` pin is the pnpm version on PATH; it then runs
`pnpm install --frozen-lockfile --offline` with an isolated project virtual
store, `pnpm rebuild fs-ext`, `pnpm run build`, and
`pnpm deploy --prod --offline <staging>`. It re-checks HEAD, the tracked tree
and the lockfile digest before recording provenance, and it refuses to write
staging or output inside the source checkout. If the pinned pnpm reports the
known non-injected-workspace deploy error before writing to staging and offers
`--legacy`, it retries with the recorded `--legacy` command; any other failure
is not retried.

`apps/crq-python/ops/package-runner.py` archives that staging tree offline and
records a schema-2 manifest: source SHA, lockfile SHA-256, exact Node version
and ABI, pnpm version, platform, staged production dependency versions, the
built `fs-ext` version, native digest and ELF header, a canonical content
digest, and every staged path (file digests and modes, symlink targets,
directories including empty ones). It writes `<archive>.sha256` beside the
archive. Packaging cross-checks the supplied provenance against the staging
tree and the lockfile, and it refuses to overwrite an archive or sidecar.
A packager that loses the exclusive output open does not remove the winning
packager's archive or sidecar.

`package-runner.py verify --output <archive> [--lockfile <path>]` extracts the
archive safely into a temporary directory, rejects duplicate members, hard
links, special files, symlink escapes and entries beneath non-directories, then
re-hashes every entry against the manifest. By default it loads the extracted
`fs-ext` addon in Node, proves that a second descriptor cannot take the held
flock, and runs the extracted runner entry with `tick --dry-run` (expecting its
JSON artifact, exit 1, status `indeterminate`, and a non-empty detail). The
verifier compares the observed Node ABI, platform, arch and `fs-ext` version
with the recorded provenance.

Trust boundary: these are integrity records, not authenticity records. The
manifest, content digest and sidecar can be rewritten together with the
archive; verification does not prove who built the artifact or that the source
commit is genuine. There is no signature, no bit-for-bit reproducible-archive
guarantee, and no cutover authorization. The packager does not install or
compile dependencies, and this route does not switch a unit.

The unit-switch recovery seam retains the prior unit snapshot before fencing
and records preservation digests after draining, before installation. A
production recovery adapter must validate that record before acting, restore the exact unit and
activation state, and retain the pending intent if any step fails. Its fence
and crash behavior need proof on a disposable VM, including timer, path, direct
activation, surviving processes, and interruption at each mutation boundary.
The current CLI has no unit recovery adapter or production switch provider.
The [unit-switch design](../crq-python/ops/UNIT-SWITCH-DESIGN.md) records the
VM probe evidence and the unproven manager-restart and reboot boundaries.

Route evidence (2026-11-10, pluto, linux-x64, Node 24.21.0, pnpm 12.8.1):
`build-runner.py` ran from clean checkout
`c76666d0745ed619221c1ac81e50d23b2802a893` with the frozen offline route.
The source lockfile SHA-256 was
`75a1bc501a6bc22081ec1ca949f7a29d37f9598941f2486df2a792cac380c20e`.
The recorded provenance names Node v24.21.0, ABI 137, linux-x64, pnpm 12.8.1,
a project virtual store, and the twelve staged production dependencies,
including `fs-ext` 2.1.1 with native SHA-256
`e4e80b814d406c828510c55eca152e2bc688195d6febb025ce8e9be683ac9213`.
The archive SHA-256 was
`4f7cd2bc70088c5cfe561f94e2dd7f0458f85b04e9905cb6127aaea0b0df40a1`;
the canonical content SHA-256 was
`f9cc74b9976d97a7f771184fb226958e7e996a879fd8a13e8a153602ad9757f2`;
and the manifest inventoried 4,047 paths. An independent
`package-runner.py verify` re-extracted the archive, matched every entry,
loaded `fs-ext` 2.1.1, proved flock contention, and observed the runner's
indeterminate `tick --dry-run` refusal (exit 1).

The verifier at `b99837295838053cf53e4ac6619ecfedd80f6ac5` re-verified that
same preserved archive: the archive and content digests and all 4,047 paths
matched, `fs-ext` 2.1.1 flock contention held, and the runner returned exit 1,
status `indeterminate`, and the incomplete-plan detail. A negative run with a
fake Node that emitted valid `fs-ext` JSON but exited 0 with status `success`
failed at the smoke check with `runner smoke expected exit 1, got 0`, so a
failed or regressed runner cannot pass verification.

Evidence is preserved outside the code worktree at
`~/crq-artifact-runs/c76666d07/` on pluto: the archive, sidecar,
provenance file, build report, independent verification report, and staging
tree, plus the exact-head re-verification and negative reports. This is
reusable route evidence, not a bit-for-bit reproducible-build guarantee or a
cutover approval. The earlier `4baffebd` one-off is superseded and was never
reusable provenance.
