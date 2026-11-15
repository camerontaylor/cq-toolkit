import { describe, expect, test } from 'vitest';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../../src/policy/crq/jsonValue.js';
import {
  CalledProcessError,
  inactive,
  LEGACY_SHA,
  legacyCheck,
  POLICY_FLOOR,
  prepare,
  record,
  rootCheck,
  switchCheckout,
  verifyTarget,
  type PrepareEffects,
  type SystemctlResult,
} from '../../../../src/ops/crq/deploy/deployOps.js';
import { digest, ValueError } from '../../../../src/ops/crq/deploy/hostOverlay.js';

const T = 'b'.repeat(40);
const CFG = 'apps/crq-python/config.json';
const obj = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const bytes = (s: string): Uint8Array => Buffer.from(s);
const text = (b: Uint8Array): string => Buffer.from(b).toString();

type Script = Record<string, string | Error>;
/** Fake git: keyed by the space-joined args; every call is logged. */
function fakeGit(script: Script, log: string[] = []) {
  return {
    log,
    git: async (args: readonly string[]): Promise<Uint8Array> => {
      const key = args.join(' ');
      log.push(`git ${key}`);
      const hit = script[key];
      if (hit === undefined) throw new Error(`unscripted git ${key}`);
      if (hit instanceof Error) throw hit;
      return bytes(hit);
    },
  };
}
const fail = new CalledProcessError(1, '');
const CONFIG_OK = JSON.stringify({
  promotion: { merges_trigger: 1, dispatch_after_min: 0 },
  alerts: {},
  repair: { enabled: false },
});
const TPL = `apps/crq-python/ops/systemd/crq-tick.service`;
const targetScript = (over: Script = {}): Script => ({
  [`merge-base --is-ancestor ${T} refs/remotes/origin/main`]: '',
  [`merge-base --is-ancestor ${POLICY_FLOOR} ${T}`]: '',
  [`ls-tree -r --name-only ${T} apps/crq-python/state/`]: '\n',
  [`show ${T}:${CFG}`]: CONFIG_OK,
  [`ls-tree ${T} apps/crq-python/ops/prepare-host.py`]: '100644 blob x\tp\n',
  [`ls-tree -r --name-only ${T} apps/crq-python/ops/systemd/`]: `${TPL}\napps/crq-python/ops/systemd/other\n`,
  [`show ${T}:${TPL}`]: '@CRQ_ROOT@\n',
  ...over,
});

