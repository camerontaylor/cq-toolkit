import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileFixPrBacklogEffects } from '../../src/adapters/crq/fixPrBacklogSource.js';
import {
  FixPrBacklog,
  backfillRepairPresent,
  pySplitLines,
  refreshFixPrBacklog,
  reviewStartLimit,
  type FixPrBacklogEffects,
} from '../../src/queue-runner/fixPrBacklog.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const NOW = Date.parse('2026-11-20T12:00:00Z');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fixpr-backlog-'));
  dirs.push(dir);
  return dir;
};

const PY = `
import sys, json, datetime as dt, pathlib
sys.path.insert(0, sys.argv[1])
import repair_tick
state = pathlib.Path(sys.argv[2])
spec = json.loads(sys.argv[3])
class C: pass
c = C(); c.STATE = state; c.EVENTS = state / 'events.jsonl'; c.REPO = 'o/r'
def gh_json(args):
    if spec['prs'] == 'raise': raise RuntimeError('gh failed')
    return spec['prs']
c.gh_json = gh_json
if spec['mode'] == 'limit':
    now = dt.datetime.fromtimestamp(spec['now'] / 1000, dt.timezone.utc)
    print(json.dumps({'limit': repair_tick.review_start_limit(c, now)}))
else:
    repair_tick.TICK_BACKLOG.update(open=7, limit=7)
    out = repair_tick.refresh_fix_pr_backlog(c)
    print(json.dumps({'view': None if out is None else dict(out),
                      'tick': dict(repair_tick.TICK_BACKLOG)}))
`;

function python(state: string, spec: Record<string, unknown>): Record<string, unknown> {
  const out = execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, state, JSON.stringify(spec)], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as Record<string, unknown>;
}

function effects(over: Partial<FixPrBacklogEffects> = {}): FixPrBacklogEffects & {
  written: unknown[];
} {
  const written: unknown[] = [];
  return {
    listOpenPrs: async () => [],
    readEvents: async () => '',
    writeBacklog: async (doc) => void written.push(doc),
    nowMs: () => NOW,
    ...over,
    written,
  };
}

