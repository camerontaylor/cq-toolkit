@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript SDK of atomic code-quality operations, a deterministic plan runner that composes those operations into reproducible execution plans, and adoptable merge-queue and doctrine policy templates that other repositories can take in whole or in part. It is greenfield and self-hosting — the toolkit's own quality gates run on the toolkit itself — and it is a work in progress.
doctrine: see [policy/DOCTRINE.md](policy/DOCTRINE.md)

## Self-hosting

Stage 1 reached: CI runs the toolkit from source. The `from-source` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the package and drives a real governed plan through the built barrel (`scripts/smoke-run-plan.mjs` — two jobs, subprocess driver, journal + report + I1 output contract asserted), and the [pack audit](.github/workflows/pack-audit.yml) tarballs the package, asserts every shipped path hangs off the `files` allowlist, and denylist-scans the unpacked tree. Run URLs: visible on the Actions tab after this merge.
