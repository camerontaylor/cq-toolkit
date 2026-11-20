// Split from test/driver/claude-code/cli.test.ts (pure move); the outer describe
// wrapper is reproduced in this file and in cli.harness-config.test.ts.
// Subject: the W1.4 fail-closed init surface, harness denials/failures, governed abort.

import {
  baseOptions,
  harnessObservation,
  initLine,
  invocation,
  launchControl,
  line,
  markersOf,
  narrationOf,
  processGone,
  recordingSpawn,
  toolResultLine,
  toolUseLine,
  withScratch,
} from './cli.helpers.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { handleStdoutLine, HARNESS_MCP_CONFIG_FILE } from '../../../src/driver/claude-code/cli.js';
import { HARNESS_ERROR_PREFIX } from '../../../src/driver/claude-code/verdict.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { realClock, runLadder } from '../../../src/kernel/governor.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';

describe('claude-code CLI transport: the closed harness tool surface (W1.4)', () => {
  test('init mismatch: an unstripped builtin in init.tools → error, harness prefix, surface-mismatch marker', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_INIT_EXTRA_TOOL: 'Bash' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'leaky builtin run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('init surface mismatch');
      expect(result.error).toContain('Bash');
      const [marker, ...rest] = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ cq: 'harness-surface-mismatch', errorClass: 'harness' });
      expect(JSON.stringify(marker?.['observed'])).toContain('Bash');
    });
  });

  test('init mismatch: an extra connected MCP server → error with the harness prefix', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_INIT_EXTRA_SERVER: 'ambient-connector' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'leaky server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('ambient-connector');
      const markers = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]?.['errorClass']).toBe('harness');
    });
  });

  test('the REAL server refusing its argv at startup (exit 78) → init reports failed → error/harness', async () => {
    launchControl.extraArgs = ['stray-argument']; // bin.ts demands exactly one argument
    onTestFinished(() => {
      launchControl.extraArgs = [];
    });
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'tool-then-reply', FAKE_AGENT_TOOL: 'read' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'refused server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.denials).toEqual([]); // no tool ever ran
      const [marker] = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(marker?.['observed']).toEqual({
        mcp_servers: [{ name: 'cq-harness', status: 'failed' }],
        tools: [],
      });
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(false);
    });
  });

  test('no init event at all in harness mode → harness-surface-unverified error, never a model outcome', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_NO_INIT: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'silent init run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('never reported its init surface');
      expect(
        await markersOf(store, result.sessionId as string, 'harness-surface-unverified'),
      ).toEqual([{ cq: 'harness-surface-unverified', errorClass: 'harness' }]);
    });
  });

  test('a harness failure voids structured output: an unverified run never exposes the payload (review r1)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_NO_INIT: '1' }, []),
      );
      const result = await driver.run(
        invocation({
          prompt: 'unverified structured run',
          outputSchema: toOutputSchema(
            'test/unverified/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.structuredOutput).toBeUndefined();
    });
  });

  test('the server dying mid-run → transport failure: error/harness, NOT a denial', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_AGENT_KILL_SERVER: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'dead server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.denials).toEqual([]);
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('transport failure');
      expect(result.error).toContain('MCP error -32000: Connection closed');
      expect(
        await markersOf(store, result.sessionId as string, 'harness-transport-failure'),
      ).toEqual([
        {
          cq: 'harness-transport-failure',
          errorClass: 'harness',
          tool: 'read',
          text: 'MCP error -32000: Connection closed',
        },
      ]);
    });
  });

  test('a REAL harness denial (path escape) is a denial under the harness name; the run completes', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: '../../outside-secret.txt' }),
            FAKE_AGENT_REPLY: 'noted the refusal',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'escape run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      expect(result.denials).toHaveLength(1);
      expect(result.denials[0]?.tool).toBe('read');
      expect(result.denials[0]?.reason.startsWith('PATH_ESCAPE: path escape:')).toBe(true);
      // The session record speaks harness names, never the qualified spelling.
      const record = await store.load(result.sessionId as string);
      const toolMessages = record?.messages.filter(
        (m) => m.role === 'tool' && m.toolName !== 'cli-narration',
      );
      expect(toolMessages?.map((m) => m.toolName)).toEqual(['read']);
      const folded = JSON.parse(toolMessages?.[0]?.content ?? '{}') as { ok: boolean };
      expect(folded.ok).toBe(false);
    });
  });

  test('a harness-served tool that SUCCEEDS lands as a role-tool message with the server text', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'bash',
            FAKE_AGENT_INPUT: JSON.stringify({ command: 'echo served-marker > note.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'served run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.denials).toEqual([]);
      const record = await store.load(result.sessionId as string);
      expect(await readFile(join(record?.workspace as string, 'note.txt'), 'utf8')).toBe(
        'served-marker\n',
      );
      const message = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'bash');
      expect(JSON.parse(message?.content ?? '{}')).toMatchObject({
        input: { command: 'echo served-marker > note.txt' },
        ok: true,
      });
    });
  });

  test('stdout fold: a CLI permission denial (frame or CLI text) is a denial; unknown is_error text is a transport failure', () => {
    const read = 'mcp__cq-harness__read';
    const edit = 'mcp__cq-harness__edit';

    // (a) The permission_denied FRAME names the tool_use: whatever the text,
    // the errored result is a permission denial.
    const framed = harnessObservation(['read', 'edit']);
    handleStdoutLine(framed, initLine([read, edit]));
    expect(framed.harnessConnected).toBe(true);
    expect(framed.harnessFailure).toBeUndefined();
    handleStdoutLine(framed, toolUseLine('t1', edit));
    handleStdoutLine(
      framed,
      line({ type: 'system', subtype: 'permission_denied', tool_name: edit, tool_use_id: 't1' }),
    );
    handleStdoutLine(framed, toolResultLine('t1', 'denied by policy'));
    expect(framed.denials).toEqual([{ tool: 'edit', reason: 'denied by policy' }]);
    expect(framed.harnessFailure).toBeUndefined();

    // (b) No frame, but the CLI's own permission text → a denial too.
    const texted = harnessObservation(['read', 'edit']);
    handleStdoutLine(texted, initLine([read, edit]));
    handleStdoutLine(texted, toolUseLine('t2', edit));
    const cliText = `Claude requested permissions to use ${edit}, but you haven't granted it yet.`;
    handleStdoutLine(texted, toolResultLine('t2', cliText));
    expect(texted.denials).toEqual([{ tool: 'edit', reason: cliText }]);
    expect(texted.harnessFailure).toBeUndefined();

    // (c) A stable harness denial prefix (text-block form) → a denial.
    const harnessDenied = harnessObservation(['read']);
    handleStdoutLine(harnessDenied, initLine([read]));
    handleStdoutLine(harnessDenied, toolUseLine('t3', read));
    handleStdoutLine(
      harnessDenied,
      toolResultLine('t3', [{ type: 'text', text: "FS_NOT_FOUND: file not found: 'x'" }]),
    );
    expect(harnessDenied.denials).toEqual([
      { tool: 'read', reason: "FS_NOT_FOUND: file not found: 'x'" },
    ]);
    expect(harnessDenied.harnessFailure).toBeUndefined();

    // (d) Anything else on a harness tool → transport failure, never a denial.
    const broken = harnessObservation(['read']);
    handleStdoutLine(broken, initLine([read]));
    handleStdoutLine(broken, toolUseLine('t4', read));
    handleStdoutLine(broken, toolResultLine('t4', 'MCP error -32001: Request timed out'));
    expect(broken.denials).toEqual([]);
    expect(broken.harnessFailure).toEqual({
      cq: 'harness-transport-failure',
      errorClass: 'harness',
      tool: 'read',
      text: 'MCP error -32001: Request timed out',
    });

    // (e) Only the FIRST init is asserted, and an extra builtin fails it.
    const leaky = harnessObservation(['read']);
    handleStdoutLine(leaky, initLine([read, 'Bash']));
    handleStdoutLine(leaky, initLine([read]));
    expect(leaky.harnessConnected).toBe(false);
    expect(leaky.harnessFailure?.cq).toBe('harness-surface-mismatch');
  });

  test('governed abort in harness mode → aborted (not a harness error), and no server process survives', async () => {
    await withScratch(async (scratchDir, store) => {
      const pidFile = join(scratchDir, 'server.pid');
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('init-gated deadline');
      const spawn = recordingSpawn([], {
        FAKE_AGENT_MODE: 'block-until-abort',
        FAKE_AGENT_SERVER_PID_FILE: pidFile,
      });
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((l) => {
            if (l.includes('"subtype":"init"')) queueMicrotask(() => deadline?.());
          });
          return child;
        },
        termGraceMs: 500,
        killGraceMs: 500,
      });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(invocation({ prompt: 'governed harness run' }), { signal: ctx.signal }),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-harness-abort', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.error).toBeUndefined();
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((l) => l.includes('"errorClass":"harness"'))).toBe(false);
      const pids = (await readFile(pidFile, 'utf8'))
        .split('\n')
        .filter((l) => l !== '')
        .map(Number);
      expect(pids).toHaveLength(1);
      for (const pid of pids) expect(await processGone(pid)).toBe(true);
      // The config is gone even though the run never completed.
      expect(
        (await readdir(join(scratchDir, SESSIONS_DIR))).some((f) =>
          f.endsWith(HARNESS_MCP_CONFIG_FILE),
        ),
      ).toBe(false);
    });
  });
});
