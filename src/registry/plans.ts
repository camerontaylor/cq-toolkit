// Plan-discovery surface on the CLI's registry boundary.
//
// The no-logic-in-CLI lint boundary (cq/no-cli-beyond-registry-kernel) lets
// src/cli/** import the op registry (src/registry/**) and the kernel, but NOT
// src/plans/** directly. Plan exposure as subcommands (T4.3) is registry-layer
// work — discovery, not logic — so the plan registry's read-only seams are
// re-exported HERE, on the sanctioned boundary, and the CLI consumes them
// through this module. Nothing here adds behavior: `listPlans`/`getPlan` are
// the SAME bindings src/plans/registry.ts defines (default roots included), so
// the CLI, the source layout (vitest) and the built layout (dist/plans) all
// discover the identical plan set.
export { getPlan, listPlans } from '../plans/registry.js';
