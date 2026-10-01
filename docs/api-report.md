# Public API report

`node scripts/api-report.mjs --draft` reads the built package exports and
their declaration files, then writes a deterministic JSON report to stdout.
Run `npm run build` first. The report lists every declared export target,
its corresponding `.d.ts` path, and a SHA-256 digest of that declaration
file. The export map scopes the report to public package entrypoints, while
the declaration digest covers their emitted type surface. It fails if a
target or declaration is missing, a target escapes the package, or an export
shape cannot be interpreted safely.

The current output is a draft, not a proposed stable API contract. Do not add
it as `baselines/api-report.json` or treat its hashes as approved. The final
baseline must be generated and reviewed only after S/J/INV/P/CFG/FG public
integrations have landed, including W3.3 and W2.2; the completion plan
explicitly delays this baseline until then. Draft mode adds
`"draft": true` and `"baselineStatus": "not-established"` to make this
state visible in machine-readable output.

Without `--draft`, the command compares the current report with
`baselines/api-report.json` and fails when that baseline is absent or differs.
An alternate baseline can be selected with `--baseline <path>`. The report
does not create or update baselines. Once the public surface is final, the
release owner should review the generated draft, establish the baseline in a
separate change, and wire this comparison into CI alongside consumer tests
against the packed tarball.

Direct tooling tests can be run without the repository's full test suite:

```sh
node --test test/api-report.test.mjs
```

The report is intentionally byte-sensitive: harmless declaration formatting
changes also change the digest. It does not normalize TypeScript types or
enumerate symbol signatures. That keeps this preparation tooling independent
of the TypeScript 7 compiler's unstable programmatic APIs; review the final
declaration files directly when establishing the baseline.

This preparation slice does not add a package script or CI wiring. It does
not exercise packed-tarball consumers or optional peer dependency variants;
those remain part of W3.1 integration.
