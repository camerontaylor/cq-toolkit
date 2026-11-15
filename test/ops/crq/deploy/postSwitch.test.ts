import { describe, expect, test } from 'vitest';
import {
  OSError,
  Refused,
  compatibilityReason,
  measureCqBin,
  pyRepr,
  readConfig,
  recheckBaseline,
  restartTriggers,
  runtimePointerCheck,
  verifyAfterSwitch,
  type CqBinRecord,
  type LiveConfigEffects,
  type PostSwitchController,
  type PreservedDigests,
} from '../../../../src/ops/crq/deploy/postSwitch.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cfg = (repair: unknown): Uint8Array => enc(JSON.stringify({ repair }));

interface Files {
  [path: string]: { sha: string; mode: number; real?: string };
}
function fsFx(
  config: Uint8Array | Error,
  files: Files = {},
  log: string[] = [],
): LiveConfigEffects {
  return {
    readFile: async (p) => {
      log.push(`read:${p}`);
      if (config instanceof Error) throw config;
      return config;
    },
    isFile: async (p) => p in files,
    sha256File: async (p) => files[p]!.sha,
    modeBits: async (p) => files[p]!.mode,
    resolve: async (p) => files[p]?.real ?? p,
  };
}
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Refused);
    return (e as Error).message;
  }
  throw new Error('did not throw');
};

