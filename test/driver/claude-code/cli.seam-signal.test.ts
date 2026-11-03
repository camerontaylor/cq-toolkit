// ---------------------------------------------------------------------------
// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding
// ---------------------------------------------------------------------------
// Split from test/driver/claude-code/cli.test.ts (pure move).

import { baseOptions, invocation, SpawnCall, thrownBy } from './cli.helpers.js';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { spawnManaged } from '../../../src/shared/proc.js';
import { DispatchError, errorClassOf } from '../../../src/driver/errors.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { SessionStore } from '../../../src/harness/session.js';

describe('claude-code CLI transport seam v2: RunOptions.signal + workspace binding', () => {
  test('a PRE-ABORTED options.signal never dispatches: aborted, zero usage, no session state', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'subdrv-s2-'));
    try {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_REPLY: 'must never run' },
          calls,
        ),
      );
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      // ZERO usage, no denials, and NO sessionId: no record was created for
      // a run that never dispatched.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(calls).toEqual([]); // the CLI was never spawned
      // No session state either — the store directory was never created.
      await expect(
        readdir(join(scratchDir, SESSIONS_DIR)).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an options.signal fired MID-RUN settles aborted — no governor in the loop', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'subdrv-s2-'));
    try {
      // No runLadder: the ambient governed context is UNDEFINED here, so the
      // only cancellation source is options.signal — the seam-v2 wiring. The
      // delay lands AFTER the abort listener attaches (synchronously after
      // the spawn) and while the block-until-abort fixture is still alive.
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'block-until-abort' }, calls),
      );
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined(); // the cancellation is not a failure
      // Usage observed so far: no result event arrived before the SIGTERM → zeros.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(calls).toHaveLength(1); // dispatched exactly once, then terminated
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace binding: the tool write lands in workspace.path; the record stays in sessionsDir recording the realpath', async () => {
    // realpath the scratch parent so the bound dir IS its own realpath
    // (macOS /var → /private/var) — the assertions then read literally.
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'subdrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      await mkdir(workspaceDir);
      const spawnedCwds: string[] = [];
      const extraEnv = {
        FAKE_AGENT_MODE: 'tool-then-reply',
        FAKE_AGENT_TOOL: 'bash',
        FAKE_AGENT_INPUT: JSON.stringify({ command: 'echo conformance-marker > note.txt' }),
        FAKE_AGENT_REPLY: 'wrote note.txt',
      };
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, extraEnv, []),
        // Record the spawn cwd (the base recordingSpawn records argv/env
        // only); the directive env merge is repeated here because THIS
        // override replaces recordingSpawn. Harness mode needs no
        // FAKE_AGENT_ALLOWED forwarding (the fixture reads --allowedTools).
        spawn: (opts) => {
          spawnedCwds.push(opts.cwd);
          return spawnManaged({ ...opts, env: { ...opts.env, ...extraEnv } });
        },
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['run'], mode: 'allowlist' },
          sandboxPolicy: { level: 'workspace-write' },
          workspace: { path: workspaceDir },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.denials).toEqual([]);
      // The CLI was dispatched with cwd = the bound workspace (its realpath).
      expect(spawnedCwds).toEqual([workspaceDir]);
      // The run tool really executed INSIDE the bound workspace.
      await expect(readFile(join(workspaceDir, 'note.txt'), 'utf8')).resolves.toContain(
        'conformance-marker',
      );
      // The record was created in the LANE's sessionsDir — never in the
      // workspace — and records the bound REALPATH as its workspace.
      const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(
        result.sessionId as string,
      );
      expect(record?.workspace).toBe(workspaceDir);
      expect(
        (await readdir(workspaceDir)).filter((f) => f.endsWith('.jsonl') || f.includes('cq-cli')),
      ).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace + sessionRef: the same realpath resumes; a different one throws config PRE-DISPATCH', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'subdrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      const otherDir = join(scratchDir, 'other');
      await mkdir(workspaceDir);
      await mkdir(otherDir);
      const calls: SpawnCall[] = [];
      const freshDriver = (): ClaudeCodeDriver =>
        new ClaudeCodeDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await freshDriver().run(invocation({ workspace: { path: workspaceDir } }));
      expect(run1.stopReason).toBe('complete');
      expect(calls).toHaveLength(1);

      // The SAME workspace for its OWN session: resumes bound to the same dir.
      const run2 = await freshDriver().run(
        invocation({ workspace: { path: workspaceDir }, sessionRef: run1.sessionId as string }),
      );
      expect(run2.stopReason).toBe('complete');
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(calls).toHaveLength(2);

      // A DIFFERENT workspace for the same session: a caller bug — a
      // pre-dispatch config throw; the CLI was never spawned for it.
      const err = await thrownBy(
        freshDriver().run(
          invocation({ workspace: { path: otherDir }, sessionRef: run1.sessionId as string }),
        ),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect(calls).toHaveLength(2); // unchanged — never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace.path that is relative or not an existing directory → DispatchError config, never dispatched', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'subdrv-s2-')));
    try {
      const aFile = join(scratchDir, 'plain-file.txt');
      await writeFile(aFile, 'not a directory', 'utf8');
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls),
      );
      for (const badPath of ['relative/workspace', join(scratchDir, 'absent'), aFile]) {
        const err = await thrownBy(driver.run(invocation({ workspace: { path: badPath } })));
        expect(errorClassOf(err), `workspace.path '${badPath}'`).toBe('config');
      }
      expect(calls).toEqual([]); // the CLI was never spawned
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
