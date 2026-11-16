import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  OSError,
  Refused,
  loadModule,
  materializeOps,
  resolveModules,
  type ResolveModulesEffects,
  type VerifyTargetTag,
} from '../../../../src/ops/crq/deploy/resolveModules.js';

const sha = 't'.repeat(40);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (s: string): string => createHash('sha256').update(s).digest('hex');

type Mod = { name: string };
function fixture(over: Partial<ResolveModulesEffects<Mod, Mod>> = {}) {
  const log: string[] = [];
  const effects: ResolveModulesEffects<Mod, Mod> = {
    mkdirPrivateAll: (d) => void log.push(`mkdir:${d}`),
    gitShowBytes: async (s, rel) => {
      log.push(`show:${s}:${rel}`);
      return enc(`bytes of ${rel}`);
    },
    writeExclusive: (p, d) => void log.push(`write:${p}:${new TextDecoder().decode(d)}`),
    loadModule: async (name, path) => {
      log.push(`load:${name}:${path}`);
      return { name };
    },
    verifyTargetTag: () => 'defaulted',
    ...over,
  };
  return { effects, log };
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

describe('materializeOps', () => {
  test('creates the private dir, then shows and writes each module in order', async () => {
    const f = fixture();
    const digests = await materializeOps(f.effects, sha, ['a.py', 'b.py'], '/run/ops');
    expect(f.log).toEqual([
      'mkdir:/run/ops',
      `show:${sha}:apps/crq-python/ops/a.py`,
      'write:/run/ops/a.py:bytes of apps/crq-python/ops/a.py',
      `show:${sha}:apps/crq-python/ops/b.py`,
      'write:/run/ops/b.py:bytes of apps/crq-python/ops/b.py',
    ]);
    expect(digests).toEqual({
      'a.py': hex('bytes of apps/crq-python/ops/a.py'),
      'b.py': hex('bytes of apps/crq-python/ops/b.py'),
    });
    expect(Object.keys(digests)).toEqual(['a.py', 'b.py']);
  });
  test('the digest is of the extracted bytes, not the name', async () => {
    const f = fixture({ gitShowBytes: async () => enc('x') });
    expect(await materializeOps(f.effects, sha, ['a.py'], '/d')).toEqual({ 'a.py': hex('x') });
  });
  test('a trailing slash on the destination does not double the separator', async () => {
    const f = fixture();
    await materializeOps(f.effects, sha, ['a.py'], '/d/');
    expect(f.log).toContain('write:/d/a.py:bytes of apps/crq-python/ops/a.py');
  });
  test('a failing git show stops before writing that module and keeps earlier writes', async () => {
    let n = 0;
    const f = fixture({
      gitShowBytes: async () => {
        if (++n === 2) throw new Refused('git show failed: bad object');
        return enc('ok');
      },
    });
    expect(await refusal(materializeOps(f.effects, sha, ['a.py', 'b.py'], '/d'))).toBe(
      'git show failed: bad object',
    );
    expect(f.log.filter((l) => l.startsWith('write'))).toEqual(['write:/d/a.py:ok']);
  });
  test('an existing file (exclusive create) is a plain error, not a refusal', async () => {
    const f = fixture({
      writeExclusive: () => {
        throw new Error('EEXIST');
      },
    });
    const e = await materializeOps(f.effects, sha, ['a.py'], '/d').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(Refused);
  });
});

describe('loadModule', () => {
  test('returns the loaded module', async () => {
    expect(await loadModule(fixture().effects, 'n', '/p')).toEqual({ name: 'n' });
  });
  test('no loader is Refused', async () => {
    const f = fixture({ loadModule: async () => null });
    expect(await refusal(loadModule(f.effects, 'n', '/p'))).toBe('cannot load n from /p');
  });
  test('an OSError is Refused with the cause; other errors pass through', async () => {
    const f = fixture({
      loadModule: async () => {
        throw new OSError('EACCES');
      },
    });
    expect(await refusal(loadModule(f.effects, 'n', '/p'))).toBe('unreadable module n: EACCES');
    const g = fixture({
      loadModule: async () => {
        throw new SyntaxError('bad');
      },
    });
    await expect(loadModule(g.effects, 'n', '/p')).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('resolveModules', () => {
  test('extracts both modules, then loads helper then controller from the private dir', async () => {
    const f = fixture();
    const r = await resolveModules(f.effects, sha, '/run/candidate-ops', {
      helper: null,
      controller: null,
    });
    expect(f.log.filter((l) => l.startsWith('show'))).toEqual([
      `show:${sha}:apps/crq-python/ops/prepare-host.py`,
      `show:${sha}:apps/crq-python/ops/deploy-controller.py`,
    ]);
    expect(f.log.filter((l) => l.startsWith('load'))).toEqual([
      'load:crq_deploy_runbook_helper:/run/candidate-ops/prepare-host.py',
      'load:crq_deploy_runbook_controller:/run/candidate-ops/deploy-controller.py',
    ]);
    expect(f.log.findIndex((l) => l.startsWith('load'))).toBeGreaterThan(
      f.log.findLastIndex((l) => l.startsWith('write')),
    );
    expect(Object.keys(r.digests)).toEqual(['prepare-host.py', 'deploy-controller.py']);
    expect(r.helper).toEqual({ name: 'crq_deploy_runbook_helper' });
    expect(r.controller).toEqual({ name: 'crq_deploy_runbook_controller' });
  });
  test('an injected helper or controller is kept and not loaded, but still materialised', async () => {
    const helper = { name: 'injected-h' };
    const controller = { name: 'injected-c' };
    const f = fixture();
    const r = await resolveModules(f.effects, sha, '/d', { helper, controller });
    expect(r.helper).toBe(helper);
    expect(r.controller).toBe(controller);
    expect(f.log.some((l) => l.startsWith('load'))).toBe(false);
    expect(f.log.filter((l) => l.startsWith('write'))).toHaveLength(2);
  });
  test('only the missing one is loaded', async () => {
    const f = fixture();
    const r = await resolveModules(f.effects, sha, '/d', {
      helper: { name: 'h' },
      controller: null,
    });
    expect(f.log.filter((l) => l.startsWith('load'))).toEqual([
      'load:crq_deploy_runbook_controller:/d/deploy-controller.py',
    ]);
    expect(r.helper).toEqual({ name: 'h' });
    const g = fixture();
    await resolveModules(g.effects, sha, '/d', { helper: null, controller: { name: 'c' } });
    expect(g.log.filter((l) => l.startsWith('load'))).toEqual([
      'load:crq_deploy_runbook_helper:/d/prepare-host.py',
    ]);
  });
  test.each<[VerifyTargetTag, boolean]>([
    ['absent', true],
    ['defaulted', true],
    ['required', false],
  ])('verify_target tag %s → accepted=%s', async (tag, accepted) => {
    const f = fixture({ verifyTargetTag: () => tag });
    const run = resolveModules(f.effects, sha, '/d', { helper: null, controller: null });
    if (accepted) await run;
    else
      expect(await refusal(run)).toBe(
        "the target revision's prepare-host.verify_target still requires an annotated tag, so a tagless deploy and its automatic rollback are impossible with it; deploy a target that contains the tagless-helper change first. Nothing has been switched.",
      );
  });
  test('the tag check inspects the helper that will actually be used', async () => {
    const seen: Mod[] = [];
    const f = fixture({
      verifyTargetTag: (h) => {
        seen.push(h);
        return 'defaulted';
      },
    });
    const injected = { name: 'inj' };
    await resolveModules(f.effects, sha, '/d', { helper: injected, controller: null });
    expect(seen).toEqual([injected]);
  });
  test('a failure in extraction prevents any load', async () => {
    const f = fixture({
      gitShowBytes: async () => {
        throw new Refused('git show failed');
      },
    });
    await refusal(resolveModules(f.effects, sha, '/d', { helper: null, controller: null }));
    expect(f.log.some((l) => l.startsWith('load'))).toBe(false);
  });
  test('a failing helper load stops before the controller load and the tag check', async () => {
    let checked = false;
    const f = fixture({
      loadModule: async () => {
        throw new OSError('ENOENT');
      },
      verifyTargetTag: () => {
        checked = true;
        return 'defaulted';
      },
    });
    expect(
      await refusal(resolveModules(f.effects, sha, '/d', { helper: null, controller: null })),
    ).toBe('unreadable module crq_deploy_runbook_helper: ENOENT');
    expect(checked).toBe(false);
  });
});
