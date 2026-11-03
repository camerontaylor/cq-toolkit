import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { SESSIONS_DIR, CONFORMANCE_MODEL } from '../../src/driver/conformance.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import type { SpawnCall } from './acp.helpers.js';
import {
  FAKE_ACP_SERVER,
  acpSidecarPath,
  driverOptions,
  invocation,
  withScratch,
} from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('the spawn seam receives the resolved binary + driver-built argv (no shell, model env attached)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
      await driver.run(invocation({ prompt: 'argv run' }));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toMatch(/node$/); // the resolved binary (which-like PATH hit)
      expect(calls[0]?.args).toEqual([FAKE_ACP_SERVER]); // the driver-built argv tail
      expect(calls[0]?.env['FAKE_ACP_MODEL']).toBe(CONFORMANCE_MODEL); // the modelEnv REQUEST channel
    });
  });

  test('structured output round-trip through the wire: prompt-directed JSON lands in structuredOutput', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
      );
      const result = await driver.run(
        invocation({
          prompt: 'structured run',
          outputSchema: toOutputSchema(
            'test/structured/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
    });
  });

  test('path escape: the harness tool containment denial surfaces as the frozen denial', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: '../../outside-secret.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'escape attempt' }));
      expect(
        result.denials.some((d) => d.tool === 'read' && d.reason.includes('path escape')),
      ).toBe(true);
    });
  });

  test('fresh runs share NOTHING (I6): separate workspaces, separate ACP sessions, separate sidecars', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const driver1 = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await driver1.run(invocation({ prompt: 'isolation run one' }));
      const calls2: SpawnCall[] = [];
      const driver2 = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls2));
      const run2 = await driver2.run(invocation({ prompt: 'isolation run two' }));
      expect(run2.sessionId).not.toBe(run1.sessionId);
      const record1 = await store.load(run1.sessionId as string);
      const record2 = await store.load(run2.sessionId as string);
      expect(record1?.workspace).not.toBe(record2?.workspace);
      // Each run created a FRESH ACP session (never resumed the other's).
      const id1 = (
        await readFile(
          acpSidecarPath(join(scratchDir, SESSIONS_DIR), record1?.sessionId as string),
          'utf8',
        )
      ).trim();
      const id2 = (
        await readFile(
          acpSidecarPath(join(scratchDir, SESSIONS_DIR), record2?.sessionId as string),
          'utf8',
        )
      ).trim();
      expect(id1).not.toBe(id2);
      // Run 1's prompt never leaked into run 2's record.
      expect(record2?.messages.some((m) => m.content === 'isolation run one')).toBe(false);
    });
  });
});
