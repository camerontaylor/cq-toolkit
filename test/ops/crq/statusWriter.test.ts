import { describe, expect, it } from 'vitest';
import { parseCrqState } from '../../../src/policy/crq/state.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import {
  additionalCycle,
  assembleStatusMarkdown,
  completedOpenCycles,
  crqRank,
  inflight,
  isoSeconds,
  isExecutionOwner,
  itemRepo,
  jsonScalar,
  liveItems,
  localReviewAgingMinutes,
  parseConfig,
  probeSchedule,
  recentEventLines,
  repoRankFor,
  sortKey,
  startsLastHour,
  statusJsonDocument,
  statusRow,
  validateQueue,
  writeStatusForDocuments,
  type CrqDocuments,
  type StatusWriterEffects,
} from '../../../src/ops/crq/statusWriter.js';

const NOW = 1_763_000_000; // fixed epoch second (2025-11-13T02:13:20Z) for deterministic stamps
const ISO_NOW = isoSeconds(NOW);

/** The encoder options the status.md JSON blocks use (Python default dumps). */
const DEFAULT_TEST_JSON = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
  spacedSeparators: true,
} as const;

/** Minimal but schema-valid queue builder. */
function queueWith(items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    created_at: '2026-11-01T00:00:00Z',
    items,
    starts: [],
    paused: false,
    ...extra,
  } as Record<string, unknown>;
}

function configWith(extra: Record<string, unknown> = {}) {
  return { repo: 'owner/main', max_starts_per_hour: 12, ...extra } as Record<string, unknown>;
}

function documents(
  items: Record<string, unknown>[],
  extraQueue = {},
  extraConfig = {},
): CrqDocuments {
  return { queue: queueWith(items, extraQueue), config: configWith(extraConfig) };
}

/** Effects stub: all reads fail loudly; writes capture. */
function stubEffects(documents: CrqDocuments, overrides: Partial<StatusWriterEffects> = {}) {
  const markdowns: string[] = [];
  const jsons: Uint8Array[] = [];
  const events: unknown[] = [];
  const effects: StatusWriterEffects = {
    composerSeams: {
      triageRows: [],
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
    },
    readQueue: async () => {
      throw new Error('unexpected readQueue');
    },
    readConfig: async () => {
      throw new Error('unexpected readConfig');
    },
    readEvents: async () => '',
    readReceipt: async () => null,
    probeSchedule: async () => ({ stdout: null, failure: null }),
    now: () => NOW,
    writeStatusMarkdown: async (text: string) => {
      markdowns.push(text);
    },
    writeStatusJson: async (bytes: Uint8Array) => {
      jsons.push(bytes);
    },
    appendEvent: async (event: unknown) => {
      events.push(event);
    },
    publishSummary: async () => ({ so: 'ok' }),
    ...overrides,
  } as StatusWriterEffects;
  return { effects, markdowns, jsons, events };
}

