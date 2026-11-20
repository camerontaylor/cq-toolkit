// Differential run: the same isolated state files, clock and environment through
// Python's `crq_repair.py` (the oracle, test/helpers/repairPauseOracle.py) and the TS
// pause effects. Returned values and written files must be byte-equal and a Python
// exception must coincide with a TS throw. Injected clocks and tmp state only: no
// network, git, provider, queue or service state.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  blocked,
  CooldownStateError,
  fileRepairPauseEffects,
  OPERATOR_RECOVERY_PAUSE,
  validCooldownStamp,
} from '../../../src/adapters/crq/repairPauseSource.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const ORACLE = new URL('../../helpers/repairPauseOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;

type FileSpec = string | { hex: string } | { dir: true };
interface Case {
  name: string;
  op: 'paused' | 'rate_limit_pause' | 'blocked' | 'cooldowns' | 'dispatch_paused';
  files?: Record<string, FileSpec>;
  mtimes?: Record<string, number>;
  clock?: string[];
  env?: Record<string, string>;
  args?: Record<string, unknown>;
}
interface Outcome {
  ok?: unknown;
  error?: string;
  files?: Record<string, string>;
}

// Python's json accepts NaN/Infinity; the adapter's own reader does too.
const parse = (text: string) =>
  parseJsonValue(text, {
    parseConstant: (raw) =>
      JsonNumber.float(raw === 'NaN' ? Number.NaN : raw === 'Infinity' ? Infinity : -Infinity),
  });
const toJson = (value: unknown) => parse(JSON.stringify(value));

const cleanups: string[] = [];

async function runTs(item: Case): Promise<Outcome> {
  const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
  cleanups.push(tmp);
  const state = join(tmp, 'state');
  await mkdir(state);
  for (const [rel, spec] of Object.entries(item.files ?? {})) {
    const path = join(state, rel);
    if (typeof spec === 'object' && 'dir' in spec) {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof spec === 'string' ? spec : Buffer.from(spec.hex, 'hex'));
  }
  for (const [rel, seconds] of Object.entries(item.mtimes ?? {})) {
    await utimes(join(state, rel), seconds, seconds);
  }
  const clock = (item.clock ?? ['2026-11-21T00:00:00Z']).map((text) => new Date(text));
  let reads = 0;
  const effects = fileRepairPauseEffects({
    stateRoot: state,
    now: () => clock[Math.min(reads++, clock.length - 1)] as Date,
    env: item.env ?? {},
  });
  const args = item.args ?? {};
  try {
    let ok: unknown;
    if (item.op === 'paused') {
      ok = await effects.paused('now' in args ? new Date(args.now as string) : undefined);
    } else if (item.op === 'blocked') {
      ok = blocked(toJson(args.repair), new Date(args.now as string));
    } else if (item.op === 'rate_limit_pause') {
      ok = await effects.rateLimitPause(toJson(args.report), toJson(args.job));
    } else if (item.op === 'cooldowns') {
      ok = Object.fromEntries(await effects.providerCooldowns());
    } else {
      ok = await effects.dispatchPaused(toJson(args.config));
    }
    return { ok, files: await snapshot(state) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

async function snapshot(state: string, dir = state): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(state, path));
    else if (entry.name !== 'tick.lock') {
      out[path.slice(state.length + 1)] = (await readFile(path)).toString('latin1');
    }
  }
  return out;
}