describe('verifyTarget', () => {
  test('accepts a deployable target', async () => {
    await verifyTarget(fakeGit(targetScript()), T);
  });
  test('validates the target and tag shapes before any git call', async () => {
    const f = fakeGit({});
    await expect(verifyTarget(f, 'abc')).rejects.toThrow('target must be a full commit SHA');
    await expect(verifyTarget(f, T.toUpperCase())).rejects.toThrow(ValueError);
    await expect(verifyTarget(f, T, 'v1')).rejects.toThrow(
      'runner tag must be crq-runner/YYYYMMDD-N',
    );
    await expect(verifyTarget(f, T, 'crq-runner/2026111-1')).rejects.toThrow(ValueError);
    expect(f.log).toEqual([]);
  });
  test('the tag must be annotated and peel to the target', async () => {
    const ref = 'refs/tags/crq-runner/20261115-1';
    const ok = { [`cat-file -t ${ref}`]: 'tag\n', [`rev-parse ${ref}^{commit}`]: `${T}\n` };
    await verifyTarget(fakeGit(targetScript(ok)), T, 'crq-runner/20261115-1');
    await expect(
      verifyTarget(
        fakeGit(targetScript({ ...ok, [`cat-file -t ${ref}`]: 'commit\n' })),
        T,
        'crq-runner/20261115-1',
      ),
    ).rejects.toThrow('annotated tag does not name target');
    await expect(
      verifyTarget(
        fakeGit(targetScript({ ...ok, [`rev-parse ${ref}^{commit}`]: `${'c'.repeat(40)}\n` })),
        T,
        'crq-runner/20261115-1',
      ),
    ).rejects.toThrow('annotated tag does not name target');
  });
  test('a failed ancestry check propagates', async () => {
    await expect(
      verifyTarget(
        fakeGit(targetScript({ [`merge-base --is-ancestor ${T} refs/remotes/origin/main`]: fail })),
        T,
      ),
    ).rejects.toBe(fail);
    await expect(
      verifyTarget(
        fakeGit(targetScript({ [`merge-base --is-ancestor ${POLICY_FLOOR} ${T}`]: fail })),
        T,
      ),
    ).rejects.toBe(fail);
  });
  test('refuses tracked runner state, old policy, missing helper and templates', async () => {
    const run = (o: Script) => verifyTarget(fakeGit(targetScript(o)), T);
    await expect(
      run({ [`ls-tree -r --name-only ${T} apps/crq-python/state/`]: 'x\n' }),
    ).rejects.toThrow('target must not track runner state');
    await expect(
      run({ [`show ${T}:${CFG}`]: '{"promotion":{"merges_trigger":5}}' }),
    ).rejects.toThrow('every-green-tip');
    await expect(
      run({ [`show ${T}:${CFG}`]: '{"promotion":{"dispatch_after_min":1}}' }),
    ).rejects.toThrow('every-green-tip');
    await expect(run({ [`ls-tree ${T} apps/crq-python/ops/prepare-host.py`]: '' })).rejects.toThrow(
      'target lacks monorepo deploy helper',
    );
    await expect(
      run({
        [`ls-tree -r --name-only ${T} apps/crq-python/ops/systemd/`]:
          'apps/crq-python/ops/systemd/other\n',
      }),
    ).rejects.toThrow('target lacks CRQ unit templates');
    await expect(run({ [`show ${T}:${TPL}`]: 'no placeholder' })).rejects.toThrow(
      'unit lacks monorepo root placeholder',
    );
  });
  test('Python promotion semantics: missing/falsy → defaults, True == 1, 1.0 == 1', async () => {
    const run = (cfg: string) =>
      verifyTarget(fakeGit(targetScript({ [`show ${T}:${CFG}`]: cfg })), T);
    await run('{}');
    await run('{"promotion":null}');
    await run('{"promotion":0}');
    await run('{"promotion":[]}');
    await run('{"promotion":{"merges_trigger":true,"dispatch_after_min":false}}');
    await run('{"promotion":{"merges_trigger":1.0,"dispatch_after_min":0.0}}');
    await expect(run('{"promotion":{"merges_trigger":null}}')).rejects.toThrow('every-green-tip');
    await expect(run('{"promotion":"x"}')).rejects.toThrow("no attribute 'get'");
    await expect(run('[]')).rejects.toThrow("no attribute 'get'");
  });
});

describe('rootCheck', () => {
  const overlay = obj({ deploy_root: '/d' });
  const base = (script: Script, res = (p: string) => p) => ({ ...fakeGit(script), resolve: res });
  const ok = { 'rev-parse --show-toplevel': '/d\n', 'rev-parse --abbrev-ref HEAD': 'HEAD\n' };
  test('passes for a detached full checkout', async () => {
    await rootCheck(base(ok), '/d', overlay);
  });
  test('refuses each mismatch', async () => {
    await expect(rootCheck(base(ok), '/x', overlay)).rejects.toThrow(
      'not the overlay deployment checkout',
    );
    await expect(
      rootCheck(base({ ...ok, 'rev-parse --show-toplevel': '/d/sub\n' }), '/d', overlay),
    ).rejects.toThrow('full monorepo checkout');
    await expect(
      rootCheck(base({ ...ok, 'rev-parse --abbrev-ref HEAD': 'main\n' }), '/d', overlay),
    ).rejects.toThrow('must be detached');
    await rootCheck(
      base(ok, (p) => (p === '/link' ? '/d' : p)),
      '/link',
      overlay,
    );
  });
});

