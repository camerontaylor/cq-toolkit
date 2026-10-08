# Public API report

`node scripts/api-report.mjs --draft` reads the built package exports and
their declaration files, then writes a deterministic JSON report to stdout.
Run `pnpm run build` first. The report lists every declared export target,
its condition path and exact export mapping, plus the reachable relative
declaration graph and a SHA-256 digest for each file. The export map scopes
the report to public package entrypoints, while the graph includes their
re-exported declaration leaves. It fails if a target or relative declaration
is missing, a target resolves through a symlink outside the package, or an
export shape cannot be interpreted safely. An exports object whose keys are
all conditions (no leading `.`) is reported as the conditional map of the `.`
entry, matching Node's resolution.

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
pnpm exec vitest run test/api-report.test.mjs
```

Wildcard (`*`) export targets and array targets are rejected explicitly rather
than expanded. A `types` condition (a string, or a condition map matched against each runtime
branch) supplies the declaration for its sibling runtime conditions. `null`
export targets are recorded but contribute no targets.

The report is intentionally byte-sensitive: harmless declaration formatting
changes also change a digest. It does not normalize TypeScript types or
enumerate symbol signatures. It follows relative and package-local `#` declaration
imports and re-exports; declarations imported from external packages are outside this
package-local report. Review the final declaration files directly when
establishing the baseline.

This preparation slice does not add a package script or CI wiring. It does
not exercise packed-tarball consumers or optional peer dependency variants;
those remain part of W3.1 integration.
