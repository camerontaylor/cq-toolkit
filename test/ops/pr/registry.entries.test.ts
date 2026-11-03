// PR family registry slice tests (goal D3) — the `pr.assemblePrs` and
// `pr.runReport` entries (src/ops/pr/registry.ts), mirroring the
// review/sweep family registry-surface pins:
//   1. Name — the family carries exactly the two D3 ops, each named
//      `<family>.<module base>` so the central completeness heuristic's
//      family-prefixed rule covers the module.
//   2. Schema accepts a minimal valid input for each op (the same JSON a
//      dispatcher would send) and rejects unknown keys (strict throughout).
//   3. THE PREFIX REFINEMENTS: a tracker.branch or packages[].branch
//      outside `<runPrefix>/` fails schema validation (exit-2 class at the
//      CLI boundary, before any op runs).
//   4. The importer RESOLVES to an op WITHOUT env/network/filesystem
//      contact: the binding constructs makeSubprocessPrEffects, which is
//      closure-only at construction (execFile spawns only when an effect is
//      CALLED). The op is then CALLED once with a boundary-failing input
//      (required field deleted → `failed` before any effect), proving the
//      promise contract hermetically; no dispatch that would run gh ever
//      happens (runReport's one real dispatch below is the empty-fleet,
//      no-tracker input whose execution performs zero gh calls).
// Plus the real gh adapter's pure parsers, fixture-tested against captured
// gh JSON shapes (they live in this family's registry-surface suite, now
// spread across registry.entries, registry.prefix, registry.prList,
// registry.checks, registry.meta, registry.composeSection, registry.faults,
// registry.createPr and registry.searchPrByHead, because the adapter is the
// importer's binding):
// parsePrList, parseCreatedPr, checksOfRollup, reviewStateOfDecision, and
// the mapGhFault taxonomy.
// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the registry-entry contract (pr family registry entries).
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/pr/registry.js';
import {
  assembleInput,
  ENTRY_NAMES,
  ensureTrackerBranchInput,
  entryByName,
  firstPackageOf,
  minimalInput,
} from './registry.helpers.js';

// ---------------------------------------------------------------------------
// Per-entry contract: name, accept, reject, resolve
// ---------------------------------------------------------------------------

