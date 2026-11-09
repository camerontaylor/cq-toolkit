# CRQ TypeScript runner

The runner entry point is `src/queue-runner/crq.ts`, built as
`dist/queue-runner/crq.js` and exposed as `crq`. Commands currently refuse
execution until their Python equivalents are ported. No heartbeat is emitted.

The runner's planning seam records intended mutations under `shadow/<tick>.json`
in dry-run mode. Planners must not perform mutations themselves; live execution
is deliberately unavailable in the skeleton. Later ports must supply the state
root and a unique tick identifier and preserve the shared locking contract.

`apps/crq-python/ops/package-runner.py` archives a prebuilt, self-contained
production staging directory offline. It rejects links outside the staging
directory and records file digests and modes. The manifest's SHA, platform and
Node version are declarations, not proof of build provenance or native
compatibility. Creating the staging tree from locked dependencies, verifying
its pinned `fs-ext` binary on linux-x64 and Node 24, and validating the archive
before installation remain required. The packager checks the pinned version and
ELF architecture, but does not load the addon or prove its Node ABI. This
packager does not authorize cutover.

The unit-switch recovery seam retains the prior snapshot and preservation
digests in the controller journal before mutation. A production recovery
adapter must validate that record before acting, restore the exact unit and
activation state, and retain the pending intent if any step fails. Its fence
and crash behavior need proof on a disposable VM, including timer, path, direct
activation, surviving processes, and interruption at each mutation boundary.
The current CLI has no unit recovery adapter or production switch provider.
