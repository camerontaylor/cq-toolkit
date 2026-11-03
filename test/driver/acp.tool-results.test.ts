import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('deny-tool: a vendor-side execution failure maps to the frozen {tool, reason} denial channel', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'deny-tool',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'deny-tool run' }));
      expect(result.toolFailures).toBe(1);
      // The tool executed (allow-answered) and FAILED vendor-side: the
      // second denial channel carries the vendor's rawOutput.
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(result.stopReason).toBe('complete'); // the turn settled end_turn with real usage
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('a successful tool result reported via content blocks (no rawOutput) lands in the record output (Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture's SUCCESS path emits the tool_call_update with
      // content: [{type:'text', text}] and NO rawOutput — the committed
      // shape the old fold dropped (existing.output stayed ''). The
      // output must be the content blocks' text.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({
              command: 'echo content-block-marker > run-marker.txt',
            }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'content-block success run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'run');
      expect(toolMessage !== undefined).toBe(true); // the execution was persisted
      const folded = JSON.parse(toolMessage?.content as string) as {
        input: unknown;
        ok: boolean;
        output: string;
      };
      expect(folded.ok).toBe(true);
      expect(folded.output).toBe('exit 0'); // the block's text — never the empty string the old fold left
    });
  });

  test('a FAILED tool result carried by content blocks only: the denial reason comes from the text (the WorkerResult channel, Codex P2)', async () => {
    await withScratch(async (scratchDir) => {
      // FAKE_ACP_OMIT_RAW_OUTPUT: the content-only persona — even a
      // failure rides content blocks alone. The denial reason must be the
      // blocks' text, never the empty-output fallback wording ('tool
      // execution failed (…)') the old fold produced here.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'deny-tool',
            FAKE_ACP_OMIT_RAW_OUTPUT: '1',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'content-block failure run' }));
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(result.stopReason).toBe('complete'); // the turn settled end_turn; the denial rides the frozen channel
    });
  });

  test('a STRUCTURED rawOutput folds: the string-only schema no longer rejects the whole tool_call_update (#49)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_RAW_OUTPUT_JSON: the failed execution's rawOutput is an
      // OBJECT. The old string-only schema rejected the ENTIRE frame —
      // terminal status AND output lost (no denial, a card pending
      // forever). The fold stringifies non-strings at the protocol
      // boundary, so the status and the denial reason both survive.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'deny-tool',
            FAKE_ACP_RAW_OUTPUT_JSON: '1',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'structured rawOutput run' }));
      expect(result.stopReason).toBe('complete'); // the turn settles end_turn with real usage
      expect(result.denials).toEqual([
        { tool: 'edit', reason: '{"error":"permission denied: edit is not allowed"}' }, // stringified at the boundary
      ]);
      const record = await store.load(result.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'edit');
      expect(toolMessage !== undefined).toBe(true); // the terminal status survived the fold
      expect(
        (JSON.parse(toolMessage?.content as string) as { ok: boolean; output: string }).output,
      ).toBe('{"error":"permission denied: edit is not allowed"}');
    });
  });

  test('structured output: a non-JSON reply settles the uniform output-invalid verdict (ADR-0002 §2.3)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'prose before json {"answer":' },
          [],
        ),
      );
      const result = await driver.run(
        invocation({
          prompt: 'lying harness run',
          outputSchema: toOutputSchema(
            'test/structured/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      // S3 verdict unification: a miss is an ERROR verdict — the old
      // "complete with the payload dropped to narration" rule is deleted;
      // consumers read errorClass, never narration text tokens.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.error).toContain('structured output invalid');
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"structured-output-miss"'))).toBe(true);
    });
  });
});
