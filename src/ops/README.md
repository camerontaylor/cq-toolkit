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
- The op module `src/ops/<family>/<name>.ts` DEFAULT-exports the op
  function (`async (input) => OpResult`).
- `OpRegistryEntry` is the FROZEN kernel type: import it from the kernel
  types (src/kernel/types.js). src/registry/types.ts only RE-EXPORTS it —
  the registry layer defines no new types.
- The family's `index.ts` is its public barrel (stubbed `export {}` by lane
  I until the owning lane populates it — the root barrel already carries one
  `export *` line per family).
- The central aggregation (src/registry) scans the ops root at runtime —
  one level of family directories — and TOLERATES families whose
  registry.ts has not landed yet (the import rejection simply contributes
  no entries), but THROWS on malformed entries (non-array registry export,
  missing name, schema without `.parse`, non-function importer) or a
  duplicate op name across families. Results are cached per resolved root.