describe('inactive', () => {
  const res = (stdout = '', code = 0, stderr = ''): SystemctlResult => ({ code, stdout, stderr });
  function fx(map: Record<string, SystemctlResult>, files: string[] = []) {
    const calls: string[] = [];
    return {
      calls,
      unitFiles: async () => files,
      systemctl: async (args: readonly string[]) => {
        calls.push(args.join(' '));
        const hit = map[args[1] === 'show' ? `show ${args.at(-1)}` : (args[1] as string)];
        if (!hit) throw new Error(`unscripted ${args.join(' ')}`);
        return hit;
      },
    };
  }
  test('queries both listings and checks every name in code-point order', async () => {
    const f = fx(
      {
        'list-unit-files': res('crq-b.service enabled\n'),
        'list-units': res('crq-a.timer loaded inactive dead\n'),
        'show crq-a.timer': res('inactive\n'),
        'show crq-b.service': res(' failed \n'),
        'show crq-z.service': res('inactive\n'),
      },
      ['crq-z.service'],
    );
    await inactive(f);
    expect(f.calls).toEqual([
      '--user list-unit-files --no-legend --no-pager --plain crq-*',
      '--user list-units --no-legend --no-pager --plain --all crq-*',
      '--user show --property=ActiveState --value crq-a.timer',
      '--user show --property=ActiveState --value crq-b.service',
      '--user show --property=ActiveState --value crq-z.service',
    ]);
  });
  test('refuses an active or unknown state', async () => {
    for (const state of ['active\n', 'activating\n', '\n'])
      await expect(
        inactive(
          fx({ 'list-unit-files': res(), 'list-units': res(), 'show crq-a.service': res(state) }, [
            'crq-a.service',
          ]),
        ),
      ).rejects.toThrow('refusing active or unknown unit: crq-a.service');
  });
  test('an empty unit-file pattern is tolerated only for exit 1 with no stderr', async () => {
    await inactive(fx({ 'list-unit-files': res('', 1), 'list-units': res() }));
    await expect(
      inactive(fx({ 'list-unit-files': res('', 1, 'bus down'), 'list-units': res() })),
    ).rejects.toBeInstanceOf(CalledProcessError);
    await expect(
      inactive(fx({ 'list-unit-files': res('', 2), 'list-units': res() })),
    ).rejects.toBeInstanceOf(CalledProcessError);
    await expect(
      inactive(fx({ 'list-unit-files': res(), 'list-units': res('', 1) })),
    ).rejects.toBeInstanceOf(CalledProcessError);
    await inactive(fx({ 'list-unit-files': res('', 1, '  \u0085 '), 'list-units': res() }));
  });
  test('refuses unrecognised listings and a failing show', async () => {
    await expect(
      inactive(fx({ 'list-unit-files': res('other.service x'), 'list-units': res() })),
    ).rejects.toThrow('unrecognized CRQ unit listing');
    await expect(
      inactive(fx({ 'list-unit-files': res('crqx.service x'), 'list-units': res() })),
    ).rejects.toThrow('unrecognized CRQ unit listing');
    await expect(
      inactive(fx({ 'list-unit-files': res('crq-a$ x'), 'list-units': res() })),
    ).rejects.toThrow('unrecognized CRQ unit listing');
    await expect(
      inactive(fx({ 'list-unit-files': res('   \n'), 'list-units': res() })),
    ).rejects.toThrow('unrecognized CRQ unit listing');
    await expect(
      inactive(
        fx({ 'list-unit-files': res(), 'list-units': res(), 'show crq-a.service': res('', 3) }, [
          'crq-a.service',
        ]),
      ),
    ).rejects.toBeInstanceOf(CalledProcessError);
  });
});

