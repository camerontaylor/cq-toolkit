// Registry seam types — re-export only (no new types): the op contract and
// registry entry live in the frozen kernel types; this module names the
// registry layer's slice of that surface.
export type { Op, OpRegistryEntry, OpResult } from '../kernel/types.js';
