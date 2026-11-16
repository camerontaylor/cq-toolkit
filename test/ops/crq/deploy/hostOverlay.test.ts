import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../../src/policy/crq/jsonValue.js';
import {
  apply,
  changedFields,
  digest,
  driftCheck,
  encode,
  formatsWithItem,
  hostPath,
  leaves,
  outside,
  PythonError,
  render,
  validate,
  ValueError,
} from '../../../../src/ops/crq/deploy/hostOverlay.js';

const J = (v: unknown): JsonValue => parseJsonValue(JSON.stringify(v));
const JO = (v: unknown): JsonObject => J(v) as JsonObject;
const id = (p: string): string => p;
const cfg = (): Record<string, unknown> => ({
  clone: '/srv/review/clone',
  worktree_root: '/srv/review/wt',
  timeout_bin: '/usr/bin/timeout',
  paseo_hosts: ['a:1', 'b:2'],
  repair: { enabled: false, cq_bin: '/usr/bin/cq', paseo_host: 'a:1' },
  alerts: { alert_agent_host: 'a:1' },
});
const overlay = (over: Record<string, unknown> = {}, config = cfg()): JsonObject =>
  JO({
    schema_version: 1,
    deploy_root: '/srv/deploy',
    record_dir: '/srv/records',
    config,
    fleet_reader: { ssh_host: 'h1', source: '/srv/fleet' },
    ...over,
  });
const bad = (o: JsonValue, msg: RegExp | string, resolve = id): void => {
  expect(() => validate(o, resolve)).toThrow(msg);
  expect(() => validate(o, resolve)).toThrow(ValueError);
};

describe('hostPath / outside', () => {
  test('accepts clean absolute paths and normalises', () => {
    expect(hostPath('/a/b//c/./d')).toBe('/a/b/c/d');
  });
  test.each(['rel', '/a b', '/a%h', '/a/../b', '', '/a$x', '/é', '/a\n'])('refuses %j', (v) => {
    expect(() => hostPath(v)).toThrow(ValueError);
  });
  test('refuses non-strings', () => {
    expect(() => hostPath(3)).toThrow(ValueError);
  });
  test('outside is containment on resolved paths', () => {
    expect(outside('/a/b', '/a', id)).toBe(false);
    expect(outside('/a', '/a', id)).toBe(false);
    expect(outside('/ab', '/a', id)).toBe(true);
    expect(outside('/x', '/', id)).toBe(false);
    expect(outside('/a/link', '/a', (p) => (p === '/a/link' ? '/elsewhere' : p))).toBe(true);
  });
});

describe('leaves', () => {
  test('flattens to allowlisted dotted names in order', () => {
    expect(
      leaves(JO({ clone: '/c', repair: { enabled: true, blackout: { enabled: false } } })),
    ).toEqual([
      ['clone', '/c'],
      ['repair.enabled', true],
      ['repair.blackout.enabled', false],
    ]);
  });
  test.each([{}, { nope: 1 }, { repair: {} }, { repair: { x: 1 } }])('refuses %j', (v) => {
    expect(() => leaves(JO(v))).toThrow(ValueError);
  });
  test('refuses non-object', () => {
    expect(() => leaves(J([1]))).toThrow(ValueError);
  });
});