describe('queue helpers', () => {
  it('filters retired promotion items (the ceres load-bearing filter)', () => {
    const queue = queueWith([
      { id: 'pr1', kind: 'open', state: 'pending', cycles: [] },
      { id: 'promotion-old', kind: 'promotion', state: 'done', cycles: [] },
    ]);
    expect(liveItems(queue).map((item: Record<string, unknown>) => item['id'])).toEqual(['pr1']);
  });

  it('normalizes legacy items without repo to the primary repo', () => {
    expect(itemRepo({}, 'owner/main')).toBe('owner/main');
    expect(itemRepo({ repo: 'owner/other' }, 'owner/main')).toBe('owner/other');
    expect(itemRepo({ repo: '' }, 'owner/main')).toBe('owner/main');
  });

  it('counts only recorded terminal cycles', () => {
    expect(completedOpenCycles({ cycles: [{}, {}] })).toBe(2);
    expect(completedOpenCycles({})).toBe(0);
    expect(completedOpenCycles({ cycles: 'bogus' })).toBe(0);
  });

  it('parks served open work and later author cycles at rank 5', () => {
    expect(additionalCycle({ kind: 'open', cycles: [{}] })).toBe(true);
    expect(additionalCycle({ kind: 'open', cycles: [] })).toBe(false);
    expect(additionalCycle({ kind: 'author', author: { cycle: 2 } })).toBe(true);
    expect(additionalCycle({ kind: 'author', author: { cycle: 1 } })).toBe(false);
  });

  it('ranks kinds: open 0, delta 1, merged-current 2, coverage/backfill 4, author 4', () => {
    const repos: Record<string, unknown>[] = [];
    const rank = (item: Record<string, unknown>) => crqRank(item, 'owner/main', repos, 60, NOW);
    expect(rank({ kind: 'open' })).toBe(0);
    expect(rank({ kind: 'delta' })).toBe(1);
    expect(rank({ kind: 'delta', followup: 'merged' })).toBe(2);
    expect(rank({ kind: 'merged-current' })).toBe(2);
    expect(rank({ kind: 'coverage' })).toBe(4);
    expect(rank({ kind: 'backfill' })).toBe(4);
    expect(rank({ kind: 'author' })).toBe(4);
    // An unmerged-followup delta hits the delta arm before the source arm.
    expect(rank({ kind: 'delta', source: 'followup' })).toBe(1);
    expect(rank({ kind: 'mystery' })).toBe(3);
  });

  it('ages repeat local reviews by config minutes; first reviews stay rank 0', () => {
    const repos: Record<string, unknown>[] = [];
    // NOW reads 2025-11-13T02:13:20Z, so 2020-11-01 is years stale: aged.
    const aged = { kind: 'local-review', generation: 2, created_at: '2020-11-01T00:00:00Z' };
    expect(crqRank(aged, 'owner/main', repos, 60, NOW)).toBe(0);
    const fresh = { kind: 'local-review', generation: 2, created_at: isoSeconds(NOW - 60) };
    expect(crqRank(fresh, 'owner/main', repos, 60, NOW)).toBe(1);
    const first = { kind: 'local-review', created_at: isoSeconds(NOW - 1) };
    expect(crqRank(first, 'owner/main', repos, 60, NOW)).toBe(0);
    const explicit = {
      kind: 'local-review',
      repeat_requested: true,
      created_at: isoSeconds(NOW - 60),
    };
    expect(crqRank(explicit, 'owner/main', repos, 60, NOW)).toBe(1);
    // Unparsable created_at never ages.
    const bad = { kind: 'local-review', generation: 2, created_at: 'not-a-date' };
    expect(crqRank(bad, 'owner/main', repos, 60, NOW)).toBe(1);
  });

  it('reads local_review_aging_minutes with the 60 default', () => {
    expect(localReviewAgingMinutes(configWith())).toBe(60);
    expect(localReviewAgingMinutes(configWith({ local_review_aging_minutes: 30 }))).toBe(30);
  });

  it('uses configured rank_tier for non-primary repos, case-insensitively', () => {
    const repos = [{ repo: 'Owner/Other', rank_tier: 2 }];
    expect(repoRankFor({ repo: 'owner/other' }, 'owner/main', repos)).toBe(2);
    // Unknown non-primary repo keeps the default 3.
    expect(repoRankFor({ repo: 'owner/unknown' }, 'owner/main', [])).toBe(3);
    // Primary repo keeps the kind rank.
    expect(repoRankFor({ repo: 'OWNER/MAIN' }, 'owner/main', repos)).toBe(null);
  });

  it('sorts by operator priority, then rank, then order', () => {
    const repos: Record<string, unknown>[] = [];
    expect(sortKey({ operator_priority: true }, 'owner/main', repos, 60, NOW)[0]).toBe(0);
    expect(sortKey({}, 'owner/main', repos, 60, NOW)[0]).toBe(1);
    expect(sortKey({ order: 5 }, 'owner/main', repos, 60, NOW)[2]).toBe(5);
    expect(sortKey({}, 'owner/main', repos, 60, NOW)[2]).toBe(999);
  });

  it('counts strict-parse retained starts in the last hour', () => {
    const queue = queueWith([], {
      starts: [isoSeconds(NOW - 100), isoSeconds(NOW - 3601), isoSeconds(NOW - 10)],
    });
    expect(startsLastHour(queue, NOW)).toBe(2);
  });

  it('classifies execution ownership for inflight backfill/coverage work', () => {
    expect(isExecutionOwner({ vendor_state: 'live' })).toBe(true);
    expect(isExecutionOwner({ vendor_state: 'unknown' })).toBe(true);
    expect(isExecutionOwner({ run: { run_id: 'r' } })).toBe(true);
    expect(isExecutionOwner({ state: 'reviewing' })).toBe(true);
    expect(isExecutionOwner({ state: 'launch-unknown' })).toBe(true);
    expect(isExecutionOwner({ state: 'pending' })).toBe(false);
    const queue = queueWith([
      { id: 'a', kind: 'backfill', state: 'pending', vendor_state: 'live' },
      { id: 'b', kind: 'open', state: 'reviewing' },
      { id: 'c', kind: 'backfill', state: 'pending' },
    ]);
    expect(inflight(queue).map((item: Record<string, unknown>) => item['id'])).toEqual(['a', 'b']);
  });
});

