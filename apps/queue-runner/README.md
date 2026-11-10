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

`apps/crq-python/ops/package-runner.py` archives a prebuilt, self-contained
production staging directory offline. It rejects links outside the staging
directory and records file digests and modes. The manifest's SHA, platform and
Node version are declarations, not proof of build provenance or native
compatibility. Creating the staging tree from locked dependencies, verifying
its pinned `fs-ext` binary on linux-x64 and Node 24, and validating the archive
before installation remain required. The packager checks the pinned version and
ELF architecture, but does not load the addon or prove its Node ABI. This
packager does not authorize cutover.

The unit-switch recovery seam retains the prior unit snapshot before fencing
and records preservation digests after draining, before installation. A
production recovery adapter must validate that record before acting, restore the exact unit and
activation state, and retain the pending intent if any step fails. Its fence
and crash behavior need proof on a disposable VM, including timer, path, direct
activation, surviving processes, and interruption at each mutation boundary.
The current CLI has no unit recovery adapter or production switch provider.
The [unit-switch design](../crq-python/ops/UNIT-SWITCH-DESIGN.md) records the
VM probe evidence and the unproven manager-restart and reboot boundaries.

On 2026-11-10 an offline packaging exercise on pluto (Linux x64, Node
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
