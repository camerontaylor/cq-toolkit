import { delimiter, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  carriesPathSeparator,
  defaultAcpEndpointTable,
  resolveAcpCommand,
} from '../../src/driver/acp/binaries.js';
import type { ExecutableProbe } from '../../src/driver/acp/binaries.js';

describe('acp binary resolution (the §3 which-like fold)', () => {
  // Platform delimiter (issue #41): a fixed colon makes this ONE entry on
  // Windows (';' would split '/cq-tools:/usr/bin' nowhere) — derive it, so
  // the walk is two-dir on every platform.
  const env = { PATH: ['/cq-tools', '/usr/bin'].join(delimiter) };

  test("the documented './bin/acp-server' form is path-carrying: resolved against the caller cwd, NEVER joined to PATH dirs", async () => {
    const seen: string[] = [];
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return true; // every candidate "exists" — the SHAPE of the resolution is what binds
    };
    const resolved = await resolveAcpCommand(
      ['./bin/acp-server', '--flag'],
      'explicit',
      defaultAcpEndpointTable(),
      env,
      probe,
    );
    // Exactly ONE probe — the caller-cwd-resolved candidate. A driver that
    // misses the path-carrying branch would walk the PATH instead
    // (/cq-tools/./bin/acp-server, /usr/bin/./bin/acp-server, ...).
    expect(seen).toEqual([resolve('./bin/acp-server')]);
    expect(resolved.binary).toBe(resolve('./bin/acp-server'));
    expect(resolved.command).toEqual([resolve('./bin/acp-server'), '--flag']);
    expect(resolved.source).toBe('explicit');
  });

  test('a bare name walks the PATH (the which contract) — past a miss, onto the hit; the two shapes stay distinct', async () => {
    const seen: string[] = [];
    // Only the SECOND PATH dir carries the binary: the walk must skip the
    // first entry (a miss) and land on the second.
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return candidate === join('/usr/bin', 'acp-server');
    };
    const resolved = await resolveAcpCommand(
      ['acp-server'],
      'explicit',
      defaultAcpEndpointTable(),
      env,
      probe,
    );
    // The extensionless candidates must appear IN PATH ORDER — past the
    // miss, onto the hit — and the hit must win. Asserted as an ordered
    // SUBSEQUENCE of `seen`, not the whole array: on win32 the walk also
    // probes the PATHEXT extensions per dir (issue #40; this env carries
    // no PATHEXT, so DEFAULT_PATHEXT fires), so the full candidate list is
    // platform-shaped while the which-contract shape — PATH order, first
    // hit wins, extensionless resolution — is what binds here.
    const miss = seen.indexOf(join('/cq-tools', 'acp-server'));
    const hit = seen.indexOf(join('/usr/bin', 'acp-server'));
    expect(miss).toBeGreaterThanOrEqual(0);
    expect(hit).toBeGreaterThan(miss);
    expect(resolved.binary).toBe(join('/usr/bin', 'acp-server'));
  });

  test('carriesPathSeparator: the forward-slash form is path-carrying on EVERY platform (the Windows fix — sep is a backslash there, but Node accepts / too)', () => {
    expect(carriesPathSeparator('./bin/acp-server')).toBe(true);
    expect(carriesPathSeparator('bin/acp-server')).toBe(true);
    expect(carriesPathSeparator('/abs/acp-server')).toBe(true);
    expect(carriesPathSeparator('acp-server')).toBe(false);
    expect(carriesPathSeparator('')).toBe(false);
    // Platform note (Codex P2): on win32 the backslash forms are caught by
    // the same check via `sep`; this suite runs on ubuntu/macOS where sep
    // IS '/', so that half is inert here — correctness for the documented
    // Windows case, not locally observable behavior.
  });

  test('a RELATIVE PATH ENTRY resolves to absolute before probing (#46) — the result survives the later cwd switch to the workspace', async () => {
    const seen: string[] = [];
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return candidate === join(resolve('./tools'), 'acp-server');
    };
    const resolved = await resolveAcpCommand(
      ['acp-server'],
      'explicit',
      defaultAcpEndpointTable(),
      { PATH: './tools' },
      probe,
    );
    // The probe saw the ABSOLUTE candidate (caller-cwd-resolved), never
    // the raw './tools/acp-server' the old walk probed — a relative
    // resolution result would break the moment the spawn switched cwd to
    // the workspace.
    expect(seen).toEqual([join(resolve('./tools'), 'acp-server')]);
    expect(resolved.binary).toBe(join(resolve('./tools'), 'acp-server'));
  });

  // The kernel lane's pathCandidates (merge-queue, right of way) keys the
  // PATHEXT walk on the HOST platform — the win32 candidate order stays
  // suite-unobservable on POSIX exactly as issue #40 anticipated; the
  // walk's two-dir structure above pins the platform-neutral half.
});