const ev = (at: unknown, event = 'review_started') => JSON.stringify({ at, event });
const hoursAgo = (h: number): string =>
  new Date(NOW - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('FixPrBacklog', () => {
  it('starts unread and holds backfill creation; non-backfill items are never capped', () => {
    const b = new FixPrBacklog();
    expect(b.slotFree({ id: 'backfill-finding-1' })).toBe(false);
    expect(b.slotFree({ id: 'pr-5' })).toBe(true);
    b.open = 1;
    b.limit = 2;
    expect(b.slotFree({ id: 'backfill-finding-1' })).toBe(true);
    b.open = 2;
    expect(b.slotFree({ id: 'backfill-finding-1' })).toBe(false);
    b.reset();
    expect([b.open, b.limit]).toEqual([null, null]);
  });

  it('reserves and releases a slot only while the count is read', () => {
    const b = new FixPrBacklog();
    b.reserve();
    expect(b.open).toBeNull();
    b.open = 0;
    b.limit = 1;
    b.reserve();
    expect(b.slotFree({ id: 'backfill-finding-1' })).toBe(false);
    b.release();
    expect(b.slotFree({ id: 'backfill-finding-1' })).toBe(true);
  });

  it('backfillRepairPresent needs a backfill id with truthy repair_runs', () => {
    expect(backfillRepairPresent({ items: [] })).toBe(false);
    expect(backfillRepairPresent({ items: [{ id: 'backfill-finding-a', repair_runs: {} }] })).toBe(
      false,
    );
    expect(backfillRepairPresent({ items: [{ id: 'pr-1', repair_runs: { r: {} } }] })).toBe(false);
    expect(
      backfillRepairPresent({ items: [{ id: 'backfill-finding-a', repair_runs: { r: {} } }] }),
    ).toBe(true);
    expect(backfillRepairPresent({ items: [{ repair_runs: { r: {} } }] })).toBe(false);
  });
});

describe('pySplitLines', () => {
  it('matches str.splitlines boundaries', () => {
    expect(pySplitLines('a\nb\r\nc\rd\x0be\x0cf\x1cg\x1dh\x1ei\x85j k l')).toEqual(
      'abcdefghijkl'.split(''),
    );
    expect(pySplitLines('a\n')).toEqual(['a']);
    expect(pySplitLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(pySplitLines('')).toEqual([]);
  });
});

describe('reviewStartLimit against Python review_start_limit', () => {
  const cases: Array<[string, string]> = [
    ['Z timestamp inside the window', ev(hoursAgo(1))],
    ['offset timestamp inside the window', ev('2026-11-20T18:00:00+08:00')],
    ['compact offset', ev('2026-11-20T06:30:00-0530')],
    ['naive timestamp never counts', ev('2026-11-20T11:00:00')],
    ['date only never counts', ev('2026-11-20')],
    ['space separator with offset', ev('2026-11-20 11:00:00+00:00')],
    ['fractional seconds', ev('2026-11-20T11:00:00.123456Z')],
    ['lowercase z', ev('2026-11-20T11:00:00z')],
    ['X separator with offset', ev('2026-11-20X11:00:00+00:00')],
    ['underscore separator with Z', ev('2026-11-20_11:00:00Z')],
    ['multiplication-sign separator with offset', ev('2026-11-20\u00d711:00:00+08:00')],
    ['astral separator with offset', ev('2026-11-20\u{1f600}11:00:00+00:00')],
    ['slash separator with negative offset', ev('2026-11-20/06:30:00-05:30')],
    ['X separator naive', ev('2026-11-20X11:00:00')],
    ['underscore separator naive', ev('2026-11-20_11:00:00')],
    ['compact date with X separator and offset', ev('20261120X110000+0000')],
    ['compact date with X separator and Z', ev('20261120X110000Z')],
    ['week date with X separator and Z', ev('2026-W47-5X11:00:00Z')],
    ['compact week date with offset', ev('2026W475_11:00:00+00:00')],
    ['week date without a day, naive', ev('2026-W47X11:00:00')],
    ['offset with seconds', ev('2026-11-20X11:00:00+00:00:00')],
    ['unparseable offset', ev('2026-11-20X11:00:00+9')],
    ['older than the window', ev(hoursAgo(73))],
    ['exactly at the cutoff', ev(hoursAgo(72))],
    ['exactly now', ev(hoursAgo(0))],
    ['in the future', ev('2026-11-20T12:00:01Z')],
    ['a different event', ev(hoursAgo(1), 'review_finished')],
    ['not json but mentions the event', '"review_started" oops'],
    ['missing at', JSON.stringify({ event: 'review_started' })],
    ['numeric at', JSON.stringify({ at: 20261120, event: 'review_started' })],
    ['null at', JSON.stringify({ at: null, event: 'review_started' })],
    ['a list row', '["review_started"]'],
    ['at is a malformed string', ev('yesterday')],
    ['event only in another field', JSON.stringify({ at: hoursAgo(1), note: '"review_started"' })],
  ];
  for (const [name, line] of cases) {
    it(name, async () => {
      const state = tmp();
      // 18 copies make one counted line observable: 18 * 4 // 72 === 1.
      const text = Array.from({ length: 18 }, () => line).join('\n') + '\n';
      writeFileSync(join(state, 'events.jsonl'), text);
      const expected = python(state, { mode: 'limit', now: NOW, prs: [] })['limit'];
      const actual = await reviewStartLimit({ readEvents: async () => text, nowMs: () => NOW });
      expect(actual).toBe(expected);
    });
  }

  it('floors started * 4 // 72 and treats Python line separators as boundaries', async () => {
    const state = tmp();
    const lines = Array.from({ length: 36 }, () => ev(hoursAgo(2)));
    const text = lines.join('\x0b') + ' ' + ev(hoursAgo(3)) + '\r\n';
    writeFileSync(join(state, 'events.jsonl'), text);
    const expected = python(state, { mode: 'limit', now: NOW, prs: [] })['limit'];
    expect(expected).toBe(2);
    expect(await reviewStartLimit({ readEvents: async () => text, nowMs: () => NOW })).toBe(2);
  });

  it('is 0 when the events file cannot be read', async () => {
    expect(await reviewStartLimit({ readEvents: async () => null, nowMs: () => NOW })).toBe(0);
  });
});

describe('refreshFixPrBacklog', () => {
  it('counts only open crq/fix-backfill- heads, writes the file doc and publishes the view', async () => {
    const fx = effects({
      listOpenPrs: async () => [
        { headRefName: 'crq/fix-backfill-1' },
        { headRefName: 'crq/fix-backfill-2' },
        { headRefName: 'crq/fix-other' },
        { headRefName: null },
        {},
      ],
      readEvents: async () => Array.from({ length: 36 }, () => ev(hoursAgo(1))).join('\n') + '\n',
    });
    const b = new FixPrBacklog();
    expect(await refreshFixPrBacklog(b, fx)).toBe(b);
    expect([b.open, b.limit]).toEqual([2, 2]);
    expect(fx.written).toEqual([{ at: '2026-11-20T12:00:00Z', open: 2, limit: 2 }]);
  });

  it.each([
    ['gh fails', { listOpenPrs: async () => Promise.reject(new Error('gh')) }],
    ['gh returns a non-array', { listOpenPrs: async () => ({ headRefName: 'x' }) }],
    ['gh returns a non-object entry', { listOpenPrs: async () => ['crq/fix-backfill-1'] }],
    ['the events read throws', { readEvents: async () => Promise.reject(new Error('decode')) }],
    ['the write fails', { writeBacklog: async () => Promise.reject(new Error('disk')) }],
  ] as Array<[string, Partial<FixPrBacklogEffects>]>)(
    'returns null and leaves the view unread when %s',
    async (_name, over) => {
      const b = new FixPrBacklog();
      b.open = 5;
      b.limit = 5;
      expect(await refreshFixPrBacklog(b, effects(over))).toBeNull();
      expect([b.open, b.limit]).toEqual([null, null]);
    },
  );
});

describe('file-backed refresh against Python refresh_fix_pr_backlog', () => {
  async function bothSides(
    prs: unknown,
    events: string | null,
  ): Promise<{
    ts: unknown;
    py: Record<string, unknown>;
    tsFile: string | null;
    pyFile: string | null;
  }> {
    const tsState = tmp();
    const pyState = tmp();
    for (const state of [tsState, pyState]) {
      if (events !== null) writeFileSync(join(state, 'events.jsonl'), events);
    }
    const py = python(pyState, { mode: 'refresh', prs });
    const backlog = new FixPrBacklog();
    backlog.open = 7;
    backlog.limit = 7;
    const view = await refreshFixPrBacklog(
      backlog,
      fileFixPrBacklogEffects({
        stateRoot: tsState,
        listOpenPrs: async () => {
          if (prs === 'raise') throw new Error('gh failed');
          return prs;
        },
      }),
    );
    const read = (state: string): string | null => {
      try {
        return readFileSync(join(state, 'repair', 'fix-pr-backlog.json'), 'utf8');
      } catch {
        return null;
      }
    };
    return {
      ts: {
        view: view === null ? null : { open: view.open, limit: view.limit },
        tick: { open: backlog.open, limit: backlog.limit },
      },
      py,
      tsFile: read(tsState),
      pyFile: read(pyState),
    };
  }

  const stripAt = (text: string | null): unknown =>
    text === null ? null : JSON.parse(text.replace(/"at": "[^"]+"/, '"at": "T"'));

  it('writes the same file shape and publishes the same view', async () => {
    const events =
      Array.from({ length: 36 }, () => ev(new Date(Date.now() - 3_600_000).toISOString())).join(
        '\n',
      ) + '\n';
    const prs = [{ headRefName: 'crq/fix-backfill-a' }, { headRefName: 'main' }];
    const r = await bothSides(prs, events);
    expect(r.ts).toEqual(r.py);
    expect(stripAt(r.tsFile)).toEqual(stripAt(r.pyFile));
    expect(r.tsFile?.endsWith('}\n')).toBe(true);
    expect(r.tsFile?.replace(/"at": "[^"]+"/, '')).toBe(r.pyFile?.replace(/"at": "[^"]+"/, ''));
    expect(r.tsFile?.indexOf('"at"')).toBeLessThan(r.tsFile?.indexOf('"open"') ?? -1);
  });

  it('with no events file the limit is 0 and the file is still written', async () => {
    const r = await bothSides([], null);
    expect(r.ts).toEqual(r.py);
    expect(stripAt(r.tsFile)).toEqual(stripAt(r.pyFile));
    expect(stripAt(r.tsFile)).toEqual({ at: 'T', open: 0, limit: 0 });
  });

  it('a failed gh read leaves no file and an unread view on both sides', async () => {
    const r = await bothSides('raise', '');
    expect(r.ts).toEqual(r.py);
    expect(r.tsFile).toBeNull();
    expect(r.pyFile).toBeNull();
  });

  it('a malformed gh payload fails closed on both sides', async () => {
    const r = await bothSides(['crq/fix-backfill-1'], '');
    expect(r.ts).toEqual(r.py);
    expect(r.tsFile).toBeNull();
  });
});
