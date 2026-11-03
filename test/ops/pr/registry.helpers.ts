// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus this shared fixture module.
// Shared fixtures for the pr family registry slice tests — no tests and no
// `describe` blocks live here.
import { registry } from '../../../src/ops/pr/registry.js';

export const ENTRY_NAMES = ['pr.ensureTrackerBranch', 'pr.assemblePrs', 'pr.runReport', 'pr.open'];

export const entryByName = (name: string) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing registry entry '${name}'`);
  return entry;
};

// ---------------------------------------------------------------------------
// Minimal valid inputs (the JSON a dispatcher would send)
// ---------------------------------------------------------------------------

export const assembleInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  base: 'origin/merge-queue',
  tracker: { title: 'Fleet run cq/09-16a', branch: 'cq/09-16a/tracker' },
  packages: [{ name: 'core', branch: 'cq/09-16a/fix/core', title: 'core fixes' }],
});

export const reportInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  tracker: { number: 7 },
  packages: [
    { name: 'core', number: 11 },
    { name: 'util', number: 12 },
  ],
});

export const ensureTrackerBranchInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  base: 'origin/merge-queue',
  branch: 'cq/09-16a/tracker',
});

// pr.open (strategy §3 lane 1): opens the PR FROM the readiness record; the
// minimal input is the repo root alone (target/title/draft all optional).
export const openPrInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
});

const minimalInputs: Record<string, () => Record<string, unknown>> = {
  'pr.ensureTrackerBranch': ensureTrackerBranchInput,
  'pr.assemblePrs': assembleInput,
  'pr.runReport': reportInput,
  'pr.open': openPrInput,
};

/** The minimal input fixture for one entry, failing loud when the name is unknown. */
export const minimalInput = (name: string): Record<string, unknown> => {
  const make = minimalInputs[name];
  if (make === undefined) throw new Error(`no minimal input fixture for '${name}'`);
  return make();
};

/** The first package entry of a fixture, failing loud on a fixture bug (noUncheckedIndexedAccess). */
export const firstPackageOf = (input: Record<string, unknown>): Record<string, unknown> => {
  const pkg = (input['packages'] as Array<Record<string, unknown>>)[0];
  if (pkg === undefined) throw new Error('fixture bug: no package entry');
  return pkg;
};
