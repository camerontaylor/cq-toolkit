Atomic op families: sweep, gates, ledger, review, merge, analyze, ratchet, pr.
Land: phases 1–2 (WS-C..G).

THE FAMILY REGISTRY CONVENTION (load-bearing for phase 3 — every lane
follows this; the central registry and the CLI discover families through it):
- Every op family exports `src/ops/<family>/registry.ts` containing
  `export const registry: OpRegistryEntry[]` — one entry per op:
  `{ name, inputSchema, importer }` where `name` is globally unique across
  ALL families, `inputSchema` is a zod schema (`.strict()`) validating the
  JSON-serializable op input before dispatch, and `importer` is a LAZY
  dynamic import resolving to the DEFAULT-exported op function:
  `async () => (await import('./<name>.js')).default` (the seam is
  `() => Promise<Op>` — the dispatcher awaits the importer and CALLS its
  result). Construction must never import an op module eagerly.
- Input schemas must NOT declare fields named `json`, `help`, or `h` — the
  CLI reserves those keys on EVERY subcommand (narration mode / help
  surface). Bare `--json`/`--help`/`-h` never reach op input; a VALUED
  reserved flag on an op subcommand (`--json=…`) is a usage error
  (exit 2), never data.
- The op module `src/ops/<family>/<name>.ts` DEFAULT-exports the op
  function (`async (input) => OpResult`).
- `OpRegistryEntry` is the FROZEN kernel type: import it from the kernel
  types (src/kernel/types.js). src/registry/types.ts only RE-EXPORTS it —
  the registry layer defines no new types.
- The family's `index.ts` is its public barrel (stubbed `export {}` by lane
  I until the owning lane populates it — the root barrel already carries one
  `export *` line per family). Star exports are COLLISION-SILENT: ESM
  silently EXCLUDES a star-exported name that collides with an explicit
  export on the root barrel or with the same name star-exported by another
  family — no error, the name just vanishes from the root barrel. Avoid
  generic names (e.g. `list`, `get`) in family barrels.
- The central aggregation (src/registry) scans the ops root at runtime —
  one level of family directories — and TOLERATES families whose
  registry.ts has not landed yet (only a not-found naming the requested
  `registry.js` itself counts as absent; a present-but-broken registry
  throws loudly), but THROWS on malformed entries (missing name, schema
  without `.parse`, non-function importer) or a duplicate op name across
  families. A registry module that LOADS cleanly but exports no `registry`
  array is NONCONFORMING, not broken: it contributes no entries and is
  surfaced via `listWithDiagnostics().skippedFamilies` (family dir names
  that contributed no entries — absent or nonconforming) instead of
  throwing; `list()` keeps returning just the entries. Results are cached
  per resolved root. Consumers reach the registry through the root barrel as
  `listOps`/`getOp` (aliased — the generic `list`/`get` names stay off the
  barrel to avoid star-export collisions with family exports) or import
  `src/registry/index.js` directly; family-facing TYPE imports come from
  the kernel types (src/kernel/types.js) or `src/registry/types.js`.

INTEGRATION NOTE (2026-09-15, PR 64): families that landed before this
convention merged are recognized under the amended rules above — gates uses
FAMILY-PREFIXED entry names ('gates.checkRunner' covering checkRunner.ts;
the completeness heuristic accepts entry names ending `.<base>`), ratchet's
registry.ts is currently a non-op metric-adapter registry (loads clean, no
`registry` array export → skipped + surfaced), and review landed helper
modules ahead of any registry.ts (tolerated-absent path, surfaced). Full
convention closure is phase-4 T4.2; lane-H ratchet ops still need
OpRegistryEntry registration, tracked as review-debt.
