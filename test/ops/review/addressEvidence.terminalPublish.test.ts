import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const authority = vi.hoisted(() => ({ calls: 0, failOn: 0 }));
vi.mock('../../../src/ops/review/internal/addressRunLifecycle.js', () => ({
  validateAddressTerminalAuthority: async () => {
    authority.calls += 1;
    if (authority.calls === authority.failOn) throw new Error('authority lost mid-publication');
    return { commonDir: '', terminal: authority.calls > 1 };
  },
  trackAddressTerminalProcess: () => undefined,
}));

const { noteAddressOrdinaryReport, persistAddressTerminalReport } =
  await import('../../../src/ops/review/internal/addressEvidence.js');

afterEach(() => {
  authority.calls = 0;
  authority.failOn = 0;
});

async function setup(): Promise<{
  base: string;
  path: string;
  token: object;
  dir: { dev: number; ino: number };
}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-publish-')));
  const path = join(base, 'report.json');
  await writeFile(path, '{"ordinary":true}\n');
  const token = {};
  // noteAddressOrdinaryReport validates authority once, in its own phase.
  authority.calls = 0;
  await noteAddressOrdinaryReport(token, path, '{"ordinary":true}\n').catch(() => undefined);
  const stat = await lstat(base);
  return { base, path, token, dir: { dev: stat.dev, ino: stat.ino } };
}

test('a failed publication leaves the ordinary report byte-identical and no staged file behind', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1; // the following calls run in the terminal phase
    // Calls 2 and 3 precede staging; call 4 runs after the staged bytes are written.
    authority.failOn = 4;
    await expect(
      persistAddressTerminalReport(token, path, { terminal: true }, dir),
    ).rejects.toThrow(/authority lost mid-publication/);
    expect(await readFile(path, 'utf8')).toBe('{"ordinary":true}\n');
    expect(await readdir(base)).toEqual(['report.json']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a successful publication swaps the full terminal report in and removes the staged file', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1;
    await persistAddressTerminalReport(token, path, { terminal: true }, dir);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ terminal: true });
    expect(await readdir(base)).toEqual(['report.json']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a new report is created exclusively and never overwrites a racing file', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-publish-')));
  try {
    const stat = await lstat(base);
    const path = join(base, 'new.json');
    await mkdir(join(base, 'x'));
    await writeFile(path, 'racer');
    authority.calls = 1;
    await expect(
      persistAddressTerminalReport({}, path, { terminal: true }, { dev: stat.dev, ino: stat.ino }),
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('racer');
    expect((await readdir(base)).sort()).toEqual(['new.json', 'x']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
