import { constants } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const authority = vi.hoisted(() => ({ calls: 0, failOn: 0 }));
// Seams over the fs calls that carry publication: each hook runs around the real call.
const fsHooks = vi.hoisted(() => ({
  openFlags: [] as { path: string; flags: unknown }[],
  unlinked: [] as string[],
  renamed: [] as { from: string; to: string }[],
  afterRename: undefined as undefined | ((to: string) => Promise<void>),
  unlinkError: undefined as undefined | Error,
  reset() {
    this.openFlags = [];
    this.unlinked = [];
    this.renamed = [];
    this.afterRename = undefined;
    this.unlinkError = undefined;
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (path: string, flags: unknown, mode: unknown) => {
      fsHooks.openFlags.push({ path: String(path), flags });
      return actual.open(path, flags as never, mode as never);
    }) as typeof actual.open,
    unlink: async (path: string) => {
      fsHooks.unlinked.push(String(path));
      if (fsHooks.unlinkError) throw fsHooks.unlinkError;
      return actual.unlink(path);
    },
    rename: async (from: string, to: string) => {
      fsHooks.renamed.push({ from: String(from), to: String(to) });
      await actual.rename(from, to);
      await fsHooks.afterRename?.(String(to));
    },
  };
});
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
  fsHooks.reset();
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

test('a new report is refused with EEXIST when a racing file already holds the path', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-publish-')));
  try {
    const stat = await lstat(base);
    const path = join(base, 'new.json');
    await writeFile(path, 'racer');
    authority.calls = 1;
    await expect(
      persistAddressTerminalReport({}, path, { terminal: true }, { dev: stat.dev, ino: stat.ino }),
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(path, 'utf8')).toBe('racer');
    expect(await readdir(base)).toEqual(['new.json']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the stage is opened exclusively and without following symlinks', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1;
    await persistAddressTerminalReport(token, path, { terminal: true }, dir);
    const stage = fsHooks.openFlags.find((o) => o.path.includes('.terminal-'));
    const flags = stage?.flags as number;
    expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(flags & constants.O_CREAT).toBe(constants.O_CREAT);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an ordinary report is replaced by renaming the stage over it, never by unlinking it first', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1;
    await persistAddressTerminalReport(token, path, { terminal: true }, dir);
    expect(fsHooks.renamed).toHaveLength(1);
    expect(fsHooks.renamed[0]?.to).toBe(path);
    expect(fsHooks.renamed[0]?.from).toMatch(/\.report\.json\.terminal-/);
    expect(fsHooks.unlinked).not.toContain(path);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a report swapped in right after publication is refused', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1;
    fsHooks.afterRename = async (to) => {
      await rm(to);
      await writeFile(to, 'impostor');
    };
    await expect(
      persistAddressTerminalReport(token, path, { terminal: true }, dir),
    ).rejects.toThrow(/terminal report replaced/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('when publication and staged cleanup both fail the publication error is the one rethrown', async () => {
  const { base, path, token, dir } = await setup();
  try {
    authority.calls = 1;
    authority.failOn = 4;
    fsHooks.unlinkError = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    await expect(
      persistAddressTerminalReport(token, path, { terminal: true }, dir),
    ).rejects.toThrow(/authority lost mid-publication/);
    expect(await readFile(path, 'utf8')).toBe('{"ordinary":true}\n');
  } finally {
    fsHooks.reset();
    await rm(base, { recursive: true, force: true });
  }
});