describe('readConfig', () => {
  test('reads <root>/apps/crq-python/config.json', async () => {
    const log: string[] = [];
    const bytes = enc('x');
    expect(await readConfig(fsFx(bytes, {}, log), '/live')).toBe(bytes);
    await readConfig(fsFx(bytes, {}, log), '/live/');
    expect(log).toEqual([
      'read:/live/apps/crq-python/config.json',
      'read:/live/apps/crq-python/config.json',
    ]);
  });
  test('an OSError becomes Refused naming path and cause; other errors pass through', async () => {
    expect(await refusal(readConfig(fsFx(new OSError('ENOENT')), '/live'))).toBe(
      'cannot read live config /live/apps/crq-python/config.json: ENOENT',
    );
    await expect(readConfig(fsFx(new RangeError('boom')), '/live')).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('measureCqBin', () => {
  const files: Files = { '/opt/cq': { sha: 'ab'.repeat(32), mode: 0o755, real: '/opt/real/cq' } };
  test('measures an existing entry', async () => {
    const m = await measureCqBin(fsFx(enc(''), files), cfg({ cq_bin: '/opt/cq' }));
    expect(m).toEqual({
      pointer: '/opt/cq',
      placeholder: false,
      exists: true,
      sha256: 'ab'.repeat(32),
      mode: '0o755',
      resolved: '/opt/real/cq',
    });
  });
  test('a missing entry is recorded as not existing, with no digest', async () => {
    expect(await measureCqBin(fsFx(enc('')), cfg({ cq_bin: '/opt/none' }))).toEqual({
      pointer: '/opt/none',
      placeholder: false,
      exists: false,
      sha256: null,
      mode: null,
      resolved: null,
    });
  });
  test('a placeholder is recorded without touching the filesystem', async () => {
    const fx = {
      ...fsFx(enc('')),
      isFile: async () => {
        throw new Error('touched');
      },
    };
    expect(await measureCqBin(fx, cfg({ cq_bin: 'x/@HOST_CQ_BIN@/y' }))).toEqual({
      pointer: 'x/@HOST_CQ_BIN@/y',
      placeholder: true,
      exists: false,
      sha256: null,
      mode: null,
      resolved: null,
    });
  });
  test.each([
    ['no repair', {}],
    ['null repair', { repair: null }],
    ['empty repair', { repair: {} }],
    ['falsy repair', { repair: 0 }],
    ['no cq_bin', { repair: { x: 1 } }],
    ['empty cq_bin', { repair: { cq_bin: '' } }],
    ['non-string cq_bin', { repair: { cq_bin: 5 } }],
  ])('%s refuses as unknown runtime', async (_n, config) => {
    expect(await refusal(measureCqBin(fsFx(enc('')), enc(JSON.stringify(config))))).toBe(
      'live config carries no repair.cq_bin pointer; the runtime this deploy would execute is unknown',
    );
  });
  test('a relative pointer is refused with its repr', async () => {
    expect(await refusal(measureCqBin(fsFx(enc('')), cfg({ cq_bin: "bin/c'q" })))).toBe(
      `live repair.cq_bin is not an absolute path: "bin/c'q"`,
    );
  });
  test('invalid JSON and invalid UTF-8 are Refused', async () => {
    expect(await refusal(measureCqBin(fsFx(enc('')), enc('{')))).toContain(
      'live config is not valid JSON: ',
    );
    expect(await refusal(measureCqBin(fsFx(enc('')), new Uint8Array([0xff, 0xfe])))).toContain(
      'live config is not valid JSON: ',
    );
  });
  test('a non-object config or repair is a plain crash (Python AttributeError)', async () => {
    for (const bad of ['[]', '3', 'null', '{"repair": [1]}', '{"repair": "s"}']) {
      const e = await measureCqBin(fsFx(enc('')), enc(bad)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TypeError);
    }
  });
  test('a non-array falsy repair such as [] is treated as empty', async () => {
    expect(await refusal(measureCqBin(fsFx(enc('')), enc('{"repair": []}')))).toContain(
      'no repair.cq_bin',
    );
  });
});

describe('compatibilityReason / pyRepr', () => {
  test.each([
    [null, 'the compatibility record was not checked'],
    [[], 'the compatibility record was not checked'],
    [{}, 'the compatibility record was not checked'],
    [{ checked: 1 }, 'the compatibility record was not checked'],
    [
      { checked: true, schema_marker_present: true, queue_schema: 'unreadable: bad json' },
      'the state queue could not be read (bad json)',
    ],
    [
      { checked: true, schema_marker_present: true, queue_schema: 'v2' },
      "the queue carries an explicit schema marker ('v2') the prior target was never proven to read",
    ],
    [
      { checked: true, queue_schema: null },
      'the queue carries an explicit schema marker (None) the prior target was never proven to read',
    ],
    [
      {
        checked: true,
        schema_marker_present: false,
        schema_observations: ['author_a', 'author_b'],
      },
      'the queue carries state keys the prior target was never proven to read: author_a, author_b',
    ],
    [
      { checked: true, schema_marker_present: false, schema_observations: [] },
      'the compatibility record is not the clean shape',
    ],
    [
      { checked: true, schema_marker_present: false },
      'the compatibility record is not the clean shape',
    ],
  ])('%j', (rec, text) => {
    expect(compatibilityReason(rec)).toBe(text);
  });
  test('repr follows Python quoting', () => {
    expect(pyRepr("a'b")).toBe(`"a'b"`);
    expect(pyRepr(`a'b"c`)).toBe(`'a\\'b"c'`);
    expect(pyRepr('a\nb\\')).toBe("'a\\nb\\\\'");
    expect(pyRepr('\x01')).toBe("'\\x01'");
    expect(pyRepr(null)).toBe('None');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr([1, 'x', false])).toBe("[1, 'x', False]");
    expect(pyRepr({ a: null })).toBe("{'a': None}");
  });
});

const cqBin: CqBinRecord = {
  pointer: '/opt/cq',
  placeholder: false,
  exists: true,
  sha256: 'ab'.repeat(32),
  mode: '0o755',
  resolved: '/opt/cq',
};
const files: Files = { '/opt/cq': { sha: 'ab'.repeat(32), mode: 0o755 } };
const config = cfg({ cq_bin: '/opt/cq' });

function controller(
  over: Partial<PostSwitchController> = {},
  log: string[] = [],
): PostSwitchController {
  return {
    preservedDigests: async () => {
      log.push('digests');
      return { queue: 'q1', state: 's1' };
    },
    compatibilityRecord: async (sha) => {
      log.push(`compat:${sha}`);
      return { checked: true, schema_marker_present: false };
    },
    rollbackCompatible: () => true,
    ...over,
  };
}

describe('recheckBaseline', () => {
  const base = (over: object = {}, log: string[] = []) => ({
    effects: fsFx(config, files),
    controller: controller({}, log),
    root: '/live',
    originalConfig: config,
    cqBin,
    target: 't'.repeat(40),
    phase: (n: string, e: Record<string, unknown>) =>
      void log.push(`phase:${n}:${JSON.stringify(e)}`),
    ...over,
  });
  test('returns the new baseline and records the sorted keys', async () => {
    const log: string[] = [];
    const out = await recheckBaseline(base({}, log));
    expect(out).toEqual({ queue: 'q1', state: 's1' });
    expect(log).toEqual([
      'digests',
      `compat:${'t'.repeat(40)}`,
      'phase:remeasured:{"preserved":["queue","state"]}',
    ]);
  });
  test('keys are sorted by code point', async () => {
    const log: string[] = [];
    await recheckBaseline(
      base({
        controller: controller({ preservedDigests: async () => ({ b: '1', B: '2', a: '3' }) }),
        phase: (_n: string, e: Record<string, unknown>) => log.push(JSON.stringify(e)),
      }),
    );
    expect(log).toEqual(['{"preserved":["B","a","b"]}']);
  });
  test('a changed config refuses before any controller call', async () => {
    const log: string[] = [];
    const msg = await refusal(recheckBaseline(base({ effects: fsFx(enc('other'), files) }, log)));
    expect(msg).toBe('live config changed while admission was being held; nothing was switched');
    expect(log).toEqual([]);
  });
  test('a config differing by one byte or length refuses', async () => {
    for (const changed of [
      enc(new TextDecoder().decode(config) + ' '),
      enc(new TextDecoder().decode(config).replace('cq"', 'cx"')),
    ]) {
      await refusal(recheckBaseline(base({ effects: fsFx(changed, files) })));
    }
  });
  test('a truncated config (strict prefix of the original) refuses', async () => {
    await refusal(
      recheckBaseline(base({ originalConfig: enc(`${new TextDecoder().decode(config)} `) })),
    );
  });
  test('a retargeted symlink with identical bytes refuses (resolved differs)', async () => {
    await refusal(
      recheckBaseline(
        base({
          effects: fsFx(config, {
            '/opt/cq': { sha: 'ab'.repeat(32), mode: 0o755, real: '/elsewhere' },
          }),
        }),
      ),
    );
  });
  test('a baseline recorded without the placeholder flag refuses against a placeholder pointer', async () => {
    const asPlaceholder = cfg({ cq_bin: '@HOST_CQ_BIN@' });
    const recorded: CqBinRecord = {
      pointer: '@HOST_CQ_BIN@',
      placeholder: false,
      exists: false,
      sha256: null,
      mode: null,
      resolved: null,
    };
    await refusal(
      recheckBaseline(
        base({ effects: fsFx(asPlaceholder), originalConfig: asPlaceholder, cqBin: recorded }),
      ),
    );
  });
  test('a baseline claiming existence of a missing entry refuses (exists differs alone)', async () => {
    const recorded: CqBinRecord = {
      pointer: '/opt/cq',
      placeholder: false,
      exists: true,
      sha256: null,
      mode: null,
      resolved: null,
    };
    await refusal(recheckBaseline(base({ effects: fsFx(config, {}), cqBin: recorded })));
  });
  test('a key that is a prefix of another sorts first', async () => {
    const log: string[] = [];
    await recheckBaseline(
      base({
        controller: controller({ preservedDigests: async () => ({ ab: '1', a: '2' }) }),
        phase: (_n: string, e: Record<string, unknown>) => log.push(JSON.stringify(e)),
      }),
    );
    expect(log).toEqual(['{"preserved":["a","ab"]}']);
  });
  test('keys sort by code point, not UTF-16 unit', async () => {
    const log: string[] = [];
    await recheckBaseline(
      base({
        controller: controller({
          preservedDigests: async () => ({ '\u{10000}': '1', '\uffff': '2' }),
        }),
        phase: (_n: string, e: Record<string, unknown>) => log.push(JSON.stringify(e)),
      }),
    );
    expect(log).toEqual([JSON.stringify({ preserved: ['\uffff', '\u{10000}'] })]);
  });
  test('a moved runtime (same pointer, new bytes) refuses', async () => {
    const msg = await refusal(
      recheckBaseline(
        base({ effects: fsFx(config, { '/opt/cq': { sha: 'cd'.repeat(32), mode: 0o755 } }) }),
      ),
    );
    expect(msg).toBe(
      'the runtime pointer changed while admission was being held; nothing was switched',
    );
  });
  test('a different mode alone refuses', async () => {
    await refusal(
      recheckBaseline(
        base({ effects: fsFx(config, { '/opt/cq': { sha: 'ab'.repeat(32), mode: 0o700 } }) }),
      ),
    );
  });
  test('a rollback denial names its reason and records no phase', async () => {
    const log: string[] = [];
    const msg = await refusal(
      recheckBaseline(
        base(
          {
            controller: controller(
              {
                rollbackCompatible: () => false,
                compatibilityRecord: async () => ({ checked: false }),
              },
              log,
            ),
          },
          log,
        ),
      ),
    );
    expect(msg).toBe(
      'the queue no longer grants automatic rollback after the drain: the compatibility record was not checked; nothing was switched',
    );
    expect(log.some((l) => l.startsWith('phase'))).toBe(false);
  });
});

describe('runtimePointerCheck', () => {
  test('passes when pointer and bytes are unchanged', async () => {
    await runtimePointerCheck(fsFx(config, files), '/live', cqBin);
  });
  test('refuses a moved pointer', async () => {
    expect(
      await refusal(
        runtimePointerCheck(
          fsFx(cfg({ cq_bin: '/opt/new' }), { '/opt/new': { sha: 'ab'.repeat(32), mode: 0o755 } }),
          '/live',
          cqBin,
        ),
      ),
    ).toBe(
      "the switch moved repair.cq_bin from '/opt/cq' to '/opt/new'; a runtime pointer move is a separate, measured decision",
    );
  });
  test('refuses changed bytes, and a missing entry', async () => {
    expect(
      await refusal(
        runtimePointerCheck(
          fsFx(config, { '/opt/cq': { sha: 'cd'.repeat(32), mode: 0o755 } }),
          '/live',
          cqBin,
        ),
      ),
    ).toBe(
      `the runtime at /opt/cq is not the measured entry (${'ab'.repeat(32)}); refusing to restart against unverified bytes`,
    );
    await refusal(runtimePointerCheck(fsFx(config, {}), '/live', cqBin));
  });
  test('a placeholder baseline checks only the pointer', async () => {
    const ph: CqBinRecord = {
      ...cqBin,
      pointer: '@HOST_CQ_BIN@',
      placeholder: true,
      exists: false,
      sha256: null,
    };
    await runtimePointerCheck(fsFx(cfg({ cq_bin: '@HOST_CQ_BIN@' })), '/live', ph);
    await refusal(runtimePointerCheck(fsFx(cfg({ cq_bin: '/opt/cq' }), files), '/live', ph));
  });
});

describe('verifyAfterSwitch', () => {
  const preserved: PreservedDigests = { queue: 'q1', state: 's1' };
  const args = (c: PostSwitchController) => ({
    effects: fsFx(config, files),
    controller: c,
    root: '/live',
    cqBin,
    preserved,
    priorSha: 'p'.repeat(40),
  });
  test('a clean switch keeps rollback permitted and asks compat for the prior sha', async () => {
    const log: string[] = [];
    const r = await verifyAfterSwitch(args(controller({}, log)));
    expect(r.rollbackDisabled).toBeNull();
    expect(r.postCompatibility).toEqual({ checked: true, schema_marker_present: false });
    expect(log).toEqual(['digests', `compat:${'p'.repeat(40)}`]);
  });
  test('a denied rollback is recorded, not refused', async () => {
    const r = await verifyAfterSwitch(
      args(
        controller({
          rollbackCompatible: () => false,
          compatibilityRecord: async () => ({
            checked: true,
            schema_marker_present: true,
            queue_schema: 'v9',
          }),
        }),
      ),
    );
    expect(r.rollbackDisabled).toBe(
      "the queue carries an explicit schema marker ('v9') the prior target was never proven to read",
    );
  });
  test('a pointer move is refused before the queue is read', async () => {
    const log: string[] = [];
    await refusal(
      verifyAfterSwitch({
        ...args(controller({}, log)),
        effects: fsFx(cfg({ cq_bin: '/x' }), { '/x': { sha: 'ab'.repeat(32), mode: 0o755 } }),
      }),
    );
    expect(log).toEqual([]);
  });
  test('changed digests are listed sorted and fail the deploy', async () => {
    const msg = await refusal(
      verifyAfterSwitch(
        args(controller({ preservedDigests: async () => ({ queue: 'q2', state: 's2' }) })),
      ),
    );
    expect(msg).toBe(
      'shared queue state changed during the switch: queue, state; this deploy is failed',
    );
    const one = await refusal(
      verifyAfterSwitch(
        args(controller({ preservedDigests: async () => ({ queue: 'q1', state: 'x' }) })),
      ),
    );
    expect(one).toContain(': state;');
  });
  test('a key that vanished counts as changed, but null→absent does not', async () => {
    await refusal(
      verifyAfterSwitch(args(controller({ preservedDigests: async () => ({ queue: 'q1' }) }))),
    );
    await verifyAfterSwitch({
      ...args(controller({ preservedDigests: async () => ({}) })),
      preserved: { gone: null },
    });
  });
  test('a new key observed after the switch is ignored', async () => {
    await verifyAfterSwitch(
      args(
        controller({ preservedDigests: async () => ({ queue: 'q1', state: 's1', extra: 'z' }) }),
      ),
    );
  });
});

describe('restartTriggers', () => {
  const original = { 'crq-b.timer': 'active', 'crq-a.timer': 'active', 'crq-c.timer': 'inactive' };
  const triggers = ['crq-a.timer', 'crq-b.timer', 'crq-c.timer'];
  function units(states: Record<string, string>[], log: string[] = []) {
    let read = 0;
    return {
      log,
      start: async (u: readonly string[]) => void log.push(`start:${u.join(',')}`),
      state: async (u: string) => {
        log.push(`state:${u}`);
        const round = Math.min(Math.floor(read++ / triggers.length), states.length - 1);
        return states[round]![u]!;
      },
    };
  }
  test('starts only the active units, sorted, then reads twice', async () => {
    const u = units([original, original]);
    expect(await restartTriggers(u, triggers, original)).toEqual(original);
    expect(u.log).toEqual([
      'start:crq-a.timer,crq-b.timer',
      ...triggers.map((t) => `state:${t}`),
      ...triggers.map((t) => `state:${t}`),
    ]);
  });
  test('an empty active set still calls start', async () => {
    const u = units([{ 'crq-a.timer': 'inactive' }]);
    await restartTriggers(u, ['crq-a.timer'], { 'crq-a.timer': 'inactive' });
    expect(u.log[0]).toBe('start:');
  });
  test('a first-read mismatch refuses with both sorted maps and does not read twice', async () => {
    const bad = { ...original, 'crq-a.timer': 'failed' };
    const u = units([bad]);
    expect(await refusal(restartTriggers(u, triggers, original))).toBe(
      'trigger restart mismatch: observed {"crq-a.timer": "failed", "crq-b.timer": "active", "crq-c.timer": "inactive"} expected {"crq-a.timer": "active", "crq-b.timer": "active", "crq-c.timer": "inactive"}',
    );
    expect(u.log.filter((l) => l.startsWith('state')).length).toBe(3);
  });
  test('a second-read flap refuses with the second read', async () => {
    const flap = { ...original, 'crq-b.timer': 'activating' };
    expect(await refusal(restartTriggers(units([original, flap]), triggers, original))).toBe(
      'trigger restart verification mismatch: second read {"crq-a.timer": "active", "crq-b.timer": "activating", "crq-c.timer": "inactive"}',
    );
  });
  test('a trigger set that differs from the original keys refuses', async () => {
    await refusal(restartTriggers(units([original]), ['crq-a.timer', 'crq-b.timer'], original));
  });
  test('a start failure propagates before any read', async () => {
    const u = {
      start: async () => {
        throw new Error('bus');
      },
      state: async () => 'active',
    };
    await expect(restartTriggers(u, triggers, original)).rejects.toThrow('bus');
  });
});
