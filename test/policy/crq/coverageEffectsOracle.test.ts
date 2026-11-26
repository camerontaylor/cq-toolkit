import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  coverageCandidate,
  legacyOrigins,
  legacyRetryView,
} from '../../../src/policy/crq/coverageLegacy.js';
import { PyError, compareCodePoints, pyIndex } from '../../../src/policy/crq/pyCompat.js';
import { measureMerged, type MeasureGit } from '../../../src/queue-runner/measureMerged.js';

/**
 * Replays the Python 3.14 oracle (apps/crq-python/coverage_effects_vectors.py):
 * `coverage._legacy_origins`, `legacy_retry_view`, `coverage_candidate` and
 * `crq.measure_merged`. A raised exception compares by class always and by
 * message for the classes whose text the port reproduces exactly; TypeError
 * and AttributeError text is CPython's wording and is not compared.
 */

/** The oracle's spec shapes, loosely typed: the fixture is trusted generator output. */
interface Repo {
  fail: string[];
  merge_sha: string;
  default_ref_sha: string;
  pr_commits: string[];
  raw: Record<string, string | undefined>;
  renames: string[][];
  namestatus: string[][];
  numstat: string[][];
  synth: Record<string, string>;
  blame: Record<string, string[] | undefined>;
  exists: Record<string, boolean>;
}
interface Spec {
  fn: string;
  queue: unknown;
  item: unknown;
  reviewed?: unknown;
  pr: unknown;
  path: unknown;
  at: unknown;
  ledger: unknown;
  params: {
    merge_queue_sha: string;
    ordinary_eligible: boolean;
    now: unknown;
    max_paths?: unknown;
    min_age_hours?: unknown;
    excluded_paths?: unknown;
  };
  repo: Repo;
  config: { merged_min_file_focus?: number };
  target: string | null;
}

interface Case {
  name: string;
  spec: Spec;
  result: { ok?: unknown; raises?: string; message?: string; calls?: string[][] };
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-coverage-effects/cases.json', import.meta.url),
    'utf8',
  ),
) as { schema: string; cases: Case[] };

const MESSAGE_CHECKED = new Set(['ValueError', 'KeyError', 'IndexError', 'RuntimeError']);

/** The fixture's repository model, answered like the generator's `Recorder`. */
class Recorder implements MeasureGit {
  readonly calls: string[][] = [];
  constructor(private readonly m: Repo) {}

  private rows(rows: string[][]): string {
    return rows.map((r) => r.join('\t')).join('\n');
  }

  async git(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const m = this.m;
    if (m.fail.includes(args[0] as string))
      throw new PyError('RuntimeError', `git ${args[0]} failed`);
    if (args[0] === 'rev-parse') return args[1] !== m.merge_sha ? m.default_ref_sha : m.merge_sha;
    if (args[0] === 'rev-list') return m.pr_commits.join('\n');
    if (args[0] === 'diff' && args[1] === '-M50%') return m.raw.renames ?? this.rows(m.renames);
    if (args[0] === 'diff' && args[1] === '--name-status' && args[2] === '--no-renames') {
      return m.raw.namestatus ?? this.rows(m.namestatus);
    }
    if (args[0] === 'diff' && args[1] === '--numstat' && args[2] === '--no-renames') {
      if (args[4] === m.merge_sha && args.length === 5)
        return m.raw.numstat ?? this.rows(m.numstat);
      const paths = args.slice(args.indexOf('--') + 1);
      return paths
        .filter((p) => p in m.synth)
        .map((p) => [m.synth[p], '0', p].join('\t'))
        .join('\n');
    }
    if (args[0] === 'blame') {
      const path = args[args.length - 1] as string;
      const raw = m.raw[`blame:${path}`];
      if (raw !== undefined) return raw;
      return (m.blame[path] ?? []).map((sha, n) => `${sha} ${n + 1} ${n + 1}\n\tline\n`).join('');
    }
    throw new Error(`unexpected git ${JSON.stringify(args)}`);
  }

  async pathExists(rev: string, path: string): Promise<boolean> {
    this.calls.push(['cat-file', `${rev}:${path}`]);
    if (!(path in this.m.exists)) throw new Error(`no exists fact for ${path}`);
    return this.m.exists[path] as boolean;
  }
}

type Outcome =
  | { ok: unknown; calls?: string[][] }
  | { raises: string; message: string; calls?: string[][] };

async function replay(spec: Spec): Promise<Outcome> {
  const fn = spec.fn;
  const input = structuredClone(spec);
  let recorder: Recorder | undefined;
  try {
    let ok: unknown;
    if (fn === 'origins') {
      const { source, origins } = legacyOrigins(input.queue, input.item, input.reviewed);
      ok = { source: pyIndex(source, 'id'), origins: [...origins].sort(compareCodePoints) };
    } else if (fn === 'retry') {
      ok = legacyRetryView(input.queue, input.pr, input.path, input.at);
    } else if (fn === 'candidate') {
      const p = input.params;
      ok = coverageCandidate(input.queue, input.ledger, {
        mergeQueueSha: p.merge_queue_sha,
        ordinaryEligible: p.ordinary_eligible,
        now: p.now,
        ...('max_paths' in p ? { maxPaths: p.max_paths } : {}),
        ...('min_age_hours' in p ? { minAgeHours: p.min_age_hours } : {}),
        ...('excluded_paths' in p ? { excludedPaths: p.excluded_paths } : {}),
      });
    } else if (fn === 'measure') {
      recorder = new Recorder(input.repo);
      ok = await measureMerged(
        recorder,
        {
          defaultRef: 'origin/main',
          minFileFocus: input.config.merged_min_file_focus ?? 0.25,
          iso: () => '2026-11-20T12:00:00Z',
        },
        input.item,
        input.target,
      );
    } else {
      throw new Error(`unknown fn ${fn}`);
    }
    return recorder ? { ok, calls: recorder.calls } : { ok };
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
    const failed = { raises: error.pythonError, message: error.message };
    return recorder ? { ...failed, calls: recorder.calls } : failed;
  }
}

describe('coverage legacy effects against the Python oracle', () => {
  it('reads the expected fixture', () => {
    expect(fixture.schema).toBe('crq-coverage-effects-oracle/1');
    expect(fixture.cases.length).toBeGreaterThan(150);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const actual = await replay(c.spec);
      const expected = c.result;
      if (expected.raises !== undefined) {
        expect(actual).toMatchObject({ raises: expected.raises });
        if (MESSAGE_CHECKED.has(expected.raises)) {
          expect((actual as { message: string }).message).toBe(expected.message);
        }
      } else {
        expect(actual, JSON.stringify(actual)).toHaveProperty('ok');
        expect((actual as { ok: unknown }).ok).toEqual(expected.ok);
      }
      if (c.spec.fn === 'measure') expect(actual.calls).toEqual(expected.calls);
    });
  }
});