describe('pr family registry entries', () => {
  test('the family carries exactly the D3 entries plus the #173 tracker-branch leg', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([...ENTRY_NAMES].sort());
  });

  test.each(ENTRY_NAMES)('%s: inputSchema accepts a minimal valid input', (name) => {
    expect(entryByName(name).inputSchema.safeParse(minimalInput(name)).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: inputSchema rejects an unknown key', (name) => {
    const input = { ...minimalInput(name), extra: 1 };
    expect(entryByName(name).inputSchema.safeParse(input).success).toBe(false);
  });

  test('ensureTrackerBranch: a branch outside the run prefix is rejected', () => {
    const schema = entryByName('pr.ensureTrackerBranch').inputSchema;
    expect(
      schema.safeParse({ ...ensureTrackerBranchInput(), branch: 'other/tracker' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...ensureTrackerBranchInput(), branch: 'cq/09-16a/tracker' }).success,
    ).toBe(true);
  });

  test('assemblePrs: an unknown key INSIDE a package is rejected too (strict throughout)', () => {
    const input = assembleInput();
    firstPackageOf(input)['surprise'] = true;
    expect(entryByName('pr.assemblePrs').inputSchema.safeParse(input).success).toBe(false);
  });

  test.each(ENTRY_NAMES)(
    '%s: importer resolves to an op; calling it returns the OpResult promise',
    async (name) => {
      // Resolving constructs makeSubprocessPrEffects — closure-only, inert:
      // execFile spawns only when an effect is CALLED, so resolution touches
      // no env, network, or filesystem. The op IS called, but with an input
      // that fails the boundary contract FIRST (repoRoot deleted — the first
      // field both ops' inputFaultOf checks), so the promise contract is
      // proven with ZERO gh calls: an Op invocation returns a thenable that
      // resolves to a `failed` OpResult — never a thrown error, never a
      // synchronous value. (The implementation-detail constructor name is
      // deliberately not asserted — the CONTRACT is the promise.)
      const op = (await entryByName(name).importer()) as (i: unknown) => Promise<unknown>;
      expect(typeof op).toBe('function');
      const badInput: Record<string, unknown> = { ...minimalInput(name) };
      delete badInput['repoRoot'];
      const pending = op(badInput);
      expect(typeof (pending as { then?: unknown }).then).toBe('function');
      const result = (await pending) as { status: string };
      expect(result.status).toBe('failed');
    },
  );

  test('assemblePrs refuses unreadable cq.json, while absent and configured policies stay active', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-config-read-'));
    const binDir = join(scratch, 'bin');
    await mkdir(binDir, { recursive: true });
    const ghPath = join(binDir, 'gh');
    const gitleaksPath = join(binDir, 'gitleaks');
    const ghLog = join(scratch, 'gh.log');
    await writeFile(
      ghPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "$CQ_REGISTRY_GH_LOG"`,
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.test/owner/repo/pull/42"; exit 0; fi',
        'echo "{}"',
        '',
      ].join('\n'),
    );
    await writeFile(
      gitleaksPath,
      [
        '#!/bin/sh',
        'report=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--report-path" ]; then report="$2"; shift; fi',
        '  shift',
        'done',
        'printf "[]\\n" > "$report"',
        '',
      ].join('\n'),
    );
    await chmod(ghPath, 0o755);
    await chmod(gitleaksPath, 0o755);
    const previousPath = process.env['PATH'];
    const previousLog = process.env['CQ_REGISTRY_GH_LOG'];
    process.env['PATH'] = `${binDir}:${previousPath ?? ''}`;
    process.env['CQ_REGISTRY_GH_LOG'] = ghLog;

    const run = async (repoRoot: string, title: string) => {
      await writeFile(ghLog, '');
      const importer = await entryByName('pr.assemblePrs').importer();
      return (importer as (input: unknown) => Promise<{ status: string; error?: string }>)({
        repoRoot,
        runPrefix: 'cq/09-16a',
        base: 'origin/merge-queue',
        tracker: { title, branch: 'cq/09-16a/tracker' },
        packages: [],
      });
    };

    try {
      const unreadableRepo = join(scratch, 'unreadable');
      await mkdir(unreadableRepo, { recursive: true });
      await mkdir(join(unreadableRepo, 'cq.json'));
      const unreadable = await run(unreadableRepo, 'ordinary tracker');
      expect(unreadable.status).toBe('failed');
      expect(unreadable.error).toMatch(/unable to read cq\.json \(EISDIR\)/);
      expect(await readFile(ghLog, 'utf8')).toBe('');

      const absentRepo = join(scratch, 'absent');
      await mkdir(absentRepo, { recursive: true });
      const absent = await run(absentRepo, 'ordinary tracker');
      expect(absent.status).toBe('failed'); // the fake gh stops after the tracker create
      expect(await readFile(ghLog, 'utf8')).toMatch(/pr create/);

      const configuredRepo = join(scratch, 'configured');
      await mkdir(join(configuredRepo, 'custom'), { recursive: true });
      await writeFile(
        join(configuredRepo, 'cq.json'),
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { denylistPatternsFile: 'custom/patterns.yml' },
        }),
      );
      await writeFile(
        join(configuredRepo, 'custom/patterns.yml'),
        "rules:\n  - id: class:project-policy\n    description: project fixture\n    regex: 'BLOCKED_BY_PROJECT_POLICY'\n    sample: 'BLOCKED_BY_PROJECT_POLICY'\nclean_probes:\n  - 'safe'\n",
      );
      const configured = await run(configuredRepo, 'BLOCKED_BY_PROJECT_POLICY');
      expect(configured.status).toBe('failed');
      expect(configured.error).toContain('class:project-policy');
      const configuredCalls = await readFile(ghLog, 'utf8');
      expect(configuredCalls).toMatch(/pr list/);
      expect(configuredCalls).not.toMatch(/pr create|pr edit/);
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      if (previousLog === undefined) delete process.env['CQ_REGISTRY_GH_LOG'];
      else process.env['CQ_REGISTRY_GH_LOG'] = previousLog;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('runReport dispatched through the full registry wiring over an empty fleet performs ZERO gh calls', async () => {
    // The one hermetic dispatch: empty packages + no tracker → the loop
    // never runs and no tracker edit exists, so the wiring is exercised
    // end-to-end without a single gh invocation.
    const op = await entryByName('pr.runReport').importer();
    const result = (await (
      op as (i: unknown) => Promise<{ status: string; value?: { trackerUpdated: boolean } }>
    )({ repoRoot: '/repo', runPrefix: 'cq/09-16a', packages: [] })) as {
      status: string;
      value?: { trackerUpdated: boolean };
    };
    expect(result.status).toBe('ok');
    expect(result.value).toEqual({
      runPrefix: 'cq/09-16a',
      rows: [],
      counts: { ready: 0, blocked: 0, unknown: 0 },
      trackerUpdated: false,
    });
  });
});
