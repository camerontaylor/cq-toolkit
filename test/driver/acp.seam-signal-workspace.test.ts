import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../helpers/tmp-dir.js';
import { describe, expect, test } from 'vitest';
import { AcpDriver, ACP_SESSION_FILE } from '../../src/driver/acp/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { SESSIONS_DIR } from '../../src/driver/conformance.js';
import { SessionStore } from '../../src/harness/session.js';
import type { SpawnCall } from './acp.helpers.js';
import { driverOptions, invocation, withScratch, thrownBy } from './acp.helpers.js';

// ---------------------------------------------------------------------------
// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding
// ---------------------------------------------------------------------------

describe('acp driver seam v2: RunOptions.signal + workspace binding', () => {
  test('a PRE-ABORTED options.signal never dispatches: aborted, zero usage, no session state', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'must never run' }, calls),
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
      expect(calls).toEqual([]); // the harness was never spawned
      // No session state either — the store directory was never created.
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  test('an options.signal fired MID-RUN settles aborted — no governor in the loop', async () => {
    await withScratch(async (scratchDir) => {
      // No runLadder: the ambient governed context is UNDEFINED here, so the
      // only cancellation source is options.signal — the seam-v2 wiring. The
      // delay lands after the wire's abort listener attaches (wire creation,
      // right after the spawn); wherever the abort lands — handshake or
      // prompt — the run settles the honest 'aborted' verdict.
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'block-until-abort' }, calls),
        termGraceMs: 500,
        killGraceMs: 500,
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined(); // the cancellation is not a failure
      // Usage observed so far: no prompt response settled before the kill → zeros.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(calls).toHaveLength(1); // dispatched exactly once, then terminated
    });
  }, 20_000);

  test('workspace binding: the tool write lands in workspace.path; the record stays in sessionsDir recording the realpath', async () => {
    // Canonical scratch root (realTmpDir) so the bound dir IS its own
    // realpath — the assertions then read literally.
    const scratchDir = await realTmpDir('acpdrv-s2-');
    try {
      const workspaceDir = join(scratchDir, 'ws');
      await mkdir(workspaceDir);
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_TOOL_KIND: 'execute',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo conformance-marker > note.txt' }),
            FAKE_ACP_REPLY: 'wrote note.txt',
          },
          calls,
        ),
      );
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['run'], mode: 'unrestricted' },
          sandboxPolicy: { level: 'workspace-write' },
          workspace: { path: workspaceDir },
        }),
      );
      expect(result.stopReason).toBe('complete');
      // The run tool really executed INSIDE the bound workspace (the vendor
      // process is spawned with cwd = the bound realpath and executes there).
      await expect(readFile(join(workspaceDir, 'note.txt'), 'utf8')).resolves.toContain(
        'conformance-marker',
      );
      // The record was created in the LANE's sessionsDir — never in the
      // workspace — and records the bound REALPATH as its workspace. The
      // ACP session sidecar lives beside it, never in the workspace.
      const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(
        result.sessionId as string,
      );
      expect(record?.workspace).toBe(workspaceDir);
      expect((await readdir(workspaceDir)).filter((f) => f.endsWith(ACP_SESSION_FILE))).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace + sessionRef: the same realpath resumes; a different one throws config PRE-DISPATCH', async () => {
    // Canonical scratch root (realTmpDir) so the bound dirs ARE their own realpaths.
    const scratchDir = await realTmpDir('acpdrv-s2-');
    try {
      const workspaceDir = join(scratchDir, 'ws');
      const otherDir = join(scratchDir, 'other');
      await mkdir(workspaceDir);
      await mkdir(otherDir);
      const calls: SpawnCall[] = [];
      const freshDriver = (): AcpDriver =>
        new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
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
      // pre-dispatch config throw; the harness was never spawned for it.
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
  }, 20_000);

  test('workspace.path that is relative or not an existing directory → DispatchError config, never dispatched', async () => {
    await withScratch(async (scratchDir) => {
      const aFile = join(scratchDir, 'plain-file.txt');
      await writeFile(aFile, 'not a directory', 'utf8');
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
      for (const badPath of ['relative/workspace', join(scratchDir, 'absent'), aFile]) {
        const err = await thrownBy(driver.run(invocation({ workspace: { path: badPath } })));
        expect(errorClassOf(err), `workspace.path '${badPath}'`).toBe('config');
      }
      expect(calls).toEqual([]); // the harness was never spawned
    });
  });
});
