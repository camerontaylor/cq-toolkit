// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus this shared fixtures module. Every moved block is unchanged; this
// header is the original file header, kept with the family.
//
// The RS-13 certification probe (B14).  The invariants that make the
// certification unforgeable are tested with fakes on every host:
//   - a launcher that blocks EVERYTHING fails its workspace control and is
//     never certified (broken is not confined);
//   - a launcher that grants EVERYTHING fails every denial canary — including
//     the sibling, symlink, nested-child, and external legs — and is never
//     certified (granted is not a boundary);
//   - an inconclusive canary (its control could not fire) refuses
//     certification — doubt fails closed;
//   - a backend that cannot compose a proxy is UNCERTIFIABLE for a
//     proxy-composed posture and fails closed;
//   - `launchCertified` refuses a certification object the probe did not
//     produce (forged), a backend the probe did not certify, a mismatched
//     posture, and a proxy-port/promise mismatch.
// The real seatbelt certification runs only where seatbelt runs; everywhere
// else the same probe records the platform blocker instead.  LIVE STATUS: the
// narrow-allow profile has not yet executed on any host — live evidence at
// final head is a gate of the fresh protocol sequence, not this suite.
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

import type { SandboxBackendAdapter, SandboxLaunchResult } from '../../src/sandbox/launcher.js';
import type { BackendProbeRecord } from '../../experimental/sandbox-host/probe.js';

