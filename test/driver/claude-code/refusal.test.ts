// The D-E′ refusal void — recorded-fixture tests (Phase 1.9).
//
// The substrate's structured refusal statement (`stop_reason: 'refusal'`)
// is observed on BOTH transports and the void it triggers is structural:
// a refused response's payload NEVER becomes valid structured output,
// whatever its shape (the pre-0.3.302 defect delivered refused responses
// THROUGH `structured_output`, so a refusal whose payload happens to match
// the requested schema would validate — the shared judge refuses the
// payload outright on a refusal observation, before any validation runs).
//
// Fixtures: test/fixtures/claude-code/refusal-*.json|jsonl — RECORDED,
// version-labelled vendor frame shapes (see that directory's README for the
// provenance and the re-recording rule). The no-schema legs pin the other
// half of the contract: a refusal on a run with no schema request is a
// normal model outcome (complete verdict, transcript kept) whose narration
// marker makes it observable.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { fakeManagedSpawn } from '../../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../../helpers/transport-fakes.js';
import type { SpawnOptions } from '../../../src/driver/claude-code/process.js';
import { RoutingTableSchema } from '../../../src/driver/claude-code/routing.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { SessionStore } from '../../../src/harness/session.js';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';

process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

const FIXTURES = fileURLToPath(new URL('../../fixtures/claude-code', import.meta.url));

/** The recorded refusal stream (CLI transport), parsed once. */
const recordedCliFrames: JsonLineFrame[] = (
  await readFile(join(FIXTURES, 'refusal-cli-stream.jsonl'), 'utf8')
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as JsonLineFrame);

/** The recorded refusal frames (SDK transport), parsed once. */
const recordedSdkFrames: unknown[] = (
  JSON.parse(await readFile(join(FIXTURES, 'refusal-sdk-frames.json'), 'utf8')) as {
    frames: unknown[];
  }
).frames;

/** The refusal schema: matches the payload the recorded refusal DELIVERS. */
const refusalSchema = z.object({ answer: z.string(), confidence: z.number() }).strict();

const invocation = (overrides: Partial<OpInvocation> = {}): OpInvocation => ({
  prompt: 'refusal-fixture run',
  modelSpec: { provider: 'conformance', model: 'conformance-1' },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
  ...overrides,
});

const endpointTable = () =>
  RoutingTableSchema.parse({
    endpoints: {
      conformance: {
        baseUrlEnv: 'CONFORMANCE_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        notes: 'test endpoint: the recorded fixture is the model; the URL is never contacted',
      },
    },
  });

async function withScratch(body: (scratchDir: string) => Promise<void>): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'refusal-fixture-'));
  try {
    await body(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** A CLI-transport driver whose spawn replays the given recorded lines. */
function cliDriver(scratchDir: string, frames: readonly JsonLineFrame[]): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    routingTable: endpointTable(),
    sessionsDir: join(scratchDir, 'sessions'),
    harnessConfig: {
      ...defaultHarnessConfig,
      workspaceRoot: join(scratchDir, 'workspaces'),
    },
    spawn: fakeManagedSpawn(
      (_opts: SpawnOptions) => (_frame: JsonLineFrame, peer: JsonLinePeer) => {
        for (const frame of frames) peer.send(frame);
        peer.finish(0, null);
      },
    ),
  });
}

/** An SDK-transport driver whose mock module yields the given recorded frames. */
function sdkDriver(scratchDir: string, frames: readonly unknown[]): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    transport: 'sdk',
    routingTable: endpointTable(),
    sessionsDir: join(scratchDir, 'sessions'),
    harnessConfig: {
      ...defaultHarnessConfig,
      workspaceRoot: join(scratchDir, 'workspaces'),
    },
    sdkLoader: async () => ({
      query: async function* (): AsyncGenerator<unknown, void> {
        for (const frame of frames) yield frame;
      },
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (options: { name: string }) => ({ name: options.name, tools: [] }),
    }),
  });
}

/** The narration diagnostics persisted on the session record, as one string. */
async function narrationOf(scratchDir: string, verdict: WorkerResult): Promise<string> {
  const store = new SessionStore(join(scratchDir, 'sessions'));
  const record = await store.load(verdict.sessionId as string);
  if (record === undefined) return '';
  return record.messages
    .filter(
      (m) =>
        m.role === 'tool' && (m.toolName === 'cli-narration' || m.toolName === 'agent-narration'),
    )
    .flatMap((m) => {
      // The narration message content is a JSON array of marker strings.
      try {
        const parsed: unknown = JSON.parse(String(m.content));
        return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [String(m.content)];
      } catch {
        return [String(m.content)];
      }
    })
    .join('\n');
}