describe('jsonScalar and Python spellings', () => {
  it('encodes with Python default separators and ensure_ascii', () => {
    const value = jsonScalar({ b: 1, a: 'x\u00e9' });
    expect(pythonJsonText(value, DEFAULT_TEST_JSON)).toBe('{"b": 1, "a": "x\\u00e9"}');
  });

  it('serialises nested JSON through scalars, records and arrays', () => {
    const value = jsonScalar({ list: [1, 'x', null, true], nested: { k: 'v' } });
    expect(pythonJsonText(value, DEFAULT_TEST_JSON)).toBe(
      '{"list": [1, "x", null, true], "nested": {"k": "v"}}',
    );
  });

  it('refuses non-JSON shapes instead of rendering [object Object]', () => {
    expect(() => jsonScalar(new Map([['a', 1]]))).toThrow();
    expect(() => jsonScalar(() => 1)).toThrow();
  });
});

describe('status.json projection', () => {
  it('carries the exact historical key order with repo last', () => {
    const docs = documents([
      {
        id: 'pr1',
        kind: 'open',
        state: 'pending',
        cycles: [],
        prior_cycles: 0,
        pinned_base: 'abc',
        extra: 'dropped',
      },
    ]);
    const triage = { total: 0 };
    const items = docs.queue['items'] as Record<string, unknown>[];
    const rows = [{ row: statusRow(items[0]!, 'owner/main'), raw: items[0]! }];
    const status = statusJsonDocument(docs, ISO_NOW, triage, rows);
    expect(Object.keys(status)).toEqual([
      'generated_at',
      'paused',
      'cooldown_until',
      'finding_triage',
      'items',
    ]);
    const statusItems = status['items'] as Record<string, unknown>[];
    expect(Object.keys(statusItems[0]!)).toEqual([
      'id',
      'kind',
      'state',
      'repo',
      'prior_cycles',
      'cycles',
      'operator_priority',
      'optional_cycle',
      'pinned_base',
      'last_error',
      'wait_reason',
      'gate_stalled_at',
    ]);
    expect(statusItems[0]!['repo']).toBe('owner/main');
    expect('extra' in statusItems[0]!).toBe(false);
  });

  it('validates against policy/crq/status.schema.json before the write', async () => {
    const docs = documents([{ id: 'pr1', kind: 'open', state: 'pending', cycles: [] }]);
    const { effects, jsons } = stubEffects(docs);
    await writeStatusForDocuments(effects, docs);
    expect(jsons).toHaveLength(1);
    const text = new TextDecoder().decode(jsons[0]!);
    expect(text.endsWith('\n')).toBe(true);
    const accepted = parseCrqState('status.schema.json', text);
    expect(accepted.ok).toBe(true);
  });
});

