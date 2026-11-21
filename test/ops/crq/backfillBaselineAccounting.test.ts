/**
 * S4 baseline accounting: the offline `crq backfill inventory --report-only`
 * replay against a pinned T0 baseline, differential with the Python oracle.
 *
 * Everything is a temporary local fixture: a real `git` repository built in a
 * temp directory, a synthetic ranked inventory and queue snapshot, and the
 * oracle's own `backfill_report.summary` over `backfill_accounting.Repository`.
 * No live queue-host state, provider, forge or network is read. The controls are a
 * baseline with changed, renamed, deleted, ambiguous and new files; the
 * no-baseline control; and malformed or unprovable baselines, which must
 * refuse (or stay visible as unresolved) exactly as Python does.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { GitAccountingRepository } from '../../../src/adapters/crq/backfillAccounting.js';
import { fileBackfillInventoryEffects } from '../../../src/adapters/crq/backfillSource.js';
import { baseline, summary } from '../../../src/policy/crq/backfillReport.js';
import { ledgerJsonBytes, ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';
import {
  runBackfillInventory,
  type BackfillInventoryEffects,
} from '../../../src/ops/crq/backfillInventory.js';
import { captureFixtureManifest, loadFamily, valueAt } from '../../policy/crq/backfillFixtures.js';
import type { JsonObject } from '../../../src/policy/crq/jsonValue.js';

const ORACLE = new URL('../../helpers/backfillBaselineOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-10-29T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-29T00:00:00Z',
};
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
  delete GIT_ENV[key];
}

const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const lines = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, index) => `${tag} line ${index + 1}\n`).join('');

class Fixture {
  readonly root: string;

  constructor() {
    const base = mkdtempSync(join(tmpdir(), 'crq-baseline-accounting-'));
    ROOTS.push(base);
    this.root = join(base, 'repo');
    mkdirSync(this.root, { recursive: true });
    this.git('init', '-q');
    this.git('config', 'user.name', 'fixture');
    this.git('config', 'user.email', 'fixture@localhost');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.root, ...args], {
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
  }

  commit(files: Record<string, string | null>): string {
    for (const [name, content] of Object.entries(files)) {
      const path = join(this.root, name);
      if (content === null) {
        unlinkSync(path);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    this.git('add', '-A');
    this.git('commit', '-qm', 'Fixture change');
    return this.git('rev-parse', 'HEAD');
  }

  blob(commit: string, name: string): string {
    return this.git('rev-parse', `${commit}:${name}`);
  }
}

interface Row {
  path: string;
  blob: string;
  tier: string;
  lines: number | null;
  uncovered: Array<[number, number]>;
  disposition: string;
  reason: string;
}

function row(
  fixture: Fixture,
  commit: string,
  path: string,
  tier: string,
  lineCount: number | null,
  uncovered: Array<[number, number]>,
  disposition = 'included',
  reason = 'counted',
): Row {
  return {
    path,
    blob: fixture.blob(commit, path),
    tier,
    lines: lineCount,
    uncovered,
    disposition,
    reason,
  };
}

function ranked(target: string, rows: Row[], evaluatedAt: string): Record<string, unknown> {
  return {
    manifest_id: 'a'.repeat(64),
    target,
    evaluated_at: evaluatedAt,
    paths: rows,
    candidates: [{ tier: 'T1' }, { tier: 'T1' }, { tier: 'T2' }],
    required: [],
    evidence_gaps: {},
  };
}

/** `a.ts` with two lines inserted on top, old L5 rewritten and old L7 removed. */
function aEdited(): string {
  const old = lines(8, 'a').split('\n').slice(0, 8);
  const kept = old.flatMap((text, index) =>
    index === 4 ? ['rewritten'] : index === 6 ? [] : [text],
  );
  return ['new top 1', 'new top 2', ...kept].map((text) => `${text}\n`).join('');
}

/**
 * Old target: five T1 files plus a T2 file. New target: `a.ts` edited in place
 * (lines shift), `move.ts` renamed unchanged, `gone.ts` deleted, `drift.ts`
 * replaced by two identical copies (an ambiguous lineage, neither provably
 * deleted nor carried), `keep.ts` untouched and `fresh.ts` newly added.
 */
