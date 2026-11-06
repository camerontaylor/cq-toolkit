// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding:
// a pre-aborted or mid-run options.signal settles aborted with no governor
// in the loop, and the workspace binding lands tool writes in
// workspace.path while the record stays in sessionsDir (the same realpath
// resumes; foreign or malformed paths are rejected pre-dispatch).
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { describe, expect, test } from 'vitest';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { DispatchError, errorClassOf } from '../../../src/driver/errors.js';
import { SessionStore } from '../../../src/harness/session.js';
import { driverWithCalls, invocation, optionsOf, thrownBy } from './sdk.helpers.js';

// ---------------------------------------------------------------------------
// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding
// ---------------------------------------------------------------------------

describe('claude-code sdk transport seam v2: RunOptions.signal + workspace binding', () => {
  test('a PRE-ABORTED options.signal never dispatches: aborted, zero usage, no session state', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s2-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'must never run' },
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      // ZERO usage, no denials, and NO sessionId: no record was created for
      // a run that never dispatched.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(calls).toEqual([]); // the mock backend was never called
      // No session state either — the store directory was never created.
      await expect(
        readdir(join(scratchDir, SESSIONS_DIR)).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an options.signal fired MID-RUN settles aborted — no governor in the loop', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s2-'));
    try {
      // No runLadder: the ambient governed context is UNDEFINED here, so the
      // only cancellation source is options.signal — the seam-v2 wiring.
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'block-until-abort' },
      });
      const controller = new AbortController();
      const poll = setInterval(() => {
        if (calls.length > 0) {
          clearInterval(poll);
          controller.abort();
        }
      }, 5);
      let result;
      try {
        result = await driver.run(invocation({ budget: { maxTokens: 10_000 } }), {
          signal: controller.signal,
        });
      } finally {
        clearInterval(poll);
      }
      expect(calls).toHaveLength(1); // dispatched, then aborted
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined(); // the cancellation is not a failure
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace binding: the tool write lands in workspace.path; the record stays in sessionsDir recording the realpath', async () => {
    // Canonical scratch root (realTmpDir) so the bound dir IS its own
    // realpath — the assertions then read literally.
    const scratchDir = await realTmpDir('agtdrv-s2-');
    try {
      const workspaceDir = join(scratchDir, 'ws');
      await mkdir(workspaceDir);
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: {
          kind: 'tool-then-reply',
          tool: 'bash',
          input: { command: 'echo conformance-marker > note.txt' },
          reply: 'wrote note.txt',
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
      // The agent was dispatched with cwd = the bound workspace (its realpath).
      expect(optionsOf(calls)['cwd']).toBe(workspaceDir);
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
    const scratchDir = await realTmpDir('agtdrv-s2-');
    try {
      const workspaceDir = join(scratchDir, 'ws');
      const otherDir = join(scratchDir, 'other');
      await mkdir(workspaceDir);
      await mkdir(otherDir);
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      const run1 = await driver.run(invocation({ workspace: { path: workspaceDir } }));
      expect(run1.stopReason).toBe('complete');
      expect(optionsOf(calls, 0)['cwd']).toBe(workspaceDir);

      // The SAME workspace for its OWN session: resumes bound to the same dir.
      const run2 = await driver.run(
        invocation({ workspace: { path: workspaceDir }, sessionRef: run1.sessionId as string }),
      );
      expect(run2.stopReason).toBe('complete');
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(optionsOf(calls, 1)['cwd']).toBe(workspaceDir);
      expect(calls).toHaveLength(2);

      // A DIFFERENT workspace for the same session: a caller bug — a
      // pre-dispatch config throw; the mock backend was never called for it.
      const err = await thrownBy(
        driver.run(
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
    const scratchDir = await realTmpDir('agtdrv-s2-');
    try {
      const aFile = join(scratchDir, 'plain-file.txt');
      await writeFile(aFile, 'not a directory', 'utf8');
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      for (const badPath of ['relative/workspace', join(scratchDir, 'absent'), aFile]) {
        const err = await thrownBy(driver.run(invocation({ workspace: { path: badPath } })));
        expect(errorClassOf(err), `workspace.path '${badPath}'`).toBe('config');
      }
      expect(calls).toEqual([]); // the mock backend was never called
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