/** The recorded run WITHOUT a schema request: the substrate lists StructuredOutput in init iff --json-schema/outputFormat was sent, so the derived variant strips it (mirroring the real init). */
function withoutSchemaRequest(frames: readonly JsonLineFrame[]): JsonLineFrame[] {
  return frames.map((frame) => {
    const copy = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
    if (copy['type'] === 'system' && copy['subtype'] === 'init') {
      copy['tools'] = ((copy['tools'] as unknown[] | undefined) ?? []).filter(
        (tool) => tool !== 'StructuredOutput',
      );
    }
    return copy as JsonLineFrame;
  });
}

describe('refusal void — the recorded CLI fixture (refusal-cli-stream.jsonl)', () => {
  test('a refusal with a schema-valid payload is error/output-invalid; the payload never reaches the seam', async () => {
    await withScratch(async (scratchDir) => {
      const driver = cliDriver(scratchDir, recordedCliFrames);
      const verdict = await driver.run(
        invocation({
          outputSchema: toOutputSchema('test/refusal/v1', refusalSchema),
        }),
      );
      expect(verdict.stopReason).toBe('error');
      expect(verdict.errorClass).toBe('output-invalid');
      expect(verdict.error).toContain('refusal');
      expect(verdict).not.toHaveProperty('structuredOutput');
      // The spend was real: the measured usage is kept on the refused verdict.
      expect(verdict.usage).toEqual({ input: 12, output: 9, cacheRead: 0, cacheWrite: 0 });
      // The observation is persisted evidence, not just a verdict field.
      expect(await narrationOf(scratchDir, verdict)).toContain('"cq":"model-refusal"');
    });
  });

  test('the same refusal without a schema request is a complete model outcome with the marker recorded', async () => {
    await withScratch(async (scratchDir) => {
      const driver = cliDriver(scratchDir, withoutSchemaRequest(recordedCliFrames));
      const verdict = await driver.run(invocation());
      expect(verdict.stopReason).toBe('complete');
      expect(verdict).not.toHaveProperty('structuredOutput');
      expect(await narrationOf(scratchDir, verdict)).toContain('"cq":"model-refusal"');
    });
  });

  test('the void is channel-agnostic: a result-frame-only refusal (no assistant stop_reason) still voids the payload', async () => {
    await withScratch(async (scratchDir) => {
      // Deep-copy first: the shared recorded frames must never be mutated
      // by one test (the later legs read the untouched recording).
      const resultOnlyRefusal = recordedCliFrames.map(
        (frame) => JSON.parse(JSON.stringify(frame)) as Record<string, unknown>,
      );
      for (const frame of resultOnlyRefusal) {
        if (frame['type'] === 'assistant') {
          delete (frame['message'] as Record<string, unknown> | undefined)?.['stop_reason'];
        }
      }
      // Sanity: the assistant frame's stop_reason was stripped in place, the
      // result frame's own refusal stop_reason untouched.
      const assistant = resultOnlyRefusal.find((f) => f['type'] === 'assistant') as Record<
        string,
        unknown
      >;
      expect(assistant['message'] as Record<string, unknown>).not.toHaveProperty('stop_reason');
      const driver = cliDriver(scratchDir, resultOnlyRefusal as JsonLineFrame[]);
      const verdict = await driver.run(
        invocation({
          outputSchema: toOutputSchema('test/refusal/v1', refusalSchema),
        }),
      );
      expect(verdict.stopReason).toBe('error');
      expect(verdict.errorClass).toBe('output-invalid');
      expect(verdict).not.toHaveProperty('structuredOutput');
    });
  });
});

describe('refusal void — the recorded SDK fixture (refusal-sdk-frames.json)', () => {
  test('a refusal with a schema-valid payload is error/output-invalid; the payload never reaches the seam', async () => {
    await withScratch(async (scratchDir) => {
      const driver = sdkDriver(scratchDir, recordedSdkFrames);
      const verdict = await driver.run(
        invocation({
          outputSchema: toOutputSchema('test/refusal/v1', refusalSchema),
        }),
      );
      expect(verdict.stopReason).toBe('error');
      expect(verdict.errorClass).toBe('output-invalid');
      expect(verdict.error).toContain('refusal');
      expect(verdict).not.toHaveProperty('structuredOutput');
      expect(verdict.usage).toEqual({ input: 12, output: 9, cacheRead: 0, cacheWrite: 0 });
      expect(await narrationOf(scratchDir, verdict)).toContain('"cq":"model-refusal"');
    });
  });

  test('the same refusal without a schema request is a complete model outcome with the marker recorded', async () => {
    await withScratch(async (scratchDir) => {
      const driver = sdkDriver(
        scratchDir,
        withoutSchemaRequest(recordedSdkFrames as JsonLineFrame[]),
      );
      const verdict = await driver.run(invocation());
      expect(verdict.stopReason).toBe('complete');
      expect(verdict).not.toHaveProperty('structuredOutput');
      expect(await narrationOf(scratchDir, verdict)).toContain('"cq":"model-refusal"');
    });
  });
});
