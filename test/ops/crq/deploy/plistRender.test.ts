import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../../src/policy/crq/jsonValue.js';
import { dumpPlist, parsePlist } from '../../../../src/ops/crq/deploy/plist.js';
import { liveRender, renderPlists } from '../../../../src/ops/crq/deploy/plistRender.js';
import { CalledProcessError } from '../../../../src/ops/crq/deploy/deployOps.js';

type Golden = Record<string, { in: string; out: string }>;
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/plist-golden.json', import.meta.url), 'utf8'),
) as Golden;
const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

function fx(inputs: Record<string, string>) {
  const writes: [string, string][] = [];
  const log: string[] = [];
  return {
    writes,
    log,
    effects: {
      mkdir: async () => void log.push('mkdir'),
      listPlists: async () => Object.keys(inputs),
      readFile: async (n: string) => Buffer.from(inputs[n] as string),
      atomicWrite: async (n: string, d: Uint8Array) => void writes.push([n, text(d)]),
      overlayPath: () => '/o/ov.json',
      home: () => '/h',
    },
  };
}

describe('renderPlists differential against plistlib goldens', () => {
  test('real launchd plists and a synthetic one match byte for byte', async () => {
    const f = fx({
      'com.crq.watchdog.plist': golden.watchdog!.in,
      'com.crq.fleet-reader.plist': golden.reader!.in,
      'com.crq.syn.plist': golden.syn!.in,
    });
    await renderPlists(f.effects, '/d');
    const by = Object.fromEntries(f.writes);
    expect(by['com.crq.watchdog.plist']).toBe(golden.watchdog!.out);
    expect(by['com.crq.fleet-reader.plist']).toBe(golden.reader!.out);
    expect(by['com.crq.syn.plist']).toBe(golden.syn!.out);
    expect(f.log).toEqual(['mkdir']);
  });
  test('placeholders replace in values only, never in dict keys', async () => {
    const f = fx({ 'com.crq.syn.plist': golden.syn!.in });
    await renderPlists(f.effects, '/d');
    expect(f.writes[0]?.[1]).toContain('<key>@CRQ_ROOT@</key>');
    expect(f.writes[0]?.[1]).toContain('<string>/d/apps/crq-python</string>');
  });
  test('a root with redundant slashes renders as Path would', async () => {
    const f = fx({ 'com.crq.syn.plist': golden.syn!.in });
    await renderPlists(f.effects, '/d//x/./');
    expect(f.writes[0]?.[1]).toContain('<string>/d/x/apps/crq-python</string>');
  });
  test('writes in sorted name order and refuses unsupported plist content', async () => {
    const f = fx({ 'com.crq.b.plist': golden.syn!.in, 'com.crq.a.plist': golden.syn!.in });
    await renderPlists(f.effects, '/d');
    expect(f.writes.map(([n]) => n)).toEqual(['com.crq.a.plist', 'com.crq.b.plist']);
    const bad = fx({ 'com.crq.r.plist': '<plist version="1.0"><real>1.5</real></plist>' });
    await expect(renderPlists(bad.effects, '/d')).rejects.toThrow('unsupported or malformed plist');
    expect(bad.writes).toEqual([]);
  });
});

describe('plist codec', () => {
  test('parse/dump round trip and malformed input', () => {
    const v = parsePlist(golden.watchdog!.in);
    expect(dumpPlist(parsePlist(dumpPlist(v)))).toBe(dumpPlist(v));
    for (const bad of [
      '',
      '<plist><dict></plist>',
      '<plist><string>a</string><string>b</string></plist>',
      '<plist><integer>x</integer></plist>',
      '<plist><dict><string>a</string></dict></plist>',
      '<plist><string>&#0;</string></plist>',
      '<plist><string><![CDATA[x]]></string></plist>',
    ])
      expect(() => parsePlist(bad)).toThrow();
    for (const bad of [
      '<integer> </integer>',
      '<integer>0b11</integer>',
      '<integer>0o7</integer>',
      '<integer>1_0</integer>',
    ])
      expect(() => parsePlist(`<plist>${bad}</plist>`)).toThrow('unsupported or malformed plist');
    // Python sorts keys by code point, JS default sort by UTF-16 unit: U+FFEE < U+1F600.
    const order = dumpPlist(
      new Map([
        ['\u{1F600}', 1n],
        ['\uffee', 2n],
      ]),
    );
    expect(order.indexOf('\uffee')).toBeLessThan(order.indexOf('\u{1F600}'));
    expect(() => dumpPlist('a\u0001')).toThrow('control characters');
    expect(() => dumpPlist(1n << 70n)).toThrow('out of range');
  });
});

describe('liveRender', () => {
  const overlay = parseJsonValue(
    JSON.stringify({ deploy_root: '/d', config: { clone: '/c' } }),
  ) as JsonObject;
  function lr(over: { recordFails?: boolean; head?: string } = {}) {
    const log: string[] = [];
    const config = JSON.stringify({ alerts: {}, repair: { enabled: false } });
    const effects = {
      git: async (args: readonly string[]) => {
        const k = args.join(' ');
        log.push(`git ${k}`);
        if (k === 'rev-parse --show-toplevel') return Buffer.from('/d\n');
        if (k === 'rev-parse --abbrev-ref HEAD') return Buffer.from(over.head ?? 'HEAD\n');
        if (k.startsWith('show HEAD:')) return Buffer.from(config);
        throw new CalledProcessError(1, '');
      },
      resolve: (p: string) => p,
      unitFiles: async () => [],
      systemctl: async () => ({ code: 0, stdout: '', stderr: '' }),
      withTickLock: async <R>(fn: () => Promise<R>): Promise<R> => {
        log.push('lock+');
        try {
          return await fn();
        } finally {
          log.push('lock-');
        }
      },
      readConfig: async () => Buffer.from(''),
      writeConfig: async (d: Uint8Array) => void log.push(`write ${text(d).length > 0}`),
      record: async (_c: Uint8Array, op: string) => {
        log.push(`record ${op}`);
        if (over.recordFails) throw new Error('record failed');
      },
    };
    return { effects, log };
  }
  test('checks root, then under the lock records before writing', async () => {
    const { effects, log } = lr();
    await liveRender(effects, '/d', overlay);
    expect(log.filter((l) => /^(lock|record|write)/.test(l))).toEqual([
      'lock+',
      'record live-config',
      'write true',
      'lock-',
    ]);
  });
  test('a failed record leaves the config unwritten and releases the lock', async () => {
    const { effects, log } = lr({ recordFails: true });
    await expect(liveRender(effects, '/d', overlay)).rejects.toThrow('record failed');
    expect(log.some((l) => l.startsWith('write'))).toBe(false);
    expect(log.at(-1)).toBe('lock-');
  });
  test('a non-detached checkout is refused before the lock', async () => {
    const { effects, log } = lr({ head: 'main\n' });
    await expect(liveRender(effects, '/d', overlay)).rejects.toThrow('must be detached');
    expect(log).not.toContain('lock+');
  });
});