// Deterministic host seams: the probe's "external" egress target is a
// loopback listener the bare host can always reach, and the local-prefix
// target is a stub executable — so certification verdicts never depend on
// outbound DNS or on what /usr/local happens to contain.
let seamServer: Server;
let seamDir: string;
let seamOptions: {
  externalTarget: { host: string; port: number };
  localPrefixTarget: string;
};
export const seams = () => seamOptions;
beforeAll(async () => {
  seamServer = createServer((socket) => socket.destroy());
  const port = await new Promise<number>((resolve) => {
    seamServer.listen(0, '127.0.0.1', () => {
      const address = seamServer.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  seamDir = await mkdtemp(join(tmpdir(), 'cq-probe-seams-'));
  const stub = join(seamDir, 'local-stub');
  await writeFile(stub, '#!/bin/sh\nexit 0\n');
  await chmod(stub, 0o755);
  seamOptions = {
    externalTarget: { host: '127.0.0.1', port },
    localPrefixTarget: stub,
  };
});
afterAll(async () => {
  await new Promise<void>((done) => seamServer.close(() => done()));
  await rm(seamDir, { recursive: true, force: true });
});

export const result = (over: Partial<SandboxLaunchResult>): SandboxLaunchResult => ({
  ok: false,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

// Shaped as a launcher exec refusal naming its target: the probe's
// exec-refusal attribution (rightly) accepts only launcher-machinery
// evidence, so the fake's denials must look like a real boundary's.
export const denied = (argv0 = '/usr/bin/false') =>
  result({
    exitCode: 1,
    stderr: `fake boundary: execvp() of '${argv0}' failed: Operation not permitted`,
  });

/**
 * A fake whose verdicts follow one of six behaviors, keyed by what the
 * canaries ask the child to do:
 *   grant-all    — every child succeeds (a boundary that does not bound);
 *   block-all    — no child ever runs (a broken launcher, not confinement);
 *   env-fails    — children run except the env probe (an inconclusive canary);
 *   fs-only      — filesystem denials hold (bash file operations included)
 *                  but connect attempts pass (an `allow`-posture boundary,
 *                  wrong for model-only);
 *   proxy-fs-only— fs denials hold and ONLY the declared proxy port passes —
 *                  the proxy-composed model-only boundary;
 *   broken-bash  — fs denials hold but bash cannot exec in-boundary, so
 *                  every bash -c canary must go INCONCLUSIVE, not "denied".
 */
export function fakeAdapter(
  behavior: 'grant-all' | 'block-all' | 'env-fails' | 'fs-only' | 'proxy-fs-only' | 'broken-bash',
): SandboxBackendAdapter {
  return {
    backend: 'bwrap',
    workspaceParent: () => '/tmp',
    ...(behavior === 'proxy-fs-only' ? { supportsProxyModelOnly: true as const } : {}),
    available: async () => ({ available: true }),
    launch: async (request) => {
      if (behavior === 'block-all') {
        return Promise.resolve(result({ spawnError: 'fake launcher refuses everything' }));
      }
      if (behavior === 'broken-bash' && request.argv[0] === '/bin/bash') {
        return Promise.resolve(result({ spawnError: 'fake bash cannot exec inside the boundary' }));
      }
      const argText = request.argv.join(' ');
      const portMatch = argText.match(/dev\/tcp\/([^/]+)\/(\d+)/);
      if (request.argv[0] === '/bin/bash') {
        if (behavior === 'grant-all') return Promise.resolve(result({ ok: true, exitCode: 0 }));
        // A plain in-boundary exec (the probe's shell control) works for every
        // behavior that executes children at all.  Kept in sync with the
        // probe's control argv (/bin/bash --norc -c /usr/bin/true).
        const plainExec = argText.includes('/usr/bin/true');
        // fs-only: filesystem denials hold — a bash -c FILE operation is
        // denied like any other read; only connect attempts (and the plain
        // shell control) pass, which is what makes the posture `allow`-shaped.
        // proxy-fs-only: only the declared proxy loopback port passes —
        // non-proxy ports and external hosts are denied even when a proxyPort
        // was granted.
        const bashAllowed =
          plainExec ||
          (portMatch !== null &&
            (behavior === 'fs-only' ||
              (behavior === 'proxy-fs-only' &&
                portMatch[1] === '127.0.0.1' &&
                Number(portMatch[2]) === request.proxyPort)));
        return bashAllowed
          ? Promise.resolve(result({ ok: true, exitCode: 0 }))
          : Promise.resolve(denied(String(request.argv[0])));
      }
      if (request.argv[0] === '/usr/bin/printenv') {
        if (behavior === 'env-fails') return Promise.resolve(result({ exitCode: 7 }));
        if (behavior === 'grant-all') {
          return Promise.resolve(
            result({
              ok: true,
              exitCode: 0,
              stdout: request.parentEnv?.[request.argv[1] ?? ''] ?? '',
            }),
          );
        }
        return Promise.resolve(result({ exitCode: 1 }));
      }
      if (behavior === 'grant-all') return Promise.resolve(result({ ok: true, exitCode: 0 }));
      // A plain exec with no file target (the probe's launch probe itself)
      // succeeds: exec is permitted in-boundary; only file OPERATIONS are
      // contained.
      if (request.argv[0] === '/usr/bin/true') {
        return Promise.resolve(result({ ok: true, exitCode: 0 }));
      }
      // A real fs-only boundary evaluates the file the operation RESOLVES to:
      // a workspace path that symlinks outside is denied like any outside
      // read (Sol review's symlink-escape leg).  Model that with realpath
      // containment; an unresolvable target (touch-style creates) rides on
      // the lexical path.
      const target = request.argv[1] ?? '';
      const within = (path: string, root: string): boolean =>
        path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
      // Containment is evaluated on RESOLVED paths: normalize `..`/`.` first,
      // then resolve what exists.  A create-style target under an escaping
      // directory symlink resolves through its PARENT (round-3 review); a
      // target whose parent is also unresolvable is treated as outside.
      const { resolve: resolvePath, dirname, join, basename } = await import('node:path');
      const rootResolved = resolvePath(request.workspace);
      let inside = within(resolvePath(target), rootResolved);
      if (inside) {
        try {
          inside = within(await realpath(target), await realpath(rootResolved));
        } catch {
          try {
            const parent = await realpath(dirname(target));
            inside = within(join(parent, basename(target)), await realpath(rootResolved));
          } catch {
            inside = false;
          }
        }
      }
      return inside
        ? Promise.resolve(result({ ok: true, exitCode: 0 }))
        : Promise.resolve(denied(String(request.argv[0])));
    },
  };
}

export const verdictOf = (record: BackendProbeRecord | undefined, id: string) =>
  record?.canaries.find((canary) => canary.id === id)?.verdict;

export const ALL_IDS = [
  'read-escape',
  'read-escape-sibling',
  'symlink-escape',
  'nested-child-escape',
  'write-escape',
  'local-prefix-exec',
  'credential-env',
  'credential-file',
] as const;