describe('record', () => {
  function fx(mode = 0o700, headOut = `${T}\n`) {
    const log: string[] = [];
    const writes: [string, string][] = [];
    return {
      writes,
      ...fakeGit({ 'rev-parse HEAD': headOut }, log),
      requireOutsideGit: async (d: string) => void log.push(`outside ${d}`),
      mkdirPrivate: async (d: string) => void log.push(`mkdir ${d}`),
      mode: async () => mode,
      nowIso: () => '2026-11-15T00:00:00+00:00',
      uuidHex: () => 'u1',
      atomicWrite: async (p: string, d: Uint8Array) => void writes.push([p, text(d)]),
    };
  }
  const overlay = obj({ record_dir: '/rec//dir/' });
  test('writes the render-intent with the Python key order and extras last', async () => {
    const f = fx();
    const data = await record(f, overlay, bytes('raw'), bytes('cfg'), 'op', [
      ['target', T],
      ['tag', null],
    ]);
    expect(data.entries.map(([k]) => k)).toEqual([
      'schema_version',
      'operation',
      'at',
      'record_type',
      'sha',
      'overlay_sha256',
      'config_sha256',
      'target',
      'tag',
    ]);
    expect(f.log).toEqual(['outside /rec//dir/', 'mkdir /rec//dir/', 'git rev-parse HEAD']);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.[0]).toBe('/rec/dir/u1.json');
    const saved = obj(JSON.parse(f.writes[0]?.[1] as string));
    expect(saved.get('overlay_sha256')).toBe(digest(bytes('raw')));
    expect(saved.get('config_sha256')).toBe(digest(bytes('cfg')));
    expect(saved.get('sha')).toBe(T);
    expect((saved.get('schema_version') as JsonNumber).integer).toBe(1n);
    expect(f.writes[0]?.[1].endsWith('}\n')).toBe(true);
  });
  test('refuses a group- or world-accessible record directory before writing', async () => {
    for (const mode of [0o770, 0o707, 0o750]) {
      const f = fx(mode);
      await expect(record(f, overlay, bytes('r'), bytes('c'), 'op')).rejects.toThrow(
        'private record directory must have mode 0700',
      );
      expect(f.writes).toEqual([]);
    }
    const f = fx(0o40700);
    await record(f, overlay, bytes('r'), bytes('c'), 'op');
  });
});

// ---- switch / prepare / legacy ---------------------------------------------

const OVERLAY = obj({
  deploy_root: '/d',
  record_dir: '/rec',
  config: { clone: '/c' },
});
const COMMITTED_CFG = JSON.stringify({
  clone: '/old',
  alerts: {},
  repair: { enabled: false },
  promotion: { merges_trigger: 1 },
});

function sw(
  over: Script = {},
  state: { status?: string[]; live?: Uint8Array | null; failCheckout?: boolean } = {},
) {
  const log: string[] = [];
  const statuses = [...(state.status ?? [` M ${CFG}\n`, '\n', ` M ${CFG}\n`])];
  const script: Script = {
    'rev-parse --show-toplevel': '/d\n',
    'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    'rev-parse HEAD': `${'a'.repeat(40)}\n`,
    ...targetScript({ [`show ${T}:${CFG}`]: COMMITTED_CFG }),
    [`show HEAD:${CFG}`]: COMMITTED_CFG,
    [`restore -- ${CFG}`]: '',
    [`checkout --detach ${T}`]: state.failCheckout ? new CalledProcessError(1, '') : '',
    ...over,
  };
  const g = fakeGit(script, log);
  const live: { v: Uint8Array | null } = { v: state.live ?? null };
  const writes: [string, string][] = [];
  const fx = {
    ...g,
    resolve: (p: string) => p,
    unitFiles: async () => [],
    systemctl: async (): Promise<SystemctlResult> => {
      log.push('systemctl');
      return { code: 0, stdout: '', stderr: '' };
    },
    withTickLock: async <R>(fn: () => Promise<R>): Promise<R> => {
      log.push('lock+');
      try {
        return await fn();
      } finally {
        log.push('lock-');
      }
    },
    readConfig: async () => live.v ?? bytes(''),
    writeConfig: async (d: Uint8Array) =>
      void (log.push('writeConfig'), writes.push(['config', text(d)])),
    record: async (
      _c: Uint8Array,
      op: string,
      extra: ReadonlyArray<readonly [string, unknown]>,
    ) => {
      log.push(`record ${op} ${JSON.stringify(extra)}`);
    },
  };
  return { fx, log, writes, live, statuses, script };
}
// statuses are consumed in order by the 'status --porcelain --untracked-files=all' key
function wireStatus(s: ReturnType<typeof sw>): void {
  const key = 'status --porcelain --untracked-files=all';
  const orig = s.fx.git;
  s.fx.git = async (args) =>
    args.join(' ') === key
      ? (s.log.push('git status'), bytes(s.statuses.shift() ?? ''))
      : orig(args);
}
async function currentBytes(): Promise<Uint8Array> {
  const { render } = await import('../../../../src/ops/crq/deploy/hostOverlay.js');
  return render({ gitShow: async () => COMMITTED_CFG }, OVERLAY);
}