function runOracle(cases: Case[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run every case through both implementations and require agreement. */
async function expectParity(cases: Case[]): Promise<Outcome[]> {
  const oracle = runOracle(cases);
  const ours: Outcome[] = [];
  for (const item of cases) ours.push(await runTs(item));
  cases.forEach((item, index) => {
    const python = oracle[index] as Outcome;
    const ts = ours[index] as Outcome;
    if (python.error !== undefined) {
      expect(ts.error, `${item.name}: Python raised ${python.error}`).toBeDefined();
    } else {
      expect(ts, item.name).toEqual(python);
    }
  });
  return oracle;
}

const MARKER = 'repair/rate-limited-until';
const COOLDOWNS = 'repair/provider-cooldowns.json';
const marker = (body: string) => ({ [MARKER]: body });
const until = (value: string) => marker(JSON.stringify({ until: value }));

describe('paused', () => {
  it('matches Python for every marker shape', async () => {
    const cases: Case[] = [
      { name: 'absent', op: 'paused' },
      { name: 'future Z', op: 'paused', files: until('2026-11-21T01:00:00Z') },
      { name: 'past Z', op: 'paused', files: until('2026-11-20T23:00:00Z') },
      { name: 'exactly now is expired', op: 'paused', files: until('2026-11-21T00:00:00Z') },
      { name: 'offset future', op: 'paused', files: until('2026-11-21T09:00:00+08:00') },
      { name: 'offset past', op: 'paused', files: until('2026-11-21T07:59:59+08:00') },
      { name: 'fractional', op: 'paused', files: until('2026-11-21T00:00:00.5+00:00') },
      { name: 'space separator', op: 'paused', files: until('2026-11-21 02:00:00Z') },
      { name: 'basic format', op: 'paused', files: until('20261121T020000Z') },
      { name: 'week date', op: 'paused', files: until('2026-W48-6T02:00:00Z') },
      { name: 'naive raises', op: 'paused', files: until('2026-11-21T02:00:00') },
      { name: 'date only raises', op: 'paused', files: until('2026-11-22') },
      {
        name: 'garbage until: mtime window live',
        op: 'paused',
        files: until('soon'),
        mtimes: { [MARKER]: 1_794_528_000 - 600 },
      },
      {
        name: 'garbage until: mtime window expired',
        op: 'paused',
        files: until('soon'),
        mtimes: { [MARKER]: 1_794_528_000 - 3600 },
      },
      {
        name: 'mtime boundary',
        op: 'paused',
        files: until(''),
        mtimes: { [MARKER]: 1_794_528_000 - 1800 },
      },
      {
        name: 'not json',
        op: 'paused',
        files: marker('not json'),
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      { name: 'empty file', op: 'paused', files: marker(''), mtimes: { [MARKER]: 1_794_528_000 } },
      { name: 'list', op: 'paused', files: marker('[]'), mtimes: { [MARKER]: 1_794_528_000 } },
      { name: 'string', op: 'paused', files: marker('"x"'), mtimes: { [MARKER]: 1_794_528_000 } },
      { name: 'null', op: 'paused', files: marker('null'), mtimes: { [MARKER]: 1_794_528_000 } },
      { name: 'no until', op: 'paused', files: marker('{}'), mtimes: { [MARKER]: 1_794_528_000 } },
      {
        name: 'int until',
        op: 'paused',
        files: marker('{"until": 5}'),
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'null until',
        op: 'paused',
        files: marker('{"until": null}'),
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'list until',
        op: 'paused',
        files: marker('{"until": []}'),
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'NaN until',
        op: 'paused',
        files: marker('{"until": NaN}'),
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'BOM',
        op: 'paused',
        files: { [MARKER]: { hex: 'efbbbf7b7d' } },
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'invalid utf-8',
        op: 'paused',
        files: { [MARKER]: { hex: 'ff' } },
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'directory marker',
        op: 'paused',
        files: { [MARKER]: { dir: true } },
        mtimes: { [MARKER]: 1_794_528_000 },
      },
      {
        name: 'fractional mtime',
        op: 'paused',
        files: marker('x'),
        mtimes: { [MARKER]: 1_794_528_000 - 1800 + 0.4 },
        clock: ['2026-11-21T00:00:00.300Z'],
      },
      {
        name: 'explicit now before the end',
        op: 'paused',
        files: until('2026-11-21T01:00:00Z'),
        args: { now: '2026-11-21T00:59:59Z' },
      },
      {
        name: 'explicit now at the end',
        op: 'paused',
        files: until('2026-11-21T01:00:00Z'),
        args: { now: '2026-11-21T01:00:00Z' },
      },
    ];
    const results = await expectParity(cases);
    expect(results[1]?.ok).toBe('2026-11-21T01:00:00Z');
    expect(results[3]?.ok).toBeNull();
    expect(results[10]?.error).toBe('TypeError');
  });
});

describe('blocked', () => {
  const window = {
    tz: 'Asia/Singapore',
    days: [1, 2, 3, 4, 5],
    start: '14:00',
    end: '18:00',
  };
  const repair = (extra: Record<string, unknown> = {}, blackout: unknown = window) => ({
    blackout,
    budget: { wall_clock_min: 60 },
    ...extra,
  });
  // 2026-11-23 is a Monday; Singapore is UTC+8.
  const at = (hhmm: string, date = '2026-11-23') => `${date}T${hhmm}:00Z`;
  const sgt = (hour: number, minute = 0, date = '2026-11-23'): string =>
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;

  it('matches Python across the window edges, reach and weekdays', async () => {
    const cases: Case[] = [];
    const add = (name: string, repairValue: unknown, now: string) =>
      cases.push({ name, op: 'blocked', args: { repair: repairValue, now } });
    for (const [label, hour, minute] of [
      ['before reach', 12, 0],
      ['reach touches start', 13, 0],
      ['one minute before reach', 12, 59],
      ['start', 14, 0],
      ['inside', 15, 30],
      ['last minute', 17, 59],
      ['end excluded', 18, 0],
      ['after', 19, 0],
      ['midnight', 0, 0],
    ] as const) {
      add(label, repair(), sgt(hour, minute));
    }
    add('saturday', repair(), sgt(15, 0, '2026-11-28'));
    add('sunday', repair(), sgt(15, 0, '2026-11-29'));
    add('friday reach into saturday', repair(), sgt(23, 30, '2026-11-27'));
    add('utc view differs from sgt', repair(), at('07:00'));
    add('disabled', repair({}, { ...window, enabled: false }), sgt(15));
    add('enabled true', repair({}, { ...window, enabled: true }), sgt(15));
    add('enabled 0 is not false', repair({}, { ...window, enabled: 0 }), sgt(15));
    add('enabled null is not false', repair({}, { ...window, enabled: null }), sgt(15));
    add('no blackout', { budget: { wall_clock_min: 5 } }, sgt(15));
    add('null blackout', repair({}, null), sgt(15));
    add('empty blackout', repair({}, {}), sgt(15));
    add('empty list blackout', repair({}, []), sgt(15));
    add('string blackout raises', repair({}, 'peak'), sgt(15));
    add('list blackout raises', repair({}, [1]), sgt(15));
    add('days as floats', repair({}, { ...window, days: [1.0, 2.0] }), sgt(15));
    add('days as true is Monday', repair({}, { ...window, days: [true] }), sgt(15));
    add('days as false is nothing', repair({}, { ...window, days: [false, 0] }), sgt(15));
    add('days of strings', repair({}, { ...window, days: ['1'] }), sgt(15));
    add('days empty', repair({}, { ...window, days: [] }), sgt(15));
    add('days as dict', repair({}, { ...window, days: { 1: true } }), sgt(15));
    add('days as string raises', repair({}, { ...window, days: '12345' }), sgt(15));
    add('days as number raises', repair({}, { ...window, days: 1 }), sgt(15));
    add('days as null raises', repair({}, { ...window, days: null }), sgt(15));
    add('missing tz', repair({}, { ...window, tz: undefined }), sgt(15));
    add('null tz', repair({}, { ...window, tz: null }), sgt(15));
    add('unknown tz', repair({}, { ...window, tz: 'Mars/Olympus' }), sgt(15));
    add('offset tz', repair({}, { ...window, tz: '+08:00' }), sgt(15));
    add('utc tz', repair({}, { ...window, tz: 'UTC' }), at('15:00'));
    add('other zone', repair({}, { ...window, tz: 'America/New_York' }), at('19:30'));
    add('dst zone', repair({}, { ...window, tz: 'America/New_York' }), '2026-07-06T19:30:00Z');
    add('missing days', repair({}, { ...window, days: undefined }), sgt(15));
    add(
      'missing start, weekday miss',
      repair({}, { ...window, start: undefined, days: [6] }),
      sgt(15),
    );
    add('missing start, weekday hit', repair({}, { ...window, start: undefined }), sgt(15));
    add('numeric start raises', repair({}, { ...window, start: 14 }), sgt(15));
    add('missing end after a start miss', repair({}, { ...window, end: undefined }), sgt(12));
    add('missing end after a start hit', repair({}, { ...window, end: undefined }), sgt(15));
    add('numeric end raises', repair({}, { ...window, end: 18 }), sgt(15));
    add('unicode bounds', repair({}, { ...window, start: '𝒜', end: 'ｚ' }), sgt(15));
    add('no budget', { blackout: window }, sgt(13, 30));
    add('null budget raises', repair({ budget: null }), sgt(15));
    add('list budget raises', repair({ budget: [] }), sgt(15));
    add('no wall clock', repair({ budget: {} }), sgt(13, 30));
    add('float minutes', repair({ budget: { wall_clock_min: 0.5 } }), sgt(13, 59, '2026-11-23'));
    add('float minutes reach', repair({ budget: { wall_clock_min: 1.5 } }), sgt(13, 58));
    add('bool minutes', repair({ budget: { wall_clock_min: true } }), sgt(13, 59));
    add('false minutes', repair({ budget: { wall_clock_min: false } }), sgt(13, 59));
    add('negative minutes', repair({ budget: { wall_clock_min: -30 } }), sgt(14, 20));
    add('huge minutes', repair({ budget: { wall_clock_min: 1e20 } }), sgt(15));
    add('string minutes raises', repair({ budget: { wall_clock_min: '60' } }), sgt(15));
    add('null minutes raises', repair({ budget: { wall_clock_min: null } }), sgt(15));
    add('list minutes raises', repair({ budget: { wall_clock_min: [] } }), sgt(15));
    add(
      'bad budget raises even when the first check answers',
      repair({ budget: { wall_clock_min: 'x' } }),
      sgt(15),
    );
    add('repair not an object', [], sgt(15));
    await expectParity(cases);
  });

  it('honours the suspended window exactly as configured', () => {
    const inside = new Date('2026-11-23T07:00:00Z');
    expect(blocked(toJson(repair()), inside)).toBe(true);
    expect(blocked(toJson(repair({}, { ...window, enabled: false })), inside)).toBe(false);
  });
});

describe('providerCooldowns', () => {
  const stamp = '2026-11-21T01:00:00Z';
  const doc = (body: unknown) => ({
    [COOLDOWNS]: typeof body === 'string' ? body : JSON.stringify(body),
  });

  it('matches Python for valid, absent and corrupt state', async () => {
    const cases: Case[] = [
      { name: 'absent', op: 'cooldowns' },
      { name: 'empty object', op: 'cooldowns', files: doc({}) },
      {
        name: 'valid',
        op: 'cooldowns',
        files: doc({ zai: stamp, deepseek: '2026-11-20T00:00:00Z' }),
      },
      {
        name: 'duplicate key, last wins',
        op: 'cooldowns',
        files: doc(`{"zai": "${stamp}", "zai": "2026-11-22T00:00:00Z"}`),
      },
      {
        name: 'duplicate key, last invalid',
        op: 'cooldowns',
        files: doc(`{"zai": "${stamp}", "zai": 5}`),
      },
      { name: 'not json', op: 'cooldowns', files: doc('{') },
      { name: 'empty file', op: 'cooldowns', files: doc('') },
      { name: 'list', op: 'cooldowns', files: doc('[]') },
      { name: 'null', op: 'cooldowns', files: doc('null') },
      { name: 'empty stamp', op: 'cooldowns', files: doc({ zai: '' }) },
      { name: 'number stamp', op: 'cooldowns', files: doc({ zai: 5 }) },
      { name: 'null stamp', op: 'cooldowns', files: doc({ zai: null }) },
      { name: 'offset stamp', op: 'cooldowns', files: doc({ zai: '2026-11-21T01:00:00+00:00' }) },
      { name: 'fractional stamp', op: 'cooldowns', files: doc({ zai: '2026-11-21T01:00:00.5Z' }) },
      { name: 'trailing newline stamp', op: 'cooldowns', files: doc({ zai: `${stamp}\n` }) },
      { name: 'lowercase stamp', op: 'cooldowns', files: doc({ zai: '2026-11-21t01:00:00Z' }) },
      { name: 'february 30', op: 'cooldowns', files: doc({ zai: '2026-02-30T00:00:00Z' }) },
      { name: 'leap day', op: 'cooldowns', files: doc({ zai: '2028-02-29T00:00:00Z' }) },
      { name: 'non-leap day', op: 'cooldowns', files: doc({ zai: '2027-02-29T00:00:00Z' }) },
      { name: 'hour 24', op: 'cooldowns', files: doc({ zai: '2026-11-21T24:00:00Z' }) },
      { name: 'hour 24 at year end', op: 'cooldowns', files: doc({ zai: '9999-12-31T24:00:00Z' }) },
      { name: 'second 60', op: 'cooldowns', files: doc({ zai: '2026-11-21T00:00:60Z' }) },
      { name: 'month 13', op: 'cooldowns', files: doc({ zai: '2026-13-01T00:00:00Z' }) },
      { name: 'year 0000', op: 'cooldowns', files: doc({ zai: '0000-01-01T00:00:00Z' }) },
      { name: 'year 0001', op: 'cooldowns', files: doc({ zai: '0001-01-01T00:00:00Z' }) },
      { name: 'arabic-indic digits', op: 'cooldowns', files: doc({ zai: '٢٠٢٦-11-21T01:00:00Z' }) },
      {
        name: 'one bad stamp among good',
        op: 'cooldowns',
        files: doc({ zai: stamp, deepseek: 'x' }),
      },
      { name: 'BOM', op: 'cooldowns', files: { [COOLDOWNS]: { hex: 'efbbbf7b7d' } } },
      { name: 'invalid utf-8', op: 'cooldowns', files: { [COOLDOWNS]: { hex: 'ff' } } },
      { name: 'directory', op: 'cooldowns', files: { [COOLDOWNS]: { dir: true } } },
      { name: 'parent is a file', op: 'cooldowns', files: { repair: 'x' } },
      { name: 'oversized integer', op: 'cooldowns', files: doc(`{"zai": ${'9'.repeat(4301)}}`) },
    ];
    await expectParity(cases);
  });

  it('classifies corrupt state as CooldownStateError', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
    cleanups.push(tmp);
    await mkdir(join(tmp, 'repair'));
    await writeFile(join(tmp, COOLDOWNS), '{"zai": ""}');
    const effects = fileRepairPauseEffects({ stateRoot: tmp, env: {} });
    await expect(effects.providerCooldowns()).rejects.toBeInstanceOf(CooldownStateError);
    expect(validCooldownStamp('2026-11-21T01:00:00Z')).toBe(true);
    expect(validCooldownStamp('')).toBe(false);
  });

  it('fails closed on an unreadable file (EACCES) like Python', async () => {
    if (process.getuid?.() === 0) return; // root reads through mode 0
    const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
    cleanups.push(tmp);
    await mkdir(join(tmp, 'repair'));
    await writeFile(join(tmp, COOLDOWNS), '{}');
    await chmod(join(tmp, COOLDOWNS), 0o000);
    const effects = fileRepairPauseEffects({ stateRoot: tmp, env: {} });
    await expect(effects.providerCooldowns()).rejects.toBeInstanceOf(CooldownStateError);
    await chmod(join(tmp, COOLDOWNS), 0o600);
  });
});

describe('dispatchPaused', () => {
  const role = (driver: string, model: string) => ({ driver, model });
  const config = (repair: Record<string, unknown>) => ({ repair });
  const base = {
    roles: { fixer: role('cq', 'zai/glm-5'), judge: role('cq', 'zai/glm-5') },
    fallback_models: ['deepseek/flash'],
  };
  const allKeys = {
    ZAI_API_KEY: 'k',
    OPENCODE_GO_API_KEY: 'k',
    OPENCODE_GO_BASE_URL: 'u',
    DEEPSEEK_API_KEY: 'k',
  };
  const FUTURE = '2026-11-21T06:00:00Z';
  const PAST = '2026-11-20T06:00:00Z';
  const cooldowns = (body: unknown) => ({
    [COOLDOWNS]: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const live = until('2026-11-21T03:00:00Z');

  it('matches Python for provider fallback and the global pause', async () => {
    const cases: Case[] = [];
    const add = (
      name: string,
      repair: Record<string, unknown>,
      extra: Partial<Case> = {},
    ): number =>
      cases.push({ name, op: 'dispatch_paused', args: { config: config(repair) }, ...extra }) - 1;

    add('no fallback models, no pause', { roles: base.roles });
    add('no fallback models, live pause', { roles: base.roles }, { files: live });
    add('empty fallback models, live pause', { ...base, fallback_models: [] }, { files: live });
    add('fallback null, live pause', { ...base, fallback_models: null }, { files: live });
    add('healthy fallback bypasses the pause', base, { files: live, env: allKeys });
    add('no keys at all: no provider is ready', base, { files: live });
    add('no keys, no pause', base);
    add('only the fallback key', base, { files: live, env: { DEEPSEEK_API_KEY: 'k' } });
    add('empty key is unset', base, {
      files: live,
      env: { ZAI_API_KEY: '', DEEPSEEK_API_KEY: '' },
    });
    add(
      'opencode needs both vars',
      { ...base, fallback_models: ['opencode-go/x'] },
      {
        files: live,
        env: { OPENCODE_GO_API_KEY: 'k' },
      },
    );
    add(
      'opencode with both vars',
      { ...base, fallback_models: ['opencode-go/x'] },
      {
        files: live,
        env: { OPENCODE_GO_API_KEY: 'k', OPENCODE_GO_BASE_URL: 'u' },
      },
    );
    add('every ready provider cooling down', base, {
      files: { ...live, ...cooldowns({ zai: FUTURE, deepseek: FUTURE }) },
      env: allKeys,
    });
    add('one provider cooled, the other ready', base, {
      files: { ...live, ...cooldowns({ zai: FUTURE }) },
      env: allKeys,
    });
    add('cooldown for a provider with no key does not count', base, {
      files: { ...live, ...cooldowns({ zai: FUTURE, deepseek: FUTURE }) },
      env: { ZAI_API_KEY: 'k' },
    });
    add('cooldown expired', base, {
      files: { ...live, ...cooldowns({ zai: PAST, deepseek: FUTURE }) },
      env: allKeys,
    });
    add('cooldown equal to now counts as expired', base, {
      files: { ...live, ...cooldowns({ zai: '2026-11-21T00:00:00Z', deepseek: FUTURE }) },
      env: allKeys,
    });
    add('all cooling, no pause', base, {
      files: cooldowns({ zai: FUTURE, deepseek: FUTURE }),
      env: allKeys,
    });
    add('all cooling, expired pause', base, {
      files: { ...until(PAST), ...cooldowns({ zai: FUTURE, deepseek: FUTURE }) },
      env: allKeys,
    });
    add(
      'unknown provider needs no key',
      { ...base, roles: { fixer: role('cq', 'mystery/x') }, fallback_models: ['mystery/y'] },
      {
        files: live,
      },
    );
    add(
      'unknown provider cooling down',
      { ...base, roles: { fixer: role('cq', 'mystery/x') }, fallback_models: ['mystery/y'] },
      {
        files: { ...live, ...cooldowns({ mystery: FUTURE }) },
      },
    );
    add(
      'codex driver aliases to openai',
      {
        roles: { fixer: role('codex', 'gpt-5.1'), judge: role('codex', 'gpt-5.2') },
        fallback_models: ['deepseek/flash'],
      },
      { files: { ...live, ...cooldowns({ openai: FUTURE }) }, env: { DEEPSEEK_API_KEY: 'k' } },
    );
    add(
      'codex/ prefix aliases to openai',
      {
        roles: { fixer: role('cq', 'codex/gpt-5') },
        fallback_models: ['codex/gpt-6'],
      },
      { files: { ...live, ...cooldowns({ openai: FUTURE }) } },
    );
    add(
      'codex stamped as codex does not apply',
      {
        roles: { fixer: role('cq', 'codex/gpt-5') },
        fallback_models: ['codex/gpt-6'],
      },
      { files: { ...live, ...cooldowns({ codex: FUTURE }) } },
    );
    add(
      'non-cq driver gets no fallbacks',
      {
        roles: { fixer: role('paseo', 'zai/glm-5') },
        fallback_models: ['deepseek/flash'],
      },
      { files: { ...live, ...cooldowns({ zai: FUTURE, deepseek: FUTURE }) }, env: allKeys },
    );
    add(
      'fallback equal to the primary is skipped',
      {
        roles: { fixer: role('cq', 'zai/glm-5') },
        fallback_models: ['zai/glm-5'],
      },
      { files: { ...live, ...cooldowns({ zai: FUTURE }) }, env: allKeys },
    );
    add(
      'no roles',
      { roles: {}, fallback_models: ['deepseek/flash'] },
      { files: live, env: allKeys },
    );
    add(
      'unprefixed model uses the driver',
      {
        roles: { fixer: role('zai', 'glm-5') },
        fallback_models: ['x'],
      },
      { files: { ...live, ...cooldowns({ zai: FUTURE }) }, env: allKeys },
    );
    add(
      'later role ready',
      {
        roles: { a: role('cq', 'zai/glm-5'), b: role('cq', 'deepseek/flash') },
        fallback_models: ['zai/glm-5-air'],
      },
      { files: { ...live, ...cooldowns({ zai: FUTURE }) }, env: allKeys },
    );
    add(
      'extra role keys carry over',
      {
        roles: { fixer: { ...role('cq', 'zai/glm-5'), effort: 'high' } },
        fallback_models: ['deepseek/flash'],
      },
      { files: { ...live, ...cooldowns({ zai: FUTURE, deepseek: FUTURE }) }, env: allKeys },
    );
    // Corrupt cooldown state fails closed to the operator-recovery marker.
    for (const [label, body] of [
      ['not json', '{'],
      ['empty stamp', '{"zai": ""}'],
      ['list', '[]'],
      ['bad date', '{"zai": "2026-02-30T00:00:00Z"}'],
    ] as const) {
      add(`corrupt cooldowns: ${label}`, base, {
        files: { ...live, ...cooldowns(body) },
        env: allKeys,
      });
    }
    add(
      'corrupt cooldowns, no fallback models: ignored',
      { roles: base.roles },
      {
        files: { ...live, ...cooldowns('{') },
      },
    );
    add('cooldown directory fails closed', base, {
      files: { [COOLDOWNS]: { dir: true } },
      env: allKeys,
    });
    // Config shapes that make Python raise.
    add(
      'fallback string iterates characters',
      { ...base, fallback_models: 'ab' },
      { files: live, env: allKeys },
    );
    add(
      'fallback dict iterates keys',
      { ...base, fallback_models: { 'deepseek/flash': 1 } },
      { files: live, env: allKeys },
    );
    add('fallback number raises', { ...base, fallback_models: 1 }, { env: allKeys });
    add('fallback true raises', { ...base, fallback_models: true }, { env: allKeys });
    add('fallback non-string model raises', { ...base, fallback_models: [5] }, { env: allKeys });
    add('fallback null model raises', { ...base, fallback_models: [null] }, { env: allKeys });
    add('roles list raises', { ...base, roles: [role('cq', 'zai/x')] }, { env: allKeys });
    add('roles null raises', { ...base, roles: null }, { env: allKeys });
    add('missing roles raises', { fallback_models: ['x'] }, { env: allKeys });
    add('role string raises', { ...base, roles: { fixer: 'cq' } }, { env: allKeys });
    add(
      'role without driver raises',
      { ...base, roles: { fixer: { model: 'zai/x' } } },
      { env: allKeys },
    );
    add(
      'role without model raises',
      { ...base, roles: { fixer: { driver: 'cq' } } },
      { env: allKeys },
    );
    add(
      'role numeric model raises',
      { ...base, roles: { fixer: role('cq', 5 as never) } },
      { env: allKeys },
    );
    add(
      'role driver list, no slash, raises',
      {
        ...base,
        roles: { fixer: { driver: ['cq'], model: 'plain' } },
      },
      { env: allKeys },
    );
    add(
      'role driver list, slash model, still needs a driver',
      {
        ...base,
        roles: { fixer: { driver: ['cq'], model: 'zai/x' } },
      },
      { env: allKeys },
    );
    add(
      'role driver number, no slash, never matches',
      {
        roles: { fixer: { driver: 5, model: 'plain' } },
        fallback_models: ['x'],
      },
      { files: live, env: allKeys },
    );
    add(
      'role driver null, no slash, never matches',
      {
        roles: { fixer: { driver: null, model: 'plain' } },
        fallback_models: ['x'],
      },
      { files: live, env: allKeys },
    );
    add('repair missing raises', {}, {});
    cases.push({
      name: 'repair not an object',
      op: 'dispatch_paused',
      args: { config: { repair: [] } },
    });
    cases.push({ name: 'config not an object', op: 'dispatch_paused', args: { config: [] } });
    cases.push({ name: 'config without repair', op: 'dispatch_paused', args: { config: {} } });
    // The clock: `utc()` is read after the cooldowns, then once more for `paused()`.
    cases.push({
      name: 'cooldown expires between the two reads',
      op: 'dispatch_paused',
      args: { config: config(base) },
      files: {
        ...live,
        ...cooldowns({ zai: '2026-11-21T00:00:30Z', deepseek: '2026-11-21T00:00:30Z' }),
      },
      env: allKeys,
      clock: ['2026-11-21T00:00:00Z', '2026-11-21T00:01:00Z'],
    });
    cases.push({
      name: 'pause lapses between the two reads',
      op: 'dispatch_paused',
      args: { config: config({ roles: base.roles }) },
      files: until('2026-11-21T00:00:30Z'),
      clock: ['2026-11-21T00:00:00Z'],
    });
    const results = await expectParity(cases);
    expect(results[4]?.ok).toBeNull();
    expect(results[5]?.ok).toBe('2026-11-21T03:00:00Z');
    expect(results.filter((r) => r.ok === OPERATOR_RECOVERY_PAUSE)).toHaveLength(5);
  });
});

describe('rateLimitPause', () => {
  const job = 'crq-abc-F1';
  const stateFiles = (body: string) => ({ [MARKER]: body });
  const add = (cases: Case[], name: string, report: unknown, extra: Partial<Case> = {}): void => {
    cases.push({
      name,
      op: 'rate_limit_pause',
      args: { report, job },
      clock: ['2026-11-21T00:00:00.750Z', '2026-11-21T00:00:01Z', '2026-11-21T00:00:02.250Z'],
      ...extra,
    });
  };

  it('matches Python for retry hints, signals and existing pauses', async () => {
    const cases: Case[] = [];
    add(cases, 'no hint: thirty minutes', {});
    add(cases, 'retry_after_ms', { retry_after_ms: 120_000 });
    add(cases, 'retry_after_ms float', { retry_after_ms: 1500.9 });
    add(cases, 'retry_after_ms tiny float', { retry_after_ms: 0.0004 });
    add(cases, 'retry_after_ms half-microsecond tie', { retry_after_ms: 0.0005 });
    add(cases, 'retry_after_ms capped at a day', { retry_after_ms: 999_999_999_999 });
    add(cases, 'retry_after_ms zero', { retry_after_ms: 0 });
    add(cases, 'retry_after_ms negative', { retry_after_ms: -5 });
    add(cases, 'retry_after_ms true is not a number', { retry_after_ms: true });
    add(cases, 'retry_after_ms false', { retry_after_ms: false });
    add(cases, 'retry_after_ms string', { retry_after_ms: '5000' });
    add(cases, 'retry_after_ms list', { retry_after_ms: [5000] });
    add(cases, 'retry_after_ms null falls to signals', {
      retry_after_ms: null,
      providerSignals: { retryAfterMs: 90_000 },
    });
    add(cases, 'retry_after_ms zero does not fall to signals', {
      retry_after_ms: 0,
      providerSignals: { retryAfterMs: 90_000 },
    });
    add(cases, 'signals only', { providerSignals: { retryAfterMs: 61_000 } });
    add(cases, 'signals null', { providerSignals: null });
    add(cases, 'signals empty list', { providerSignals: [] });
    add(cases, 'signals empty string', { providerSignals: '' });
    add(cases, 'signals zero', { providerSignals: 0 });
    add(cases, 'signals truthy list raises', { providerSignals: [1] });
    add(cases, 'signals truthy string raises', { providerSignals: 'slow' });
    add(cases, 'signals truthy number raises', { providerSignals: 3 });
    add(cases, 'signals without retryAfterMs', { providerSignals: { other: 1 } });
    add(cases, 'huge retry raises', { retry_after_ms: 1e20 });
    add(cases, 'the largest timedelta', { retry_after_ms: 8.6399999999999984e16 });
    add(cases, 'just past timedelta.max raises', { retry_after_ms: 86400000000000000 });
    add(cases, 'infinity raises', JSON.parse('{}'), { args: { report: 'INF', job } });
    add(cases, 'report is a list', []);
    add(cases, 'report is a string', 'rate limited');
    add(cases, 'report is null', null);
    add(
      cases,
      'job id is any JSON',
      { retry_after_ms: 1000 },
      { args: { report: { retry_after_ms: 1000 }, job: { n: [1, 2.5, null, 'é'] } } },
    );
    add(cases, 'job id null', {}, { args: { report: {}, job: null } });
    add(
      cases,
      'existing longer pause is kept',
      {},
      { files: stateFiles('{"until": "2026-11-21T03:00:00Z"}') },
    );
    add(
      cases,
      'existing shorter pause is replaced',
      { retry_after_ms: 7_200_000 },
      { files: stateFiles('{"until": "2026-11-21T00:10:00Z"}') },
    );
    add(
      cases,
      'existing equal pause',
      { retry_after_ms: 1_800_000 },
      { files: stateFiles('{"until": "2026-11-21T00:30:00Z"}') },
    );
    add(
      cases,
      'existing expired pause',
      {},
      { files: stateFiles('{"until": "2026-11-20T00:10:00Z"}') },
    );
    add(
      cases,
      'existing offset pause compares as text',
      {},
      { files: stateFiles('{"until": "2026-11-21T09:00:00+08:00"}') },
    );
    add(
      cases,
      'existing later offset pause compares as text',
      {},
      { files: stateFiles('{"until": "2026-11-21T20:00:00+08:00"}') },
    );
    add(
      cases,
      'existing naive pause raises',
      {},
      { files: stateFiles('{"until": "2026-11-21T03:00:00"}') },
    );
    add(
      cases,
      'existing unreadable pause, live mtime',
      {},
      {
        files: stateFiles('garbage'),
        mtimes: { [MARKER]: 1_794_528_000 - 60 },
      },
    );
    add(
      cases,
      'existing unreadable pause, expired mtime',
      {},
      {
        files: stateFiles('garbage'),
        mtimes: { [MARKER]: 1_794_528_000 - 7200 },
      },
    );
    add(
      cases,
      'existing marker is a directory',
      {},
      { files: { [MARKER]: { dir: true } }, mtimes: { [MARKER]: 1_794_528_000 } },
    );
    add(cases, 'state dir missing entirely', {});
    add(cases, 'repair dir already present', {}, { files: { 'repair/other.json': '{}' } });
    add(
      cases,
      'pause stamp crosses midnight',
      { retry_after_ms: 3_600_000 },
      { clock: ['2026-11-21T23:30:00.999Z', '2026-11-21T23:30:01Z', '2026-11-21T23:30:02Z'] },
    );
    const results = await expectParity(cases);
    expect(results[0]?.ok).toBe('2026-11-21T00:30:00Z');
    expect(results[5]?.ok).toBe('2026-11-22T00:00:00Z');
    expect(results[32]?.ok).toBe('2026-11-21T03:00:00Z');
  });

  it('writes the marker the next paused() reads back', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
    cleanups.push(tmp);
    let clock = new Date('2026-11-21T00:00:00Z');
    const effects = fileRepairPauseEffects({ stateRoot: tmp, now: () => clock, env: {} });
    expect(await effects.paused()).toBeNull();
    const end = await effects.rateLimitPause(toJson({ retry_after_ms: 60_000 }), 'job-1');
    expect(end).toBe('2026-11-21T00:01:00Z');
    expect(await effects.paused()).toBe(end);
    clock = new Date('2026-11-21T00:01:00Z');
    expect(await effects.paused()).toBeNull();
    expect(JSON.parse(await readFile(join(tmp, MARKER), 'utf8'))).toEqual({
      until: end,
      job: 'job-1',
      at: '2026-11-21T00:00:00Z',
    });
  });

  it('holds the injected lock across the read and the write only', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
    cleanups.push(tmp);
    const events: string[] = [];
    const effects = fileRepairPauseEffects({
      stateRoot: tmp,
      now: () => new Date('2026-11-21T00:00:00Z'),
      env: {},
      lock: async (fn) => {
        events.push('lock');
        try {
          return await fn();
        } finally {
          events.push('unlock');
        }
      },
    });
    await effects.rateLimitPause(toJson({}), 'job');
    expect(events).toEqual(['lock', 'unlock']);
    expect(await effects.paused()).toBe('2026-11-21T00:30:00Z');
  });
});

describe('inert module surface', () => {
  it('reads and writes only under the injected state root', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'crq-pause-ts-'));
    cleanups.push(tmp);
    const effects = fileRepairPauseEffects({
      stateRoot: join(tmp, 'state'),
      now: () => new Date('2026-11-21T00:00:00Z'),
      env: {},
    });
    await effects.rateLimitPause(new JsonObject([]), null);
    expect((await readdir(tmp)).sort()).toEqual(['state']);
    expect((await readdir(join(tmp, 'state'))).sort()).toEqual(['repair', 'tick.lock']);
  });
});
