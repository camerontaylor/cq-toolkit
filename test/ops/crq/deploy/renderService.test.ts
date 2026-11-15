import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  renderService,
  renderUnits,
  type RenderUnitsEffects,
} from '../../../../src/ops/crq/deploy/renderService.js';
import { ValueError } from '../../../../src/ops/crq/deploy/unitRender.js';

const COMMIT = 'c'.repeat(40);
const SHA = 'a'.repeat(40);
const DIR = 'apps/crq-python/ops/systemd/';
const gitBlob = (raw: Buffer): string =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]))
    .digest('hex');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Fx extends RenderUnitsEffects {
  calls: string[][];
  written: [string, string][];
  dirs: string[];
  artifacts: [string, string][];
  artifactIdentity(root: string, runtime: string): Promise<unknown>;
}
function fx(files: Record<string, Buffer>, opts: { badBlob?: boolean; commit?: string } = {}): Fx {
  const out = (s: string): Uint8Array => Buffer.from(s);
  const calls: string[][] = [];
  const written: [string, string][] = [];
  const dirs: string[] = [];
  const artifacts: [string, string][] = [];
  return {
    calls,
    written,
    dirs,
    artifacts,
    git: async (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}'))
        return out(`${opts.commit ?? COMMIT}\n`);
      if (args[0] === 'ls-tree')
        return out(
          Object.keys(files)
            .map((n) => DIR + n)
            .join('\n') + '\n',
        );
      if (args[0] === 'rev-parse') {
        const name = (args[1] as string).slice(COMMIT.length + 1 + DIR.length);
        return out(`${gitBlob(files[name] as Buffer)}\n`);
      }
      if (args[0] === 'cat-file') {
        const hit = Object.values(files).find((raw) => gitBlob(raw) === args[2]) as Buffer;
        return opts.badBlob ? Buffer.concat([hit, Buffer.from('x')]) : hit;
      }
      if (args[0] === 'show')
        return files[(args[1] as string).slice(COMMIT.length + 1 + DIR.length)] as Buffer;
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    mkdir: async (p) => {
      dirs.push(p);
    },
    atomicWrite: async (p, d) => {
      written.push([p, Buffer.from(d).toString()]);
    },
    artifactIdentity: async (root, runtime) => {
      artifacts.push([root, runtime]);
      return { root, runtime };
    },
  };
}
const TPL = Buffer.from('[Service]\nWorkingDirectory=@CRQ_ROOT@\nExecStart=/old\n');

describe('renderService', () => {
  test('renders a python unit bound to the pinned blob', async () => {
    const f = fx({ 'crq-tick.service': TPL });
    const r = await renderService(f, '/r', 'crq-tick.service', '/h');
    expect(Buffer.from(r.bytes).toString()).toBe(
      '[Service]\nWorkingDirectory=/r/apps/crq-python\nExecStart=/old\n',
    );
    expect(r).toMatchObject({
      sourceSha: COMMIT,
      templatePath: `${DIR}crq-tick.service`,
      templateBlobOid: gitBlob(TPL),
      templateSha256: sha256(TPL),
      execStart: '/old',
      sha256: sha256(r.bytes),
      artifact: null,
      runtime: 'python',
    });
    expect(f.artifacts).toEqual([]);
  });
  test('a node runtime rewrites ExecStart and asks for the artifact identity', async () => {
    const f = fx({ 'crq-tick.service': TPL });
    const r = await renderService(f, '/r', 'crq-tick.service', '/h', { runtime: `node:${SHA}` });
    expect(r.execStart).toBe(
      `/usr/bin/env node /h/.local/opt/crq-${SHA}/dist/queue-runner/crq.js tick`,
    );
    expect(f.artifacts).toEqual([[`/h/.local/opt/crq-${SHA}`, `node:${SHA}`]]);
    expect(r.artifact).toEqual({ root: `/h/.local/opt/crq-${SHA}`, runtime: `node:${SHA}` });
    const g = fx({ 'crq-tick.service': TPL });
    await renderService(g, '/r', 'crq-tick.service', '/', {
      runtime: `node:${SHA}`,
      artifactRoot: '/x//y/',
    });
    expect(g.artifacts[0]?.[0]).toBe('/x/y');
    const h = fx({ 'crq-tick.service': TPL });
    await renderService(h, '/r', 'crq-tick.service', '/', { runtime: `node:${SHA}` });
    expect(h.artifacts[0]?.[0]).toBe(`/.local/opt/crq-${SHA}`);
  });
  test('refuses unknown units, short commits and absent templates', async () => {
    await expect(renderService(fx({}), '/r', 'nope.service', '/h')).rejects.toThrow(
      'unknown runtime unit',
    );
    await expect(
      renderService(
        fx({ 'crq-tick.service': TPL }, { commit: 'abc' }),
        '/r',
        'crq-tick.service',
        '/h',
      ),
    ).rejects.toThrow('source commit must resolve to a full SHA');
    await expect(
      renderService(fx({ 'crq-slot.service': TPL }), '/r', 'crq-tick.service', '/h'),
    ).rejects.toThrow('unit template is absent from the pinned commit');
  });
  test('refuses bytes that do not hash to the blob', async () => {
    await expect(
      renderService(
        fx({ 'crq-tick.service': TPL }, { badBlob: true }),
        '/r',
        'crq-tick.service',
        '/h',
      ),
    ).rejects.toThrow('template bytes do not match the pinned Git blob');
  });
  test('refuses invalid UTF-8, missing placeholder and several ExecStart lines', async () => {
    const bad = Buffer.concat([Buffer.from('@CRQ_ROOT@\nExecStart=a\n'), Buffer.from([0xff])]);
    await expect(
      renderService(fx({ 'crq-tick.service': bad }), '/r', 'crq-tick.service', '/h'),
    ).rejects.toThrow('invalid UTF-8');
    await expect(
      renderService(
        fx({ 'crq-tick.service': Buffer.from('ExecStart=a\n') }),
        '/r',
        'crq-tick.service',
        '/h',
      ),
    ).rejects.toThrow('unit lacks monorepo root placeholder');
    await expect(
      renderService(
        fx({ 'crq-tick.service': Buffer.from('@CRQ_ROOT@\nExecStart=a\nExecStart=b\n') }),
        '/r',
        'crq-tick.service',
        '/h',
      ),
    ).rejects.toThrow('unit must have exactly one ExecStart: crq-tick.service');
    await expect(
      renderService(
        fx({ 'crq-tick.service': Buffer.from('@CRQ_ROOT@\n') }),
        '/r',
        'crq-tick.service',
        '/h',
      ),
    ).rejects.toThrow('unit must have exactly one ExecStart');
  });
  test('refuses an unsafe root', async () => {
    await expect(
      renderService(fx({ 'crq-tick.service': TPL }), '/r s', 'crq-tick.service', '/h'),
    ).rejects.toThrow(ValueError);
  });
});

