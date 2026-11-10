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

`package-runner.py verify --output <archive> [--lockfile <path>]` extracts the
archive safely into a temporary directory, rejects duplicate members, hard
links, special files, symlink escapes and entries beneath non-directories, then
re-hashes every entry against the manifest. By default it loads the extracted
`fs-ext` addon in Node, proves that a second descriptor cannot take the held
flock, and runs the extracted runner entry with `tick --dry-run` (expecting its
JSON artifact and indeterminate refusal). The verifier compares the observed
Node ABI, platform, arch and `fs-ext` version with the recorded provenance.

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

Prior evidence (historical, not reusable provenance): on 2026-11-10 an offline
packaging exercise on pluto (Linux x64, Node
24.21.0, pnpm 12.8.1) used clean checkout
`4baffebd42cbe8c37d7bbdb9c143d0416aa93595`. The frozen offline install,
`fs-ext` rebuild, runner build, and offline production deploy to a separate
staging directory succeeded. The lockfile SHA-256 was
`75a1bc501a6bc22081ec1ca949f7a29d37f9598941f2486df2a792cac380c20e`.
The resulting local archive SHA-256 was
`97d6adb51b4020860d23ede0320286a3a861dc2d50682785b1d0c92dc827646a`.
After extraction, all 3,609 inventoried entries matched and Node loaded
`fs-ext` 2.1.1 and successfully performed flock and unlock. The extracted
runner refused the unimplemented tick as expected. This is evidence for that
specific build, not a reproducible-build guarantee or a cutover approval.