describe('markdown assembly', () => {
  it('renders the banner with Python str(None) spellings', () => {
    const markdown = assembleStatusMarkdown({
      generatedAt: ISO_NOW,
      paused: false,
      pauseReason: undefined,
      scheduleId: undefined,
      nextRun: '',
      cooldownUntil: undefined,
      usage: null,
      starts60m: 0,
      inflight: [],
      legacyAddressing: [],
      owedOpen: 1,
      mergedCurrent: {
        natural_discovery: {},
        discovery: {},
        watermark: null,
        receipts: {
          pending: 0,
          reviewing: 0,
          blocked: 0,
          unverified: 0,
          proven_terminal: 0,
          no_current_code: 0,
          partial_scope: 0,
          unsupported: 0,
        },
        path_exclusions: {},
        captured_targets: [],
        additional_captured_targets: 0,
        coverage_at_today_target: 'unverified',
        legacy_done_is_review_proof: false,
      },
      lastTick: undefined,
      repoLines: [],
      rows: [],
      recentEvents: [],
      triage: {},
      repairUtilization: { repair: {}, utilization: {} },
    });
    expect(markdown).toContain('# CodeRabbit review queue — status');
    expect(markdown).toContain('- queue: active');
    expect(markdown).toContain('- schedule: `None` ');
    expect(markdown).toContain('- rate-limit cooldown until: —');
    expect(markdown).toContain('- included review usage: null;');
    expect(markdown).toContain('- open-PR CLI reviews still owed: 1');
    expect(markdown).toContain('- last tick: None');
    expect(markdown).toContain(
      '| item | repo | kind | state | cycles | pinned base | last outcome | wait / last error | supersession |',
    );
    expect(markdown).toContain('## Recent events');
    expect(markdown).toContain('## Backfill finding triage');
    expect(markdown).toContain('## Repair and utilization');
  });

  it('renders a pending row with bounded why and the primary repo column empty', () => {
    const row = statusRow(
      { id: 'pr7', kind: 'open', state: 'pending', cycles: [], wait_reason: 'x'.repeat(200) },
      'owner/main',
    );
    expect(row.repo).toBe('owner/main');
    expect(row.why).toHaveLength(110);
    expect(row.markdown).toContain('| pr7 |  | open | pending | 0/1 |');
    expect(row.markdown.endsWith(`| ${'x'.repeat(110)} |  |`)).toBe(true);
  });

  it('marks gate-stalled promoting items with the intervention prefix', () => {
    const row = statusRow(
      {
        id: 'pr9',
        kind: 'merged',
        state: 'promoting',
        gate_stalled_at: '2026-11-01T00:00:00Z',
        cycles: [],
      },
      'owner/main',
    );
    expect(row.why).toContain(
      'Owner intervention required — gate stalled since 2026-11-01T00:00:00Z',
    );
  });

  it('keeps the events slice at the last 15 lines', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `event-${index}`);
    expect(recentEventLines(lines.join('\n'))).toEqual(lines.slice(-15));
    expect(recentEventLines('')).toEqual([]);
    expect(recentEventLines('only')).toEqual(['only']);
  });
});

describe('config parsing', () => {
  it('parses config lossless with duplicate-key-last semantics', () => {
    const config = parseConfig('{"repo": "a/b", "repo": "c/d"}');
    expect(config['repo']).toBe('c/d');
  });

  it('refuses non-object config', () => {
    expect(() => parseConfig('[1,2]')).toThrow();
    expect(() => parseConfig('nope')).toThrow();
  });

  it('queue validation surfaces the schema refusal', () => {
    expect(() => validateQueue('{"items": "not-a-list"}')).toThrow(/rejected/);
  });
});