function history() {
  const fixture = new Fixture();
  const drift = lines(4, 'drift');
  const old = fixture.commit({
    'a.ts': lines(8, 'a'),
    'keep.ts': lines(4, 'keep'),
    'gone.ts': lines(3, 'gone'),
    'move.ts': lines(5, 'move'),
    'drift.ts': drift,
    'binary.dat': 'opaque\n',
    'doc.md': lines(3, 'doc'),
  });
  const target = fixture.commit({
    // Two lines inserted on top, the old L5 rewritten and the old L7 removed.
    'a.ts': aEdited(),
    'gone.ts': null,
    'move.ts': null,
    'moved/move.ts': lines(5, 'move'),
    'drift.ts': null,
    'copy1.ts': drift,
    'copy2.ts': drift,
    'fresh.ts': lines(6, 'fresh'),
  });
  const oldRows = [
    row(fixture, old, 'a.ts', 'T1', 8, [
      [2, 3],
      [5, 7],
    ]),
    row(fixture, old, 'keep.ts', 'T1', 4, [[1, 4]]),
    row(fixture, old, 'gone.ts', 'T1', 3, [[1, 3]]),
    row(fixture, old, 'move.ts', 'T1', 5, [[1, 5]]),
    row(fixture, old, 'drift.ts', 'T1', 4, [[1, 2]]),
    row(fixture, old, 'binary.dat', 'T1', null, [], 'unsupported', 'binary'),
    row(fixture, old, 'doc.md', 'T2', 3, [[1, 3]]),
  ];
  const newRows = [
    // Debt on carried lines plus a fresh gap on the inserted ones: reviewed-since,
    // surviving and new debt all occur.
    row(fixture, target, 'a.ts', 'T1', 8, [
      [1, 2],
      [4, 4],
    ]),
    row(fixture, target, 'keep.ts', 'T1', 4, [[2, 3]]),
    row(fixture, target, 'moved/move.ts', 'T1', 5, [[1, 5]]),
    row(fixture, target, 'copy1.ts', 'T1', 4, [[1, 4]]),
    row(fixture, target, 'copy2.ts', 'T1', 4, [[1, 4]]),
    row(fixture, target, 'fresh.ts', 'T1', 6, [[1, 6]]),
  ];
  return { fixture, old, target, oldRows, newRows };
}

interface Report {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly value: Record<string, unknown>;
}
interface Refusal {
  readonly ok: false;
  readonly error: string;
}

function pythonSummary(
  repo: string,
  rankedValue: unknown,
  queue: unknown,
  baselineText: string | null,
): Report | Refusal {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ repo, ranked: rankedValue, queue, baseline_text: baselineText }),
    encoding: 'utf8',
    env: GIT_ENV,
  });
  const parsed = JSON.parse(stdout) as
    | { ok: true; report_b64: string }
    | { ok: false; error: string; class: string };
  if (!parsed.ok) return { ok: false, error: `${parsed.class}: ${parsed.error}` };
  const bytes = Buffer.from(parsed.report_b64, 'base64');
  return { ok: true, bytes, value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown> };
}