describe('validate', () => {
  test('accepts the minimal overlay and returns it', () => {
    const o = overlay();
    expect(validate(o, id)).toBe(o);
  });
  test('top-level schema', () => {
    bad(J([1]), 'top-level');
    bad(overlay({ extra: 1 }), 'top-level');
    const o = overlay();
    bad(new JsonObject(o.entries.slice(1)), 'top-level');
    bad(overlay({ schema_version: 2 }), 'schema_version');
    bad(overlay({ schema_version: '1' }), 'schema_version');
    bad(overlay({ schema_version: 1.5 }), 'schema_version');
  });
  test('record_dir must be outside deploy_root', () => {
    bad(overlay({ record_dir: '/srv/deploy/records' }), 'outside the checkout');
    bad(overlay({ record_dir: '/srv/records' }), /outside the checkout/, () => '/srv/deploy/x');
  });
  test('missing required and alert host', () => {
    const c = cfg();
    delete c.timeout_bin;
    delete (c.repair as Record<string, unknown>).cq_bin;
    bad(overlay({}, c), 'missing host config keys: repair.cq_bin, timeout_bin');
    const d = cfg();
    delete d.alerts;
    bad(overlay({}, d), 'missing host config keys: alerts.alert_agent_host');
  });
  test('promotion alert host also satisfies', () => {
    const d = cfg();
    delete d.alerts;
    d.promotion = { alert_agent_host: 'a:1' };
    expect(() => validate(overlay({}, d), id)).not.toThrow();
  });
  test('booleans must be JSON booleans', () => {
    bad(
      overlay({}, { ...cfg(), repair: { enabled: 1, cq_bin: '/x', paseo_host: 'a:1' } }),
      'true or false',
    );
  });
  test('max_concurrent_items bounds and int-ness', () => {
    const mk = (v: unknown): JsonObject =>
      overlay(
        {},
        {
          ...cfg(),
          repair: { enabled: false, cq_bin: '/x', paseo_host: 'a:1', max_concurrent_items: v },
        },
      );
    expect(() => validate(mk(1), id)).not.toThrow();
    expect(() => validate(mk(10), id)).not.toThrow();
    for (const v of [0, 11, 1.5, true, '3', -1]) bad(mk(v), 'integer from 1 to 10');
  });
  test('paseo_hosts', () => {
    const mk = (v: unknown): JsonObject => overlay({}, { ...cfg(), paseo_hosts: v });
    for (const v of [['a'], ['a', 'a'], ['a', ''], ['a', 1], 'ab', []]) bad(mk(v), 'paseo_hosts');
  });
  test('notify.hosts', () => {
    const mk = (v: unknown): JsonObject => overlay({}, { ...cfg(), notify: { hosts: v } });
    expect(() => validate(mk(['h.example:65535', 'a-b:1']), id)).not.toThrow();
    expect(() => validate(mk([]), id)).not.toThrow();
    for (const v of [
      ['h:0'],
      ['h:65536'],
      ['h'],
      ['-h:1'],
      ['h:1'.repeat(1)].concat(Array(32).fill('h:1')),
      [3],
      'h:1',
      ['h:123456'],
    ])
      bad(mk(v), 'notify.hosts');
  });
  test('repos', () => {
    const mk = (v: unknown): JsonObject => overlay({}, { ...cfg(), repos: v });
    expect(() =>
      validate(
        mk([{ repo: 'o/n' }, { repo: 'o/m', clone: '/srv/other' }, { repo: 'o/k', clone: null }]),
        id,
      ),
    ).not.toThrow();
    bad(mk('x'), 'repos must be a list');
    bad(mk([1]), 'entries must be objects');
    bad(mk([{ repo: 'bad' }]), 'owner/name');
    bad(mk([{ repo: 3 }]), 'owner/name');
    bad(mk([{ repo: 'o/n' }, { repo: 'o/n' }]), 'unique');
    bad(mk([{ repo: 'o/n', clone: '/srv/deploy/x' }]), 'separate from deployment');
    bad(mk([{ repo: 'o/n', clone: '/srv' }]), 'separate from deployment');
    bad(mk([{ repo: 'o/n', clone: 'rel' }]), 'host paths');
  });
  test('path keys incl. literal ~/ ssh_key only', () => {
    const sp = (extra: Record<string, unknown>): JsonObject =>
      overlay({}, { ...cfg(), promotion: { signer: { spool: extra } } });
    expect(() => validate(sp({ ssh_key: '~/.ssh/k' }), id)).not.toThrow();
    bad(sp({ dir: '~/x' }), 'host paths');
    bad(overlay({}, { ...cfg(), timeout_bin: '~/x' }), 'host paths');
    bad(sp({ ssh_key: '~/../k' }), 'traversal');
    bad(sp({ ssh_key: 5 }), 'host paths');
  });
  test('alert agent id and ssh alias', () => {
    const u = '01234567-89ab-cdef-0123-456789abcdef';
    expect(() =>
      validate(
        overlay({}, { ...cfg(), alerts: { alert_agent_host: 'a:1', alert_agent_id: u } }),
        id,
      ),
    ).not.toThrow();
    for (const v of [u.toUpperCase(), 'x', 7])
      bad(
        overlay({}, { ...cfg(), alerts: { alert_agent_host: 'a:1', alert_agent_id: v } }),
        'lowercase Paseo',
      );
    const al = (v: unknown): JsonObject =>
      overlay({}, { ...cfg(), promotion: { signer: { spool: { ssh_alias: v } } } });
    expect(() => validate(al('u@h.example:22'), id)).not.toThrow();
    for (const v of ['nohost', '@h', 'u@', 'u@-h', 3]) bad(al(v), 'user@host');
  });
  test('generic host strings', () => {
    for (const v of ['', 'a\nb', 'a\rb', 'a\0b', 4])
      bad(
        overlay({}, { ...cfg(), repair: { enabled: false, cq_bin: '/x', paseo_host: v } }),
        'nonempty strings',
      );
  });
  test('record_url_template', () => {
    const t = (v: unknown): JsonObject =>
      overlay({}, { ...cfg(), promotion: { record_url_template: v } });
    expect(() => validate(t('https://x/{item}'), id)).not.toThrow();
    for (const v of ['https://x/{}', 'https://x/{other}', '{']) bad(t(v), 'record URL template');
    bad(t(5), 'nonempty strings');
  });
  test('review clone/worktrees separate from deploy', () => {
    bad(overlay({}, { ...cfg(), clone: '/srv/deploy/c' }), 'separate from deployment');
    bad(overlay({}, { ...cfg(), clone: '/srv' }), 'separate from deployment');
    bad(overlay({}, { ...cfg(), worktree_root: '/srv/deploy' }), 'separate from deployment');
    bad(overlay({}, { ...cfg(), worktree_root: '/' }), 'host paths');
  });
  test('fleet_reader', () => {
    bad(overlay({ fleet_reader: { ssh_host: 'h' } }), 'fleet_reader accepts only');
    bad(
      overlay({ fleet_reader: { ssh_host: 'h', source: '/x', z: 1 } }),
      'fleet_reader accepts only',
    );
    bad(overlay({ fleet_reader: { ssh_host: 'h', other: '/x' } }), 'fleet_reader accepts only');
    bad(overlay({ fleet_reader: 'x' }), 'fleet_reader accepts only');
    bad(overlay({ fleet_reader: { ssh_host: '-h', source: '/x' } }), 'ssh host');
    bad(overlay({ fleet_reader: { ssh_host: 5, source: '/x' } }), 'ssh host');
    bad(overlay({ fleet_reader: { ssh_host: 'h', source: 'x' } }), 'host paths');
    expect(() =>
      validate(overlay({ fleet_reader: { ssh_host: 'u@h.x_y-1', source: '/x' } }), id),
    ).not.toThrow();
  });
});