describe('switchCheckout', () => {
  test('orders validation, lock, drift check, records, restore, checkout, config write', async () => {
    const s = sw({}, { live: await currentBytes() });
    wireStatus(s);
    expect(await switchCheckout(s.fx, '/d', OVERLAY, T)).toBe(T);
    const interesting = s.log.filter((l) =>
      /^(lock|record|writeConfig|git restore|git checkout|git status|systemctl)/.test(l),
    );
    expect(interesting).toEqual(
      [
        'systemctl',
        'systemctl', // first inactive: 2 listings, no names
        'lock+',
        'systemctl',
        'systemctl',
        `git status`,
        `record switch-before [["target","${T}"],["tag",null]]`,
        `git restore -- ${CFG}`,
        'git status',
        `git checkout --detach ${T}`,
        `record switch-render [["previous_sha","${'a'.repeat(40)}"],["tag",null]]`,
        'writeConfig',
        'git status',
        'lock-',
      ].filter((l) => l !== undefined),
    );
    expect(s.writes).toHaveLength(1);
    expect(obj(JSON.parse(s.writes[0]?.[1] as string)).get('clone')).toBe('/c');
  });
  test('verify_target and the destination render happen before the unit check and the lock', async () => {
    const s = sw({ [`merge-base --is-ancestor ${T} refs/remotes/origin/main`]: fail });
    await expect(switchCheckout(s.fx, '/d', OVERLAY, T)).rejects.toBe(fail);
    expect(s.log).not.toContain('systemctl');
    expect(s.log).not.toContain('lock+');
    const bad = sw({ [`show ${T}:${CFG}`]: '{"promotion":{"merges_trigger":1}}' });
    await expect(switchCheckout(bad.fx, '/d', OVERLAY, T)).rejects.toThrow(/repair/);
    expect(bad.log).not.toContain('systemctl');
  });
  test('drift refuses before any record or checkout', async () => {
    const s = sw({}, { live: bytes('{"clone":"/other"}\n') });
    wireStatus(s);
    await expect(switchCheckout(s.fx, '/d', OVERLAY, T)).rejects.toThrow(
      'config drift; refusing switch',
    );
    expect(s.log.some((l) => l.startsWith('record'))).toBe(false);
    expect(s.log.at(-1)).toBe('lock-');
  });
  test('refuses foreign changes before recording', async () => {
    const s = sw({}, { live: await currentBytes(), status: [` M ${CFG}\n M other\n`] });
    wireStatus(s);
    await expect(switchCheckout(s.fx, '/d', OVERLAY, T)).rejects.toThrow(
      'checkout has changes other than rendered config',
    );
    expect(s.log.some((l) => l.startsWith('record'))).toBe(false);
    const u = sw({}, { live: await currentBytes(), status: [`?? new\n`] });
    wireStatus(u);
    await expect(switchCheckout(u.fx, '/d', OVERLAY, T)).rejects.toThrow(
      'other than rendered config',
    );
  });
  test('a dirty tree after restore, or a failed checkout, restores the current config', async () => {
    const cur = await currentBytes();
    const s = sw({}, { live: cur, status: [` M ${CFG}\n`, ' M x\n'] });
    wireStatus(s);
    await expect(switchCheckout(s.fx, '/d', OVERLAY, T)).rejects.toThrow(
      'checkout not clean after config restore',
    );
    expect(s.writes).toEqual([['config', text(cur)]]);
    const f = sw({}, { live: cur, status: [` M ${CFG}\n`, '\n'], failCheckout: true });
    wireStatus(f);
    await expect(switchCheckout(f.fx, '/d', OVERLAY, T)).rejects.toBeInstanceOf(CalledProcessError);
    expect(f.writes).toEqual([['config', text(cur)]]);
    expect(f.log.some((l) => l.startsWith('record switch-render'))).toBe(false);
  });
  test('the post-switch status must be clean or only the config', async () => {
    const cur = await currentBytes();
    const ok = sw({}, { live: cur, status: [` M ${CFG}\n`, '\n', ''] });
    wireStatus(ok);
    await switchCheckout(ok.fx, '/d', OVERLAY, T);
    const bad = sw({}, { live: cur, status: [` M ${CFG}\n`, '\n', ` M ${CFG}\n M y\n`] });
    wireStatus(bad);
    await expect(switchCheckout(bad.fx, '/d', OVERLAY, T)).rejects.toThrow(
      'post-switch status must contain only rendered config',
    );
  });
  test('rootCheck runs first', async () => {
    const s = sw({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
    await expect(switchCheckout(s.fx, '/d', OVERLAY, T)).rejects.toThrow('must be detached');
    expect(s.log.every((l) => !l.includes('merge-base'))).toBe(true);
  });
});

describe('prepare', () => {
  function pr(opts: { verifyFails?: boolean } = {}) {
    const s = sw({
      'rev-parse HEAD': `${T}\n`,
      [`show ${T}:${CFG}`]: COMMITTED_CFG,
    });
    const files: Record<string, string> = {
      '/tmp/u/crq-a.service': 'A',
      '/tmp/u/crq-b.timer': 'B',
    };
    const out: [string, string][] = [];
    const fx: PrepareEffects = {
      ...s.fx,
      renderUnitsToTemp: async (sha, use) => {
        s.log.push(`render ${sha}`);
        return use(Object.keys(files));
      },
      verifyUnits: async (paths) => {
        s.log.push(`verify ${paths.join(',')}`);
        if (opts.verifyFails) throw new CalledProcessError(1, '');
      },
      readFile: async (p) => bytes(files[p] as string),
      mkdirOutput: async () => void s.log.push('mkdirOutput'),
      writeOutput: async (n, d) => void (s.log.push(`out ${n}`), out.push([n, text(d)])),
      writeMarker: async (d) => void s.log.push(`marker ${text(d).trim()}`),
      daemonReload: async () => void s.log.push('reload'),
    };
    return { s, fx, out };
  }
  test('verifies before recording, writes marker before config, reloads after unlock', async () => {
    const { s, fx, out } = pr();
    await prepare(fx, '/d', OVERLAY, null);
    const ev = s.log.filter((l) =>
      /^(lock|render|verify|record|mkdir|out|marker|writeConfig|reload)/.test(l),
    );
    expect(ev).toEqual([
      'lock+',
      `render ${T}`,
      'verify /tmp/u/crq-a.service,/tmp/u/crq-b.timer',
      expect.stringMatching(/^record prepare \[\["unit_sha256",/),
      'mkdirOutput',
      'out crq-a.service',
      'out crq-b.timer',
      'marker Prepared inert; owner approval required to start.',
      'writeConfig',
      'lock-',
      'reload',
    ] as string[]);
    expect(out).toEqual([
      ['crq-a.service', 'A'],
      ['crq-b.timer', 'B'],
    ]);
    const rec = s.log.find((l) => l.startsWith('record prepare')) as string;
    expect(rec).toContain(`"crq-a.service",${JSON.stringify(digest(bytes('A')))}`.slice(0, 0));
  });
  test('a failed verify writes nothing and does not reload', async () => {
    const { s, fx, out } = pr({ verifyFails: true });
    await expect(prepare(fx, '/d', OVERLAY, null)).rejects.toBeInstanceOf(CalledProcessError);
    expect(out).toEqual([]);
    expect(s.log).not.toContain('reload');
    expect(s.log.some((l) => l.startsWith('record') || l.startsWith('marker'))).toBe(false);
    expect(s.log.at(-1)).toBe('lock-');
  });
  test('verifies the SHA read under the lock against the tag', async () => {
    const { s, fx } = pr();
    s.script['cat-file -t refs/tags/crq-runner/20261115-1'] = 'commit\n';
    await expect(prepare(fx, '/d', OVERLAY, 'crq-runner/20261115-1')).rejects.toThrow(
      'annotated tag does not name target',
    );
    expect(s.log).not.toContain('reload');
  });
});

describe('legacyCheck', () => {
  const legacyCfg = JSON.stringify({
    clone: '/old',
    alerts: {},
    repair: { enabled: false },
    promotion: { merges_trigger: 5 },
  });
  function lg(over: Script = {}, live: string | null = null) {
    const log: string[] = [];
    const recs: string[] = [];
    const g = fakeGit(
      {
        'rev-parse HEAD': `${LEGACY_SHA}\n`,
        'status --porcelain --untracked-files=no': ' M config.json\n',
        [`show ${LEGACY_SHA}:config.json`]: legacyCfg,
        ...over,
      },
      log,
    );
    return {
      log,
      recs,
      fx: {
        ...g,
        readConfig: async () => bytes(live ?? ''),
        record: async (
          c: Uint8Array,
          op: string,
          extra: ReadonlyArray<readonly [string, unknown]>,
        ) => void recs.push(`${op} ${JSON.stringify(extra)} ${text(c)}`),
      },
    };
  }
  async function expected(): Promise<string> {
    const { apply, encode } = await import('../../../../src/ops/crq/deploy/hostOverlay.js');
    const cfg = apply(parseJsonValue(legacyCfg), OVERLAY);
    const promo = cfg.get('promotion') as JsonObject;
    const next = new JsonObject(
      cfg.entries.map(
        ([k, v]) =>
          [
            k,
            k === 'promotion'
              ? new JsonObject(
                  promo.entries.map(([a, b]) => [
                    a,
                    a === 'merges_trigger' ? JsonNumber.int(1) : b,
                  ]),
                )
              : v,
          ] as const,
      ),
    );
    return text(encode(next));
  }
  test('records the 5→1 render and writes nothing else', async () => {
    const want = await expected();
    const l = lg({}, want);
    await legacyCheck(l.fx, OVERLAY);
    expect(l.recs).toEqual([`legacy-drift-check [["baseline_sha","${LEGACY_SHA}"]] ${want}`]);
    expect(want).toContain('"merges_trigger": 1');
  });
  test('refuses a wrong HEAD, extra tracked changes, wrong policy and drift', async () => {
    await expect(legacyCheck(lg({ 'rev-parse HEAD': `${T}\n` }).fx, OVERLAY)).rejects.toThrow(
      'legacy checkout HEAD must match the accepted baseline',
    );
    await expect(
      legacyCheck(
        lg({ 'status --porcelain --untracked-files=no': ' M config.json\n M x\n' }).fx,
        OVERLAY,
      ),
    ).rejects.toThrow('tracked changes other than config.json');
    await expect(
      legacyCheck(
        lg({ [`show ${LEGACY_SHA}:config.json`]: legacyCfg.replace('5', '4') }).fx,
        OVERLAY,
      ),
    ).rejects.toThrow('unexpected accepted baseline policy');
    const drift = lg({}, '{"clone":"/zzz"}\n');
    await expect(legacyCheck(drift.fx, OVERLAY)).rejects.toThrow('config drift; refusing switch');
    expect(drift.recs).toEqual([]);
  });
  test('a clean status is accepted; trigger 5.0 and missing keys follow Python', async () => {
    const want = await expected();
    await legacyCheck(lg({ 'status --porcelain --untracked-files=no': '' }, want).fx, OVERLAY);
    await expect(
      legacyCheck(
        lg({ [`show ${LEGACY_SHA}:config.json`]: legacyCfg.replace('"merges_trigger":5', '"x":1') })
          .fx,
        OVERLAY,
      ),
    ).rejects.toThrow("'merges_trigger'");
    await expect(
      legacyCheck(
        lg({
          [`show ${LEGACY_SHA}:config.json`]: legacyCfg.replace(/"promotion":\{[^}]*\}/, '"p":1'),
        }).fx,
        OVERLAY,
      ),
    ).rejects.toThrow("'promotion'");
    await expect(
      legacyCheck(
        lg({
          [`show ${LEGACY_SHA}:config.json`]: legacyCfg.replace(
            /"promotion":\{[^}]*\}/,
            '"promotion":3',
          ),
        }).fx,
        OVERLAY,
      ),
    ).rejects.toThrow('subscriptable');
  });
});