async function typescriptSummary(
  repo: string,
  rankedValue: unknown,
  queue: unknown,
  baselineText: string | null,
): Promise<Report | Refusal> {
  const { ledgerLoads } = await import('../../../src/policy/crq/ledger.js');
  try {
    const accounting = new GitAccountingRepository({ repo, runGit: runGitIn(repo) });
    accounting.beginInvocation();
    const report = await summary({
      ranked: ledgerLoads(ledgerJsonBytes(rankedValue)),
      queue: ledgerLoads(ledgerJsonBytes(queue)),
      ...(baselineText === null ? {} : { original: ledgerLoads(baselineText) }),
      repo: accounting,
    });
    const bytes = Buffer.from(ledgerJsonBytes(report));
    return {
      ok: true,
      bytes,
      value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function pinned(old: string, fixture: Fixture, rows: Row[], pinnedAt: string): string {
  const value = baseline({
    ranked: ranked(old, rows, pinnedAt),
    tree: fixture.git('rev-parse', `${old}^{tree}`),
    policyDigest: 'b'.repeat(64),
    ledgerHead: 'c'.repeat(40),
    at: pinnedAt,
  });
  return Buffer.from(ledgerJsonBytes(value)).toString('utf8');
}

const QUEUE = {
  items: [
    { kind: 'backfill', state: 'pending' },
    { kind: 'coverage', state: 'done' },
  ],
  backfill_daily_capacity: {
    '2026-11-01': { completed_partitions: 1 },
    '2026-11-02': { completed_partitions: 1 },
    '2026-11-03': { completed_partitions: 0 },
  },
  backfill_families: {},
  backfill_admissions: [],
};

describe('baseline accounting is differential with the Python oracle', () => {
  test('a pinned baseline with changed, moved, deleted, ambiguous and new files', async () => {
    const { fixture, old, target, oldRows, newRows } = history();
    const text = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const current = ranked(target, newRows, '2026-11-03T12:00:00Z');
    const python = pythonSummary(fixture.root, current, QUEUE, text);
    const typescript = await typescriptSummary(fixture.root, current, QUEUE, text);
    expect(python.ok).toBe(true);
    expect(typescript).toEqual(python);
    const accounted = (typescript as Report).value['baseline'] as Record<string, unknown>;
    // The controls reach every accounting branch, so a parity pass is not vacuous.
    expect(accounted['baseline_T1_removed_or_superseded']).toBeGreaterThan(0);
    expect(accounted['baseline_T1_reviewed_since']).toBeGreaterThan(0);
    expect(accounted['surviving_T1_debt']).toBeGreaterThan(0);
    expect(accounted['new_T1_debt']).toBeGreaterThan(0);
    const unresolved = accounted['unresolved_baseline_objects'] as Array<Record<string, unknown>>;
    expect(unresolved.map((entry) => entry['path']).sort()).toEqual(['binary.dat', 'drift.ts']);
    expect(accounted['target_status']).toBe('pending');
  });

  test('a baseline at least 14 days old with debt left is missed capacity', async () => {
    const { fixture, old, target, oldRows, newRows } = history();
    const text = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const current = ranked(target, newRows, '2026-11-20T00:00:00Z');
    const python = pythonSummary(fixture.root, current, QUEUE, text);
    expect(await typescriptSummary(fixture.root, current, QUEUE, text)).toEqual(python);
    expect(((python as Report).value['baseline'] as Record<string, unknown>)['target_status']).toBe(
      'missed-capacity-or-exclusions',
    );
  });

  test('a baseline whose only debt was deleted reads baseline-zero', async () => {
    const { fixture, old, target, newRows } = history();
    const text = pinned(
      old,
      fixture,
      [row(fixture, old, 'gone.ts', 'T1', 3, [[1, 3]])],
      '2026-11-01T00:00:00Z',
    );
    const current = ranked(target, newRows, '2026-11-02T00:00:00Z');
    const python = pythonSummary(fixture.root, current, QUEUE, text);
    expect(await typescriptSummary(fixture.root, current, QUEUE, text)).toEqual(python);
    const accounted = (python as Report).value['baseline'] as Record<string, unknown>;
    expect(accounted['target_status']).toBe('baseline-zero');
    expect(accounted['baseline_T1_removed_or_superseded']).toBe(3);
  });

  test('the no-baseline control reports no baseline and needs no Git', async () => {
    const { fixture, target, newRows } = history();
    const current = ranked(target, newRows, '2026-11-03T00:00:00Z');
    const python = pythonSummary(fixture.root, current, QUEUE, null);
    const typescript = await typescriptSummary(fixture.root, current, QUEUE, null);
    expect(typescript).toEqual(python);
    expect((python as Report).value['baseline']).toBeNull();
  });

  test('empty, id-less and tampered baselines refuse with the same message', async () => {
    const { fixture, old, target, oldRows, newRows } = history();
    const current = ranked(target, newRows, '2026-11-03T00:00:00Z');
    const good = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const tampered = good.replace(/"pinned_at":"[^"]*"/, '"pinned_at":"2026-11-02T00:00:00Z"');
    expect(tampered).not.toBe(good);
    for (const text of ['{}', '{"target":"x"}', tampered]) {
      const python = pythonSummary(fixture.root, current, QUEUE, text);
      const typescript = await typescriptSummary(fixture.root, current, QUEUE, text);
      expect(python.ok).toBe(false);
      expect(typescript.ok).toBe(false);
      expect((typescript as Refusal).error).toContain('baseline hash mismatch');
      expect((python as Refusal).error).toContain('baseline hash mismatch');
    }
  });

  test('a non-canonical baseline document refuses before any accounting', async () => {
    const { fixture, target, newRows } = history();
    const current = ranked(target, newRows, '2026-11-03T00:00:00Z');
    for (const text of ['{"a":1,"a":2}', '[1.5]', '{"id":']) {
      expect(pythonSummary(fixture.root, current, QUEUE, text).ok).toBe(false);
      expect((await typescriptSummary(fixture.root, current, QUEUE, text)).ok).toBe(false);
    }
  });

  test('a baseline target absent from the clone fails closed in both', async () => {
    const { fixture, target, oldRows, newRows } = history();
    const missing = 'f'.repeat(40);
    const text = (() => {
      const value = baseline({
        ranked: { ...ranked(missing, oldRows, '2026-11-01T00:00:00Z') },
        tree: '1'.repeat(40),
        policyDigest: 'b'.repeat(64),
        ledgerHead: 'c'.repeat(40),
        at: '2026-11-01T00:00:00Z',
      });
      return Buffer.from(ledgerJsonBytes(value)).toString('utf8');
    })();
    const current = ranked(target, newRows, '2026-11-03T00:00:00Z');
    const python = pythonSummary(fixture.root, current, QUEUE, text);
    const typescript = await typescriptSummary(fixture.root, current, QUEUE, text);
    // A baseline commit the clone does not hold is never reported as zero debt:
    // both fail on the Git object lookup (the wrapper text differs, the cause
    // does not), not on a digest or parse error.
    expect(python.ok).toBe(false);
    expect(typescript.ok).toBe(false);
    expect((python as Refusal).error).toContain('CalledProcessError');
    expect((python as Refusal).error).toContain(`${missing}^{commit}`);
    expect((python as Refusal).error).not.toContain('baseline hash mismatch');
    expect((typescript as Refusal).error).toContain('git rev-parse failed');
    expect((typescript as Refusal).error).toContain(`${missing}^{commit}`);
    expect((typescript as Refusal).error).not.toContain('baseline hash mismatch');
  });
});

// ---------------------------------------------------------------------------
// The route: replay a retained manifest and account a pinned baseline.

const ROLLOUT = {
  enabled: true,
  operational_ruling: 'owner ruling: replay only',
  no_live_run_verification: 'verified',
  owner_branch_ruleset_evidence: 'evidence',
  durable_artifact_root: 'state/artifacts',
  runner_identity: 'crq-runner-app',
  publisher_spool: { ssh_alias: 'publisher@spool.example', ssh_key: '~/.ssh/spool' },
};

function vectorInputs(): JsonObject {
  const vector = loadFamily('backfill-inventory')[0];
  if (vector === undefined) throw new Error('inventory vectors are empty');
  return valueAt(vector.input, 'inputs') as JsonObject;
}

describe('the report-only route accounts a pinned baseline', () => {
  /** A retained manifest retargeted at a commit the temporary clone really holds. */
  function retargeted(target: string, tree: string): Record<string, unknown> {
    const { id: _id, ...manifest } = captureFixtureManifest(vectorInputs());
    void _id;
    const moved: Record<string, unknown> = { ...manifest, target, tree };
    moved['id'] = ledgerJsonDigest(moved);
    return moved;
  }

  /** Route effects over memory, with a real clone behind `accounting`. */
  function routeEffects(options: {
    readonly baseline: string | null;
    readonly manifest: Record<string, unknown>;
    readonly clone?: string;
    readonly writes: Map<string, Buffer>;
  }): BackfillInventoryEffects {
    const inputs = vectorInputs();
    const file = fileBackfillInventoryEffects('/nonexistent-state', {
      ...(options.clone === undefined ? {} : { cloneRoot: options.clone }),
    });
    return {
      readQueue: async () => JSON.stringify({ backfill_last_manifest: options.manifest }),
      readRollout: async () => JSON.stringify(ROLLOUT),
      readBaseline: async () => options.baseline,
      ...(file.accounting === undefined ? {} : { accounting: file.accounting }),
      readTriage: async () => [],
      artifacts: () => ({
        verify: async () => undefined,
        read: async (reference) => {
          const value = inputs.get(reference.location.slice('fixture/'.length));
          if (value === undefined) throw new Error(`missing snapshot ${reference.location}`);
          return value;
        },
      }),
      writeRanked: async (bytes) => void options.writes.set('ranked', Buffer.from(bytes)),
      writeReport: async (bytes) => void options.writes.set('report', Buffer.from(bytes)),
    };
  }

  test('without a clone a present baseline is still refused and nothing is written', async () => {
    const { fixture, old, target, oldRows } = history();
    const text = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const writes = new Map<string, Buffer>();
    const manifest = retargeted(target, fixture.git('rev-parse', `${target}^{tree}`));
    const result = await runBackfillInventory(
      ['--report-only'],
      routeEffects({ baseline: text, manifest, writes }),
    );
    expect(result.exitCode).toBe(3);
    expect(writes.size).toBe(0);
  });

  test('with a clone the route ranking and baseline report match Python over the same repository', async () => {
    const { fixture, old, target, oldRows } = history();
    const text = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const manifest = retargeted(target, fixture.git('rev-parse', `${target}^{tree}`));
    const writes = new Map<string, Buffer>();
    const result = await runBackfillInventory(
      ['--report-only'],
      routeEffects({ baseline: text, manifest, clone: fixture.root, writes }),
    );
    expect(result.exitCode).toBe(0);
    const rankedValue = JSON.parse((writes.get('ranked') as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(rankedValue['target']).toBe(target);
    const python = pythonSummary(
      fixture.root,
      rankedValue,
      { backfill_last_manifest: manifest },
      text,
    );
    expect(python.ok).toBe(true);
    const routeReport = JSON.parse((writes.get('report') as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    const pythonReport = (python as Report).value;
    const accounted = routeReport['baseline'] as Record<string, unknown>;
    expect(accounted['target_status']).not.toBeUndefined();
    // Every baseline T1 row is accounted (removed, reviewed, surviving or unresolved).
    expect(accounted['unresolved_baseline_objects'] as unknown[]).not.toHaveLength(0);
    expect(routeReport['baseline']).toEqual(pythonReport['baseline']);
    expect(routeReport['tiers']).toEqual(pythonReport['tiers']);
    expect(routeReport['states']).toEqual(pythonReport['states']);
  });

  test('the file adapter begins the accounting invocation so immutable git output is cached', async () => {
    const { fixture, old, target } = history();
    const accounting = fileBackfillInventoryEffects('/nonexistent-state', {
      cloneRoot: fixture.root,
    }).accounting?.();
    if (accounting === null || accounting === undefined) throw new Error('expected a repository');
    const lineage = () =>
      (accounting as unknown as GitAccountingRepository).lineage(old, target, 'keep.ts');
    expect(await lineage()).toBe('keep.ts');
    // Hide the object store: only a memoised (begun-invocation) answer survives.
    renameSync(join(fixture.root, '.git'), join(fixture.root, '.git-hidden'));
    try {
      expect(await lineage()).toBe('keep.ts');
    } finally {
      renameSync(join(fixture.root, '.git-hidden'), join(fixture.root, '.git'));
    }
  });

  test('a no-baseline replay never consults the accounting seam', async () => {
    const { fixture, target } = history();
    const manifest = retargeted(target, fixture.git('rev-parse', `${target}^{tree}`));
    const writes = new Map<string, Buffer>();
    const effects = {
      ...routeEffects({ baseline: null, manifest, clone: fixture.root, writes }),
      accounting: () => {
        throw new Error('accounting must not be consulted without a baseline');
      },
    };
    const result = await runBackfillInventory(['--report-only'], effects);
    expect(result.exitCode).toBe(0);
    expect(writes.has('report')).toBe(true);
  });

  test('a clone that lacks the retained target fails closed with nothing written', async () => {
    const { fixture, old, oldRows } = history();
    const text = pinned(old, fixture, oldRows, '2026-11-01T00:00:00Z');
    const writes = new Map<string, Buffer>();
    const result = await runBackfillInventory(
      ['--report-only'],
      routeEffects({
        baseline: text,
        manifest: captureFixtureManifest(vectorInputs()),
        clone: fixture.root,
        writes,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(writes.size).toBe(0);
  });

  test('unparseable baselines fail closed (exit 1) and a digest mismatch refuses (exit 3)', async () => {
    const { fixture, target } = history();
    const manifest = retargeted(target, fixture.git('rev-parse', `${target}^{tree}`));
    // Python's `ledger.loads` raises on every one of these. Syntax errors reach
    // the TS route as a failed run (exit 1); the strict-ledger violations
    // (duplicate keys, floats) and a digest mismatch are typed integrity refusals
    // (exit 3). Either way nothing is written.
    const cases: Array<[string, 1 | 3]> = [
      ['{"id":', 1],
      ['{"a":1,"a":2}', 3],
      ['[1.5]', 3],
      ['{}', 3],
    ];
    for (const [text, exitCode] of cases) {
      const writes = new Map<string, Buffer>();
      const result = await runBackfillInventory(
        ['--report-only'],
        routeEffects({ baseline: text, manifest, clone: fixture.root, writes }),
      );
      expect(result.exitCode, text).toBe(exitCode);
      expect(writes.size).toBe(0);
    }
  });

  test('a baseline that is not valid UTF-8 refuses', async () => {
    const { fixture, target } = history();
    const manifest = retargeted(target, fixture.git('rev-parse', `${target}^{tree}`));
    const writes = new Map<string, Buffer>();
    const effects = {
      ...routeEffects({ baseline: null, manifest, clone: fixture.root, writes }),
      readBaseline: async () => new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    };
    const result = await runBackfillInventory(['--report-only'], effects);
    expect(result.exitCode).toBe(1);
    expect(writes.size).toBe(0);
  });
});