describe('formatsWithItem (fail-closed subset of str.format)', () => {
  test.each([
    ['{item}', true],
    ['{{x}}', true],
    ['{item!r}', true],
    ['{item!a}', true],
    ['{item!s}', true],
    ['{item!x}', false],
    ['{item:>20}', true],
    ['{item:10.3}', true],
    ['{item:+}', false],
    ['{item:s}', true],
    ['{}', false],
    ['{x}', false],
    ['a}', false],
    ['{item', false],
    ['{item:010}', true],
    ['{item:=5}', false],
    ['{item:5d}', false],
    ['plain', true],
  ])('%j -> %s', (t, ok) => {
    expect(formatsWithItem(t)).toBe(ok);
  });
});

describe('apply', () => {
  const committed = (): Record<string, unknown> => ({
    clone: '/old',
    repair: { enabled: false, spend_authorization: null, cq_bin: '/old' },
    alerts: { alert_agent_host: 'old' },
    other: 1,
  });
  test('sets leaves in place and keeps order', () => {
    const out = apply(J(committed()), overlay());
    expect(out.get('clone')).toBe('/srv/review/clone');
    expect(out.entries.map(([k]) => k)).toEqual([
      'clone',
      'repair',
      'alerts',
      'other',
      'worktree_root',
      'timeout_bin',
      'paseo_hosts',
    ]);
    expect((out.get('repair') as JsonObject).get('cq_bin')).toBe('/usr/bin/cq');
    expect(out.get('other')).toEqual(J(1));
  });
  test('refuses a missing parent block', () => {
    const c = committed();
    delete c.repair;
    expect(() => apply(J(c), overlay())).toThrow(
      'overlay parent missing from committed config: repair',
    );
    const n = overlay({}, { ...cfg(), notify: { hosts: ['h:1'] } });
    expect(() => apply(J(committed()), n)).toThrow(
      'overlay parent missing from committed config: notify',
    );
  });
  test('pre-rename target reads alert leaves from promotion', () => {
    const c = { ...committed(), promotion: { alert_agent_host: 'old' } } as Record<string, unknown>;
    delete c.alerts;
    const out = apply(J(c), overlay());
    expect((out.get('promotion') as JsonObject).get('alert_agent_host')).toBe('a:1');
    expect(out.has('alerts')).toBe(false);
  });
  test('renamed target ignores promotion leaves except alert recipient; current alerts win', () => {
    const o = overlay(
      {},
      {
        ...cfg(),
        alerts: { alert_agent_host: 'new' },
        promotion: { alert_agent_host: 'legacy', record_url_template: 'http://x/{item}' },
      },
    );
    const out = apply(J(committed()), o);
    expect((out.get('alerts') as JsonObject).get('alert_agent_host')).toBe('new');
    expect(out.has('promotion')).toBe(false);
    const only = overlay(
      {},
      { ...cfg(), alerts: undefined, promotion: { alert_agent_host: 'legacy' } },
    );
    expect((apply(J(committed()), only).get('alerts') as JsonObject).get('alert_agent_host')).toBe(
      'legacy',
    );
  });
  test('refuses enabling repair without committed spend authorization', () => {
    const o = overlay({}, { ...cfg(), repair: { enabled: true, cq_bin: '/x', paseo_host: 'a:1' } });
    expect(() => apply(J(committed()), o)).toThrow('without committed spend authorization');
    const c = committed();
    (c.repair as Record<string, unknown>).spend_authorization = { id: 1 };
    expect(() => apply(J(c), o)).not.toThrow();
    (c.repair as Record<string, unknown>).spend_authorization = 0;
    expect(() => apply(J(c), o)).toThrow('without committed spend authorization');
    (c.repair as Record<string, unknown>).spend_authorization = {};
    expect(() => apply(J(c), o)).toThrow('without committed spend authorization');
  });
  test('Python escape shapes', () => {
    expect(() => apply(J([1]), overlay())).toThrow(PythonError);
    const c = committed();
    delete c.repair;
    const o = overlay({}, { ...cfg(), repair: undefined });
    expect(() => apply(J(c), o)).toThrow();
  });
});

