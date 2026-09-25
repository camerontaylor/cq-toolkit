// scripts/ratchet-propose.mjs (W1.7): the privileged proposer consumes a
// numbers-only measurement ARTIFACT as untrusted data and targets
// merge-queue. Spawn-driven like the other driver suites: the token gate,
// argument validation, and artifact refusals run against the real script
// with a recording fake `git`/`gh` first on PATH (a refused artifact must
// invoke neither); the happy path runs a COPY of the script in a throwaway
// repo whose origin is a local bare repo with a merge-queue branch.
// POSIX-only (shell shims, symlinks); CI is linux.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'ratchet-propose.mjs');
const COVERAGE_BASELINE = 'baselines/coverage--coverage--a8ceec8f7024.json';

let tmp = '';
let fakeBin = '';
let callLog = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ratchet-propose-test-'));
  fakeBin = join(tmp, 'fakebin');
  callLog = join(tmp, 'calls.log');
  mkdirSync(fakeBin);
  for (const name of ['git', 'gh']) {
    const shim = join(fakeBin, name);
    writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> "${callLog}"\nexit 1\n`, 'utf8');
    chmodSync(shim, 0o755);
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['CQ_AUTOMATION_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) delete env[key];
  return env;
}

function runRecorded(args: string[], withToken = true) {
  rmSync(callLog, { force: true });
  const env = baseEnv();
  if (withToken) env.CQ_AUTOMATION_TOKEN = 'test-token-not-real';
  env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env,
  });
  const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
  return { ...res, calls };
}

function writeArtifact(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('ratchet-propose: gate and arguments', () => {
  it('a tokenless run is a green no-op, even without --measurement', () => {
    const res = runRecorded([], false);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('CQ_AUTOMATION_TOKEN not set; skipping proposal');
    expect(res.calls).toBe('');
  });

  it.each([
    [[] as string[]],
    [['--measurement=']],
    [['--measurement=/x', '--measurement=/y']],
    [['--bogus']],
    [['/x']],
  ])('token set with arguments %j → exit 1 before any git/gh', (args) => {
    const res = runRecorded(args);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('usage: ratchet-propose.mjs --measurement=<path>');
    expect(res.calls).toBe('');
  });
});

describe('ratchet-propose: the measurement artifact is untrusted data', () => {
  const ok = (metrics: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, metrics });

  it.each([
    ['not JSON', 'not-json{', 'not valid JSON'],
    [
      'an extra top-level key',
      JSON.stringify({ schemaVersion: 1, metrics: {}, x: 1 }),
      'exactly the keys',
    ],
    ['a wrong schemaVersion', JSON.stringify({ schemaVersion: 2, metrics: {} }), 'schemaVersion'],
    ['an array', '[]', 'JSON object'],
    ['metrics not an object', JSON.stringify({ schemaVersion: 1, metrics: [] }), 'metrics must be'],
    ['an unknown metric', ok({ complexity: 3 }), 'unknown metric "complexity"'],
    ['a __proto__ metric key', '{"schemaVersion":1,"metrics":{"__proto__":1}}', 'unknown metric'],
    ['coverage 101', ok({ coverage: 101 }), "'coverage' has an invalid value 101"],
    ['coverage -1', ok({ coverage: -1 }), "'coverage' has an invalid value"],
    ['coverage as a string', ok({ coverage: '95' }), "'coverage' has an invalid value"],
    [
      'typecheck-count 1.5',
      ok({ 'typecheck-count': 1.5 }),
      "'typecheck-count' has an invalid value 1.5",
    ],
    ['typecheck-count -1', ok({ 'typecheck-count': -1 }), "'typecheck-count' has an invalid value"],
    ['typecheck-count beyond safe', ok({ 'typecheck-count': 2 ** 53 }), 'invalid value'],
  ])('refuses %s', (name, content, message) => {
    const path = writeArtifact(`bad-${name.replace(/\W+/g, '-')}.json`, content);
    const res = runRecorded([`--measurement=${path}`]);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('invalid measurement');
    expect(res.stderr).toContain(message);
    expect(res.calls).toBe('');
  });

  it('refuses an artifact over 64 KiB', () => {
    const path = writeArtifact('big.json', `${ok({ coverage: 50 })}${' '.repeat(64 * 1024)}`);
    const res = runRecorded([`--measurement=${path}`]);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('byte cap');
    expect(res.calls).toBe('');
  });

  it('refuses a symlinked artifact (never followed)', () => {
    const target = writeArtifact('real.json', ok({ coverage: 50 }));
    const link = join(tmp, 'link.json');
    symlinkSync(target, link);
    const res = runRecorded([`--measurement=${link}`]);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('is not a regular file');
    expect(res.calls).toBe('');
  });

  it('refuses a missing artifact and a directory', () => {
    const missing = runRecorded([`--measurement=${join(tmp, 'absent.json')}`]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('cannot read the measurement');
    const dir = runRecorded([`--measurement=${tmp}`]);
    expect(dir.status).toBe(1);
    expect(dir.stderr).toContain('is not a regular file');
    expect(missing.calls + dir.calls).toBe('');
  });

  it('parseProposeMeasurement accepts the strict shape and omits absent metrics', async () => {
    const lib = (await import(pathToFileURL(join(ROOT, 'scripts', 'ratchet-lib.mjs')).href)) as {
      parseProposeMeasurement: (text: string, size: number) => Record<string, number>;
    };
    const both = ok({ coverage: 93.46, 'typecheck-count': 0 });
    expect({ ...lib.parseProposeMeasurement(both, both.length) }).toEqual({
      coverage: 93.46,
      'typecheck-count': 0,
    });
    expect({ ...lib.parseProposeMeasurement(ok({}), 30) }).toEqual({});
    expect(() => lib.parseProposeMeasurement(both, 64 * 1024 + 1)).toThrow(/byte cap/);
  });
});

describe('ratchet-propose: happy path against a local merge-queue origin', () => {
  const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

  function git(cwd: string, args: string[]): string {
    const res = spawnSync('git', [...ID, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...baseEnv(), ...GIT_ENV },
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  }

  function baseline(value: number): string {
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        target: 'coverage',
        metric: 'coverage',
        direction: 'higher-is-better',
        value,
        unit: 'pct',
        capturedAt: '2026-09-20T17:48:12.636Z',
      },
      null,
      2,
    )}\n`;
  }

  function setup(label: string) {
    const dir = join(tmp, label);
    const origin = join(dir, 'origin.git');
    const repo = join(dir, 'repo');
    const bin = join(dir, 'bin');
    const ghLog = join(dir, 'gh.log');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'baselines'), { recursive: true });
    mkdirSync(bin);
    git(dir, ['init', '--bare', '-b', 'main', origin]);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['remote', 'add', 'origin', origin]);
    copyFileSync(SCRIPT, join(repo, 'scripts', 'ratchet-propose.mjs'));
    copyFileSync(
      join(ROOT, 'scripts', 'ratchet-lib.mjs'),
      join(repo, 'scripts', 'ratchet-lib.mjs'),
    );
    symlinkSync(join(ROOT, 'dist'), join(repo, 'dist'));
    writeFileSync(join(repo, '.gitignore'), 'dist\n');
    // main (the trust ref) carries a STRICTER baseline than merge-queue: a
    // proposal can only happen if the comparison reads the merge-queue tip.
    writeFileSync(join(repo, COVERAGE_BASELINE), baseline(99));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'main']);
    git(repo, ['push', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'merge-queue']);
    writeFileSync(join(repo, COVERAGE_BASELINE), baseline(90));
    writeFileSync(join(repo, 'baselines', 'ratchets.json'), '{"not":"a baseline"}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'merge-queue']);
    git(repo, ['push', 'origin', 'merge-queue']);
    const mqTip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    git(repo, ['branch', '-D', 'merge-queue']);
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "${ghLog}"`,
        'case "$1 $2" in',
        '  "repo view") echo "owner/repo" ;;',
        '  "pr list") echo "[]" ;;',
        '  "pr create") echo "https://github.com/owner/repo/pull/7" ;;',
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);
    return { origin, repo, bin, ghLog, mqTip };
  }

  function propose(ctx: ReturnType<typeof setup>, metrics: Record<string, number>) {
    const artifact = join(ctx.repo, '..', 'measurement.json');
    writeFileSync(artifact, JSON.stringify({ schemaVersion: 1, metrics }));
    return spawnSync(
      process.execPath,
      [join(ctx.repo, 'scripts', 'ratchet-propose.mjs'), `--measurement=${artifact}`],
      {
        cwd: ctx.repo,
        encoding: 'utf8',
        timeout: 150_000,
        killSignal: 'SIGKILL',
        env: {
          ...baseEnv(),
          ...GIT_ENV,
          CQ_AUTOMATION_TOKEN: 'test-token-not-real',
          PATH: `${ctx.bin}:${process.env.PATH ?? ''}`,
        },
      },
    );
  }

  it(
    'proposes against merge-queue, cut from and compared with the merge-queue tip',
    { timeout: 240_000 },
    () => {
      const ctx = setup('happy');
      const res = propose(ctx, { coverage: 95.04 });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe('https://github.com/owner/repo/pull/7');
      expect(res.stderr).toContain("no 'typecheck-count' reading");
      expect(res.stderr).not.toContain('test-token-not-real');

      const gh = readFileSync(ctx.ghLog, 'utf8');
      expect(gh).toMatch(/^pr create --base merge-queue --head ratchet\/propose-/m);
      expect(gh).toMatch(/^pr list --head \S+ --base merge-queue /m);

      const heads = git(ctx.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
      const head = heads.split('\n').find((h) => h.startsWith('ratchet/propose-'));
      expect(head, heads).toBeDefined();
      expect(git(ctx.origin, ['rev-parse', `${head}^`])).toBe(ctx.mqTip);
      const proposed = JSON.parse(git(ctx.origin, ['show', `${head}:${COVERAGE_BASELINE}`])) as {
        value: number;
      };
      expect(proposed.value).toBe(95);
      // The temp worktree is gone and ROOT never left main.
      expect(git(ctx.repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
      expect(git(ctx.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    },
  );

  it(
    'a reading that does not tighten the merge-queue baseline proposes nothing',
    { timeout: 240_000 },
    () => {
      const ctx = setup('none');
      const res = propose(ctx, { coverage: 89.96 }); // rounds to 90.0 — equal, not tighter
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stderr).toContain('no tightening to propose');
      expect(existsSync(ctx.ghLog)).toBe(false);
    },
  );
});