describe('renderUnits', () => {
  const files = {
    'crq-tick.service': TPL,
    'crq-tick.timer': Buffer.from('[Timer]\n'),
    'other.service': Buffer.from('nope'),
  };
  test('writes every crq- template after validating all of them', async () => {
    const f = fx(files);
    const paths = await renderUnits(f, '/r', '/out', '/h');
    expect(paths).toEqual(['/out/crq-tick.service', '/out/crq-tick.timer']);
    expect(f.dirs).toEqual(['/out']);
    expect(f.written[0]?.[1]).toBe(
      '[Service]\nWorkingDirectory=/r/apps/crq-python\nExecStart=/old\n',
    );
    expect(f.written[1]?.[1]).toBe('[Timer]\n');
  });
  test('reads templates in text mode: CRLF becomes LF', async () => {
    const f = fx({ 'crq-tick.timer': Buffer.from('[Timer]\r\nA=b\rC\n') });
    await renderUnits(f, '/r', '/out', '/h');
    expect(f.written[0]?.[1]).toBe('[Timer]\nA=b\nC\n');
  });
  test('applies per-unit node runtimes', async () => {
    const f = fx(files);
    await renderUnits(f, '/r', '/out', '/h', {
      runtimes: new Map([['crq-tick.service', `node:${SHA}`]]),
    });
    expect(f.written[0]?.[1]).toContain(
      `ExecStart=/usr/bin/env node /h/.local/opt/crq-${SHA}/dist/queue-runner/crq.js tick\n`,
    );
  });
  test('refuses before any write when one template is invalid', async () => {
    const f = fx({ ...files, 'crq-bad.service': Buffer.from('x') });
    await expect(renderUnits(f, '/r', '/out', '/h')).rejects.toThrow(
      'unit lacks monorepo root placeholder',
    );
    expect(f.written).toEqual([]);
    expect(f.dirs).toEqual([]);
  });
  test('refuses an empty target and bad runtime maps', async () => {
    await expect(
      renderUnits(fx({ 'other.service': Buffer.from('x') }), '/r', '/out', '/h'),
    ).rejects.toThrow('target lacks CRQ unit templates');
    await expect(
      renderUnits(fx(files), '/r', '/out', '/h', {
        runtimes: new Map([['nope.service', 'python']]),
      }),
    ).rejects.toThrow('unknown runtime unit');
    await expect(
      renderUnits(fx(files), '/r', '/out', '/h', {
        runtimes: new Map([['crq-slot.service', 'python']]),
      }),
    ).rejects.toThrow('runtime unit absent from target');
    const f = fx(files);
    await expect(
      renderUnits(f, '/r', '/out', '/h', { runtimes: new Map([['crq-tick.service', 'bogus']]) }),
    ).rejects.toThrow('runtime must be python or node:<full SHA>');
    expect(f.written).toEqual([]);
  });
});