describe('write route', () => {
  it('writes status.md, validated status.json and publishes the summary', async () => {
    const docs = documents([
      {
        id: 'pr1',
        kind: 'open',
        state: 'pending',
        cycles: [],
        order: 0,
        last_tick: '2026-11-10T00:00:00Z',
      },
    ]);
    // Python reads last_tick off the QUEUE document, not the item.
    (docs.queue as Record<string, unknown>)['last_tick'] = '2026-11-10T00:00:00Z';
    const queueText = JSON.stringify(docs.queue);
    const configText = JSON.stringify(docs.config);
    const { effects, markdowns, jsons } = stubEffects(docs, {
      readQueue: async () => queueText,
      readConfig: async () => configText,
      publishSummary: async (published: CrqDocuments) => ({
        last_tick: (published.queue as Record<string, unknown>)['last_tick'],
      }),
    });
    const result = await writeStatusForDocuments(effects, docs);
    expect(result.summary).toEqual({ last_tick: '2026-11-10T00:00:00Z' });
    expect(result.publishFailure).toBeUndefined();
    expect(markdowns).toHaveLength(1);
    expect(markdowns[0]!.endsWith('\n')).toBe(true);
    expect(jsons).toHaveLength(1);
    expect(result.markdown).toContain('| pr1 |  | open | pending | 0/1 |');
    expect(result.markdown).toContain('- open-PR CLI reviews still owed: 1');
  });

  it('isolates publish failure into the summary_failed event and keeps the artifacts', async () => {
    const docs = documents([{ id: 'pr1', kind: 'open', state: 'pending', cycles: [] }]);
    const queueText = JSON.stringify(docs.queue);
    const configText = JSON.stringify(docs.config);
    const { effects, events, markdowns, jsons } = stubEffects(docs, {
      readQueue: async () => queueText,
      readConfig: async () => configText,
      publishSummary: async () => {
        throw new Error('composer refused');
      },
    });
    const result = await writeStatusForDocuments(effects, docs);
    expect(result.summary).toBeNull();
    expect(result.publishFailure).toBeDefined();
    expect(events).toEqual([{ event: 'summary_failed', error: 'Error' }]);
    expect(markdowns).toHaveLength(1);
    expect(jsons).toHaveLength(1);
  });

  it('refuses a missing max_starts_per_hour like Python KeyError', async () => {
    const docs = documents(
      [{ id: 'pr1', kind: 'open', state: 'pending', cycles: [] }],
      {},
      { max_starts_per_hour: undefined },
    );
    const { effects } = stubEffects(docs, {
      readQueue: async () => JSON.stringify(docs.queue),
      readConfig: async () => JSON.stringify(docs.config),
    });
    await expect(writeStatusForDocuments(effects, docs)).rejects.toThrow(/max_starts_per_hour/);
  });

  it('serves the schedule probe failure text through the banner', async () => {
    const docs = documents(
      [{ id: 'pr1', kind: 'open', state: 'pending', cycles: [] }],
      {},
      {
        schedule_id: 'crq-tick',
      },
    );
    const { effects } = stubEffects(docs, {
      readQueue: async () => JSON.stringify(docs.queue),
      readConfig: async () => JSON.stringify(docs.config),
      probeSchedule: async () => ({
        stdout: null,
        failure: '(schedule inspect failed: RuntimeError)',
      }),
    });
    const result = await writeStatusForDocuments(effects, docs);
    expect(result.markdown).toContain(
      '- schedule: `crq-tick` (schedule inspect failed: RuntimeError)',
    );
  });

  it('classifies the schedule probe outcome over the parsed document', async () => {
    const docs = documents([], {}, { schedule_id: 'crq-tick' });
    const { effects } = stubEffects(docs);
    const ok = await probeSchedule(effects, 'crq-tick');
    void ok;
    const { effects: success } = stubEffects(docs, {
      probeSchedule: async () => ({ stdout: '{"status":"active"}', failure: null }),
    });
    const parsed = await probeSchedule(success, 'crq-tick');
    expect(parsed.schedule).toEqual({ status: 'active' });
    expect(parsed.failure).toBeNull();
  });

  it('stamps iso() in the exact %Y-%m-%dT%H:%M:%SZ shape', () => {
    expect(ISO_NOW).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(() => isoSeconds(Number.NaN)).toThrow();
  });
});