describe('changedFields / driftCheck / encode / digest / render', () => {
  test('changedFields names fields only', () => {
    expect(
      changedFields(J({ a: 1, b: { c: 2, d: 3 }, e: 1 }), J({ a: 1, b: { c: 9, d: 3 }, f: 1 })),
    ).toEqual(['b.c', 'e', 'f']);
    expect(changedFields(J(1), J(2))).toEqual(['<serialization>']);
    // Python: True == 1, so no drift.
    expect(changedFields(J({ a: 1 }), J({ a: true }))).toEqual([]);
    expect(changedFields(J({ a: 1 }), J({ a: 1.5 }))).toEqual(['a']);
    expect(changedFields(J({ a: [1] }), J({ a: [1] }))).toEqual([]);
    expect(changedFields(J({ b: 1, a: 1 }), J({ a: 2, b: 2 }))).toEqual(['a', 'b']);
  });
  test('encode is indent-2 ASCII insertion-order with newline', () => {
    expect(Buffer.from(encode(J({ b: 'é', a: [1, 2], c: {} }))).toString()).toBe(
      '{\n  "b": "\\u00e9",\n  "a": [\n    1,\n    2\n  ],\n  "c": {}\n}\n',
    );
  });
  test('digest is sha256 hex', () => {
    expect(digest(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  test('driftCheck passes on equal bytes and names fields otherwise', async () => {
    const a = encode(J({ x: 1, y: { z: 1 } }));
    await expect(driftCheck(a, async () => a)).resolves.toBeUndefined();
    const b = encode(J({ x: 1, y: { z: 2 } }));
    await expect(driftCheck(a, async () => b)).rejects.toThrow(
      'config drift; refusing switch: y.z',
    );
    await expect(driftCheck(a, async () => Buffer.from('{ "x":1,"y":{"z":1}}'))).rejects.toThrow(
      '<serialization>',
    );
    // json.loads(bytes) accepts a UTF-8 BOM, so this is serialisation drift, not invalid JSON.
    await expect(
      driftCheck(a, async () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), a])),
    ).rejects.toThrow('<serialization>');
    await expect(driftCheck(a, async () => Buffer.from('nope'))).rejects.toThrow('<invalid JSON>');
    await expect(driftCheck(a, async () => Buffer.from([0xff]))).rejects.toThrow('<invalid JSON>');
    await expect(driftCheck(Buffer.from('nope'), async () => a)).rejects.toThrow('<invalid JSON>');
  });
  test('render applies overlay to the committed text at the sha', async () => {
    const seen: string[] = [];
    const out = await render(
      {
        gitShow: async (sha, path) => {
          seen.push(`${sha}:${path}`);
          return JSON.stringify({
            repair: { enabled: false, spend_authorization: null },
            alerts: {},
            clone: '/old',
          });
        },
      },
      overlay(),
    );
    expect(seen).toEqual(['HEAD:apps/crq-python/config.json']);
    expect(Buffer.from(out).toString()).toContain('"clone": "/srv/review/clone"');
    await render(
      { gitShow: async (s) => (seen.push(s), '{"repair":{"enabled":false},"alerts":{}}') },
      overlay(),
      'abc',
    );
    expect(seen[1]).toBe('abc');
  });
});
