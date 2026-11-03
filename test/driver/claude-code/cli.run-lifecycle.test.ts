// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: dispatch/remap observation, resume + workspace continuation, sandbox marker.

import {
  baseOptions,
  invocation,
  narrationOf,
  thrownBy,
  withScratch,
  SpawnCall,
} from './cli.helpers.js';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { CLI_SESSION_FILE } from '../../../src/driver/claude-code/sessions.js';
import { DispatchError, errorClassOf } from '../../../src/driver/errors.js';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  test('THE REMAP DEFENCE IS POST-DISPATCH (§2.6): unknown provider still refuses pre-dispatch; an unknown MODEL now dispatches and the served id is observed', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      // The deepseek endpoint reads its key value at run() time. Stubbed
      // (not written): a host DEEPSEEK_API_KEY stays untouched and the
      // afterEach unstub restores the unset state.
      vi.stubEnv('DEEPSEEK_API_KEY', 'offline-remap-key');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_SERVED_MODEL: 'deepseek-default-served' },
          calls,
        ),
      );
      // UNKNOWN PROVIDER — still a pre-dispatch config throw (routing is
      // config, not a model outcome). Zero spawns, no sessions dir.
      const providerErr = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'whatever' } })),
      );
      expect(providerErr).toBeInstanceOf(DispatchError);
      expect(errorClassOf(providerErr)).toBe('config'); // seam v2: pre-dispatch class
      expect((providerErr as Error).message).toMatch(/unknown provider 'nope'/);
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // UNKNOWN MODEL — the pre-dispatch model allowlist is RETIRED
      // (ADR-0002 §2.6): the name routes through and the run DISPATCHES (a
      // DeepSeek-style gateway would silently serve its default here). The
      // defence is the observable fact: WorkerResult.model carries the id
      // the endpoint actually served, and the shared served-model assertion
      // (ADR-0002 §2.6 — the factory applies it to every resolved driver;
      // see served-model.test.ts / factory.wrappers.test.ts) fails the mismatch
      // post-hoc with errorClass 'served-model-mismatch'.
      const remapped = await driver.run(
        invocation({ modelSpec: { provider: 'deepseek', model: 'gpt-9-imaginary' } }),
      );
      expect(calls).toHaveLength(1); // dispatched — the pre-dispatch model throw is gone
      expect(remapped.model).toBe('deepseek-default-served'); // the honest observation
      expect(remapped.model).not.toBe('gpt-9-imaginary'); // the wrapper fails this run loudly
    });
  });

  test('resume: the second run passes --resume; the sidecar lives in the STORE, not the workspace (#19-12/#26)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new ClaudeCodeDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      expect(calls[0]?.args).not.toContain('--resume'); // fresh run: no resume flag
      // The sidecar is RELOCATED (issue #26, design (b)): beside the session
      // records, keyed by sessionId — never in the model-visible workspace.
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const sidecarPath = join(
        scratchDir,
        SESSIONS_DIR,
        `${run1.sessionId as string}${CLI_SESSION_FILE}`,
      );
      const cliId = (await readFile(sidecarPath, 'utf8')).trim();
      expect(cliId).toMatch(/^fake-cli-/);
      // 0o600 — the sidecar is evidence like the records it sits beside,
      // never world-readable (review thread: mode was umask-default 0o666).
      expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      const noSidecarInWorkspace = async (): Promise<void> => {
        const files = await readdir(workspace);
        expect(files.filter((f) => f.endsWith(CLI_SESSION_FILE))).toEqual([]);
      };
      await noSidecarInWorkspace();

      // The resumed run forwards the recorded CLI session id as --resume
      // (proven by the fixture echoing it) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'resume-echo' }, calls2),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      expect(calls2[0]?.args).toContain('--resume');
      const resumeIndex = calls2[0]?.args.indexOf('--resume') ?? -1;
      expect(calls2[0]?.args[resumeIndex + 1]).toBe(cliId);

      // ONE session record carries both runs' turns; the store sidecar is
      // stable, and the workspace still carries NO resume handle.
      const record = await store.load(run1.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one'),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two'),
      ).toBe(true);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from cli session ${cliId}`),
        ),
      ).toBe(true);
      expect((await readFile(sidecarPath, 'utf8')).trim()).toBe(cliId);
      await noSidecarInWorkspace();
    });
    // Real CLI resume argv plus the sidecar filesystem contract; this budget
    // covers two child process startups, not an in-process decision.
  }, 15_000);

  test('echo-workspace: the fixture executes a real read in the resumed workspace', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new ClaudeCodeDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'seed run' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      await writeFile(join(workspace, 'note.txt'), 'hello note', 'utf8');

      const second = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'echo-workspace', FAKE_AGENT_PATH: 'note.txt' },
          [],
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(invocation({ prompt: 'echo run', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete');
      expect(run2.denials).toEqual([]); // the file is really there
      const record = await store.load(run1.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'read');
      expect(toolMessage === undefined).toBe(false);
      const folded = JSON.parse((toolMessage?.content ?? '{}') as string) as {
        input: { path: string };
        ok: boolean;
        output: string;
      };
      expect(folded.input.path).toBe('note.txt');
      expect(folded.ok).toBe(true);
      expect(folded.output).toBe('--- note.txt ---\n     1: hello note');
    });
  });

  test('sandbox-level-unenforced marker: a requested level is recorded as unenforced (#19-7)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(baseOptions(scratchDir, {}, []));
      // The default invocation requests workspace-write — the marker must
      // record that THIS driver does not enforce it (trust statement, header).
      const result = await driver.run(invocation({ prompt: 'sandbox marker run' }));
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"sandbox-level-unenforced"'));
      expect(marker).toBeDefined();
      // Harness mode: the harness enforces the TOOL-level sandbox mapping on
      // this lane, so the marker narrows to OS confinement.
      expect(JSON.parse(marker as string)).toEqual({
        cq: 'sandbox-level-unenforced',
        level: 'workspace-write',
        layer: 'os',
      });

      // Stock mode (null-hypothesis evals): nothing the harness enforces
      // applies — the LEGACY marker, no layer.
      const stockDriver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, []),
        toolSurface: 'stock',
      });
      const stockResult = await stockDriver.run(invocation({ prompt: 'stock sandbox marker run' }));
      expect(stockResult.stopReason).toBe('complete');
      const stockMarker = (await narrationOf(store, stockResult.sessionId as string)).find((line) =>
        line.includes('"sandbox-level-unenforced"'),
      );
      expect(JSON.parse(stockMarker as string)).toEqual({
        cq: 'sandbox-level-unenforced',
        level: 'workspace-write',
      });

      // level 'none' asks for nothing extra → no marker…
      const noneDriver = new ClaudeCodeDriver(baseOptions(scratchDir, {}, []));
      const noneResult = await noneDriver.run(
        invocation({ prompt: 'no sandbox run', sandboxPolicy: { level: 'none' } }),
      );
      const noneNarration = await narrationOf(store, noneResult.sessionId as string);
      expect(noneNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(false);
      // …and a level over an EMPTY tool surface (mode 'none': nothing
      // pre-approved, headless-denied) has nothing unenforced to observe —
      // no marker (the conformance contract also pins such records to zero
      // tool-role messages).
      const emptySurface = new ClaudeCodeDriver(baseOptions(scratchDir, {}, []));
      const emptyResult = await emptySurface.run(
        invocation({ prompt: 'empty surface run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      const emptyNarration = await narrationOf(store, emptyResult.sessionId as string);
      expect(emptyNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(
        false,
      );
    });
  });
});
