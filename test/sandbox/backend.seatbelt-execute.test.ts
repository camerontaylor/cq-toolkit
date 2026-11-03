// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts (this file), backend.availability.test.ts
// and backend.launcher-hardening.test.ts, with shared helpers in
// backend.helpers.ts.
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { seatbeltAdapter } from '../../experimental/sandbox-host/backend.js';

describe.runIf(process.platform === 'darwin')('seatbelt executes inside the boundary', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test('a child reads and writes the workspace; no policy file lands in it', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/sh', '-c', 'echo in-boundary > proof.txt && cat proof.txt'],
      network: 'model-only',
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.stdout).toContain('in-boundary');
    // The policy is compiled from parent-PRIVATE storage (Sol review: the
    // workspace is model-writable, so a policy there is attacker-replaceable);
    // nothing policy-shaped is ever created in the workspace.
    const listing = await readdir(workspace);
    expect(listing).not.toContain('.cq-seatbelt.sb');
    expect(listing.filter((name) => name.endsWith('.sb'))).toEqual([]);
  }, 30_000);

  test('shell lookup ignores a host PATH preferring a denied executable', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-path-out-'));
    scratch.push(workspace, outside);
    const shadow = join(outside, 'cat');
    await writeFile(shadow, '#!/bin/sh\necho shadow-tool\n', { mode: 0o755 });
    const request = {
      workspace,
      network: 'model-only' as const,
      parentEnv: { ...process.env, PATH: `${outside}:/usr/bin:/bin` },
      envPassthrough: ['PATH'],
    };
    const lookup = await adapter.launch({
      ...request,
      argv: ['/bin/sh', '-c', 'echo system-tool > proof.txt && cat proof.txt'],
    });
    expect(lookup.ok, JSON.stringify(lookup)).toBe(true);
    expect(lookup.stdout.trim()).toBe('system-tool');
    const explicit = await adapter.launch({ ...request, argv: [shadow] });
    expect(explicit.ok).toBe(false);
    expect(explicit.stderr).toMatch(/Operation not permitted|Permission denied/);
    expect(explicit.stdout).not.toContain('shadow-tool');
  }, 30_000);

  test('the launcher env scrub reaches the confined child, and TMPDIR moves inside', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/usr/bin/printenv', 'TMPDIR'],
      parentEnv: { ...process.env, CQ_PROBE_TEST_SECRET: 'leak-me-not' },
      envPassthrough: [],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(join(workspace, '.tmp'));
    expect(result.stdout).not.toContain('leak-me-not');
  }, 30_000);

  test('the confined child cannot read a real file outside the workspace', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', outsidePath],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('outside-secret-value');
  }, 30_000);

  test('a SIBLING directory beside the workspace is unreadable too', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const sibling = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-sib-'));
    scratch.push(sibling);
    const siblingPath = join(sibling, 'secret.txt');
    await writeFile(siblingPath, 'sibling-secret-value');
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', siblingPath],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('sibling-secret-value');
  }, 30_000);

  test('a proxyPort launch compiles the single-port egress rule', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      proxyPort: 45454,
    });
    // The launch succeeding proves sandbox-exec compiled the proxy rule
    // (profile source is private per-launch storage, destroyed afterwards —
    // the rule content itself is construction-tested in seatbeltProfile).
    expect(result.ok).toBe(true);
    const listing = await readdir(workspace);
    expect(listing.filter((name) => name.endsWith('.sb'))).toEqual([]);
  }, 30_000);

  test('a pre-planted workspace policy cannot replace the boundary (attack path)', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    // The attacker plants a permissive profile at the OLD policy path — both
    // as a plain file overwrite target and as the classic symlink swap.
    const evilProfile = join(workspace, 'evil.sb');
    const evilText = '(version 1)\n(allow default)\n';
    await writeFile(evilProfile, evilText);
    await symlink(evilProfile, join(workspace, '.cq-seatbelt.sb'));
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', outsidePath],
      network: 'model-only',
    });
    // The planted profile is ignored: the compiled boundary still denies the
    // out-of-workspace read (under `(allow default)` it would have leaked).
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('outside-secret-value');
    // And the launcher never wrote through the planted path: the symlink
    // still carries exactly the attacker's content.
    expect(await readFile(evilProfile, 'utf8')).toBe(evilText);
  }, 30_000);

  test('a poisoned TMPDIR cannot move the compiled policy into the workspace', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    // An inherited TMPDIR pointing INSIDE the model-writable workspace would
    // defeat a 0700 policy directory — the confined child is the same uid —
    // so the policy parent must be canonical and env-independent.
    const priorTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(workspace, 'injected-tmp');
    try {
      const result = await adapter.launch({
        workspace,
        argv: ['/bin/cat', outsidePath],
        network: 'model-only',
      });
      expect(result.ok).toBe(false);
      expect(result.stdout).not.toContain('outside-secret-value');
      const listing = await readdir(workspace, { recursive: true });
      expect(listing.filter((entry) => entry.endsWith('.sb'))).toEqual([]);
      expect(listing.some((entry) => entry.includes('cq-sb-prof-'))).toBe(false);
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmp;
    }
  }, 30_000);

  test('a workspace traversing a symlink onto the policy parent is refused', async () => {
    // The containment guard must canonicalize (realpath), not compare
    // lexically: a workspace path THROUGH a symlink that resolves onto the
    // trusted policy parent is physically inside it even when the lexical
    // relative() says otherwise (Sol exact-head audit).  Baseline-first: the
    // shared parent may hold unrelated preexisting entries — the assertion is
    // that the refused launch ADDS nothing policy-shaped.
    const adapter = seatbeltAdapter();
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceThroughLink = join(linkDir, 'pvt');
    await symlink('/private/var/tmp', workspaceThroughLink);
    const before = new Set(await readdir('/private/var/tmp'));
    const result = await adapter.launch({
      workspace: workspaceThroughLink,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/contains the trusted policy parent/);
    const added = (await readdir('/private/var/tmp')).filter((entry) => !before.has(entry));
    expect(added.filter((entry) => entry.includes('cq-sb-prof-'))).toEqual([]);
  }, 30_000);

  test('a static symlink onto the policy parent mutates nothing before refusal', async () => {
    // Sol recheck: the old order ran mkdir(<workspace>/.tmp) BEFORE the
    // containment guard, so this exact case already created
    // /private/var/tmp/.tmp.  The guard now precedes every mutation.
    // Baseline-first assertion: the trusted parent is shared host state, so
    // the test captures what exists BEFORE the launch and requires the
    // refused launch to add nothing — it never deletes or requires the
    // absence of preexisting entries.
    const adapter = seatbeltAdapter();
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceThroughLink = join(linkDir, 'pvt');
    await symlink('/private/var/tmp', workspaceThroughLink);
    const before = new Set(await readdir('/private/var/tmp'));
    const result = await adapter.launch({
      workspace: workspaceThroughLink,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/contains the trusted policy parent/);
    const added = (await readdir('/private/var/tmp')).filter((entry) => !before.has(entry));
    expect(added).toEqual([]);
  }, 30_000);

  // PRACTICAL LIMIT, stated per reviewer: the mid-flight retarget refusal
  // ("workspace retargeted during launch") cannot be triggered
  // deterministically from outside the launch — a symlink swap would have to
  // land inside the window between the probe's two realpath calls, which no
  // public seam exposes, and a timing-based swap makes the test flaky by
  // construction.  The recheck itself is the enforcement (backend.ts,
  // "workspace retargeted during launch; the certified canonical binding is
  // stale"); this suite proves the deterministic parts — the containment
  // guard precedes every mutation, and the child binds only the canonical
  // path.  The race-window leg belongs to the fresh protocol's adversarial
  // review (A11/A17-style), not to a timing test here.

  test('the confined child binds the CANONICAL workspace, not the lexical path', async () => {
    const adapter = seatbeltAdapter();
    const workspaceReal = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-real-'));
    scratch.push(workspaceReal);
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceLink = join(linkDir, 'ws');
    await symlink(workspaceReal, workspaceLink);
    // One canonical binding for cwd and child TMPDIR: through a symlinked
    // workspace path, the child observes only the resolved directory.
    const result = await adapter.launch({
      workspace: workspaceLink,
      argv: ['/bin/sh', '-c', 'pwd; /usr/bin/printenv TMPDIR'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(workspaceReal);
    expect(result.stdout).toContain(join(workspaceReal, '.tmp'));
    expect(result.stdout).not.toContain(workspaceLink);
  }, 30_000);
});

describe.runIf(process.platform !== 'darwin')('seatbelt is darwin-only', () => {
  test('the adapter names the platform blocker', async () => {
    const availability = await seatbeltAdapter().available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/darwin/);
  });
});
