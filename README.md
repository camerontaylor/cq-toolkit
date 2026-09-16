@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript SDK of atomic code-quality operations, a deterministic plan runner that composes those operations into reproducible execution plans, and adoptable merge-queue and doctrine policy templates that other repositories can take in whole or in part. It is greenfield and self-hosting — the toolkit's own quality gates run on the toolkit itself — and it is a work in progress.
doctrine: see [policy/DOCTRINE.md](policy/DOCTRINE.md)
review protocol (two CodeRabbit CLI cycles before every PR): see [docs/coderabbit-review.md](docs/coderabbit-review.md)

## Self-hosting

Stage 1 reached: CI runs the toolkit from source. The `from-source` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the package and drives a real governed plan through the built barrel (`scripts/smoke-run-plan.mjs` — two jobs, subprocess driver, journal + report + I1 output contract asserted), and the [pack audit](.github/workflows/pack-audit.yml) tarballs the package, asserts every shipped path hangs off the `files` allowlist, and denylist-scans the unpacked tree. Run URLs: visible on the Actions tab after this merge.

## Local verification

Run `npm run check:static` for the TS7 compiler ratchet and typed Oxlint.
`npm run lint` and `npm run typecheck` are compatibility aliases; run only one.
Formatting is `npm run format:check`, runtime tests are `npm run test`, and
checked declaration emit is `npm run build`. See [the local static policy](lint/README.md)
for tool pins, architecture conformance and the integrated-checker fallback.

### Mechanical checks

Use `npm run check` for read-only formatting, static checks and tests. `lint` and
`typecheck` are compatibility aliases of `check:static`; run only one.
For an inner loop, pass explicit owned files to `npm run lint:fast -- <file...>`
or `npm run fix -- <file...>`. The latter applies safe lint fixes and formatting,
then checks the whole package. Build, smoke and denylist remain separate gates.
See [local static policy](lint/README.md) for pins, compiler fallback evidence,
rule decisions and compatibility changes.
