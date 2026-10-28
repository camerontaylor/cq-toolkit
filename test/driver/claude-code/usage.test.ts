// The shared worker-accounting fold — recorded, version-labelled fixtures
// (Phase 1.9, D-E′ usage handoff).
//
// ONE fold for BOTH transports (usage.ts):
//   1. the result frame's `modelUsage` per-model token aggregates when
//      well-shaped (subagent spend INCLUDED — the vendor's preferred
//      accounting field), tokens only (cost stays derived);
//   2. else the result frame's flat main-loop `usage` (subagent spend
//      excluded — a documented undercount the provenance marker makes
//      observable);
//   3. else the Σ assistant-frame usage (the no-result fallback).
// Every measured verdict records its `usage-provenance` narration marker
// (channel + model ids); an UNMEASURED verdict reports the honest zero and
// never a cost. On a RESUMED session the reported figure is recorded
// verbatim with the `resumed-usage-semantics` marker — session-cumulative
// on CLI ≥2.1.277-shaped frames, per-call before — and the conservative
// direction is pinned: a token cap between the two recorded figures
// classifies 'budget' on the cumulative one and not on the per-call one.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import {
  measureResultUsage,
  usageFromWire,
  zeroUsage,
} from '../../../src/driver/claude-code/usage.js';
import { fakeManagedSpawn } from '../../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../../helpers/transport-fakes.js';
import type { SpawnOptions } from '../../../src/shared/proc.js';
import { RoutingTableSchema } from '../../../src/driver/claude-code/routing.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { SessionStore, tempWorkspace } from '../../../src/harness/session.js';
import type { OpInvocation } from '../../../src/driver/types.js';

process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

const FIXTURES = fileURLToPath(new URL('../../fixtures/claude-code', import.meta.url));

/** The recorded SDK success frame carrying BOTH usage channels (parsed once). */
const modelUsageResult = (
  JSON.parse(await readFile(join(FIXTURES, 'usage/sdk-modelUsage-result.json'), 'utf8')) as {
    result: Record<string, unknown>;
  }
).result;

const parseJsonl = async (rel: string): Promise<JsonLineFrame[]> =>
  (await readFile(join(FIXTURES, 'usage', rel), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as JsonLineFrame);

const perCallFrames = await parseJsonl('cli-resume-per-call.jsonl');
const cumulativeFrames = await parseJsonl('cli-resume-cumulative.jsonl');

describe('the fold channels — measureResultUsage over the recorded frames', () => {
  test('modelUsage aggregates win and include subagent spend the flat usage excludes', () => {
    const measured = measureResultUsage(modelUsageResult);
    expect(measured).toBeDefined();
    expect(measured?.channel).toBe('modelUsage');
    // The aggregate: main-loop (100/50/10/2) PLUS the second model's
    // subagent spend (700/300/0/0) — the flat channel would have folded
    // 100/50/10/2 and undercounted by exactly the subagent tokens.
    expect(measured?.usage).toEqual({ input: 800, output: 350, cacheRead: 10, cacheWrite: 2 });
    expect(measured?.models).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5']);
    // The aggregate diverges from the flat main-loop usage — subagent spend.
    expect(measured?.includesSpendBeyondFlatUsage).toBe(true);
  });

  test('a result frame without modelUsage folds the flat main-loop usage as channel result', () => {
    const { result } = JSON.parse(JSON.stringify({ result: modelUsageResult })) as {
      result: Record<string, unknown>;
    };
    delete result['modelUsage'];
    const measured = measureResultUsage(result);
    expect(measured?.channel).toBe('result');
    expect(measured?.usage).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 2 });
    expect(measured?.models).toBeUndefined();
  });

  test('an aggregate that AGREES with the flat usage carries no divergence flag (the ordinary shape)', () => {
    const agreeing = {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 2,
      },
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 2,
        },
      },
    };
    const measured = measureResultUsage(agreeing as Record<string, unknown>);
    expect(measured?.channel).toBe('modelUsage');
    expect(measured?.includesSpendBeyondFlatUsage).toBe(false);
    // An entry with NO recognizable token field is unshaped — the channel
    // falls back to the flat usage rather than folding a fabricated zero.
    const junk = {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: { 'claude-sonnet-4-5': { costUSD: 0 } },
    };
    const fallback = measureResultUsage(junk as Record<string, unknown>);
    expect(fallback?.channel).toBe('result');
    expect(fallback?.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  });

  test('absent/lying numerics fold to the honest zero, and an unshaped usage is NO measurement', () => {
    // Seam v3 refinement: a record whose ONLY numeric fields are lying reports
    // no measurement at all — it must not read as a measured zero. (A mixed
    // record still folds: the valid fields count and the lying ones are 0.)
    expect(usageFromWire({ input_tokens: -5, output_tokens: 1.5 })).toBeUndefined();
    expect(usageFromWire({ input_tokens: 7, output_tokens: 1.5 })).toEqual({
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(usageFromWire('not a usage')).toBeUndefined();
    // Seam v3: an object that carries NO valid numeric field reports nothing —
    // it must not normalize to zeros that a measured zero would be confused with.
    expect(usageFromWire({})).toBeUndefined();
    // ...while an explicit numeric zero IS a measurement.
    expect(
      usageFromWire({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(measureResultUsage(undefined)).toBeUndefined();
    expect(zeroUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

// ---------------------------------------------------------------------------
// Driver-level legs: the fold + provenance + resume semantics end-to-end
// ---------------------------------------------------------------------------

const invocation = (overrides: Partial<OpInvocation> = {}): OpInvocation => ({
  prompt: 'usage-fixture run',
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
  const scratchDir = await mkdtemp(join(tmpdir(), 'usage-fixture-'));
  try {
    await body(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

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

async function narrationOf(scratchDir: string, sessionId: string): Promise<string> {
  const store = new SessionStore(join(scratchDir, 'sessions'));
  const record = await store.load(sessionId);
  if (record === undefined) return '';
  return record.messages
    .filter((m) => m.role === 'tool' && m.toolName === 'cli-narration')
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

describe('driver-level accounting — provenance and resume semantics', () => {
  test('the modelUsage channel rides the verdict with its provenance marker (subagent spend included)', async () => {
    await withScratch(async (scratchDir) => {
      // The SDK-shaped result frame rides the SAME fold sites on both
      // transports (the accounting is transport-independent); the init frame
      // satisfies the harness mode's fail-closed inventory.
      const init: JsonLineFrame = {
        type: 'system',
        subtype: 'init',
        session_id: 'rec-sdk-usage-1',
        model: 'claude-sonnet-4-5',
        tools: [],
        mcp_servers: [],
      };
      const driver = cliDriver(scratchDir, [init, modelUsageResult as JsonLineFrame]);
      const verdict = await driver.run(invocation());
      expect(verdict.stopReason).toBe('complete');
      expect(verdict.usage).toEqual({ input: 800, output: 350, cacheRead: 10, cacheWrite: 2 });
      const narration = await narrationOf(scratchDir, verdict.sessionId as string);
      expect(narration).toContain('"cq":"usage-provenance"');
      expect(narration).toContain('"channel":"modelUsage"');
      expect(narration).toContain('claude-haiku-4-5');
      // No resume: the resumed-semantics marker is absent.
      expect(narration).not.toContain('"cq":"resumed-usage-semantics"');
    });
  });

  test('a fresh run records provenance but never the resumed-semantics marker', async () => {
    await withScratch(async (scratchDir) => {
      const driver = cliDriver(scratchDir, perCallFrames);
      const verdict = await driver.run(invocation());
      expect(verdict.stopReason).toBe('complete');
      expect(verdict.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 0 });
      const narration = await narrationOf(scratchDir, verdict.sessionId as string);
      // The default channel records NO provenance marker — absence is the
      // documented baseline (usage.ts), so the record's role-'tool' shape
      // stays "a tool ran" only.
      expect(narration).not.toContain('"cq":"usage-provenance"');
      expect(narration).not.toContain('"cq":"resumed-usage-semantics"');
    });
  });

  test.each([
    [
      'per-call (<2.1.277 shape)',
      perCallFrames,
      { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 },
    ],
    [
      'session-cumulative (>=2.1.277 shape)',
      cumulativeFrames,
      { input: 410, output: 105, cacheRead: 22, cacheWrite: 0 },
    ],
  ])(
    'a RESUMED run records the reported %s figure verbatim with the semantics marker',
    async (_label, frames, expectedUsage) => {
      await withScratch(async (scratchDir) => {
        // A prior run's sidecar: this run RESUMES the substrate session.
        const sessionsDir = join(scratchDir, 'sessions');
        const store = new SessionStore(sessionsDir);
        const workspace = await tempWorkspace(join(scratchDir, 'workspaces'));
        const record = await store.create(workspace);
        await writeFile(
          join(sessionsDir, `${record.sessionId}.cq-cli-session`),
          'rec-resumed-session-1\n',
          { encoding: 'utf8', mode: 0o600 },
        );
        const driver = cliDriver(scratchDir, frames);
        const verdict = await driver.run(invocation({ sessionRef: record.sessionId }));
        expect(verdict.stopReason).toBe('complete');
        // The REPORTED figure is recorded verbatim — never a fabricated delta.
        expect(verdict.usage).toEqual(expectedUsage);
        const narration = await narrationOf(scratchDir, verdict.sessionId as string);
        // The default channel records no provenance marker (absence = result
        // channel); the resumed-semantics marker IS recorded.
        expect(narration).not.toContain('"cq":"usage-provenance"');
        expect(narration).toContain('"cq":"resumed-usage-semantics"');
      });
    },
  );

  test('the conservative direction: a token cap between the two recorded figures budgets only the cumulative one', async () => {
    await withScratch(async (scratchDir) => {
      const sessionsDir = join(scratchDir, 'sessions');
      const store = new SessionStore(sessionsDir);
      const recordA = await store.create(await tempWorkspace(join(scratchDir, 'workspaces')));
      const recordB = await store.create(await tempWorkspace(join(scratchDir, 'workspaces')));
      for (const record of [recordA, recordB]) {
        await writeFile(
          join(sessionsDir, `${record.sessionId}.cq-cli-session`),
          'rec-resumed-session-1\n',
          { encoding: 'utf8', mode: 0o600 },
        );
      }
      // 500 caps a 537-token cumulative session but not the 17-token per-call one.
      const cap = { maxTokens: 500 };
      const perCall = await cliDriver(scratchDir, perCallFrames).run(
        invocation({ sessionRef: recordA.sessionId, budget: cap }),
      );
      const cumulative = await cliDriver(scratchDir, cumulativeFrames).run(
        invocation({ sessionRef: recordB.sessionId, budget: cap }),
      );
      expect(perCall.stopReason).toBe('complete');
      expect(cumulative.stopReason).toBe('budget');
    });
  });

  test('an unmeasured verdict reports the honest zero, never a cost', async () => {
    await withScratch(async (scratchDir) => {
      // An empty stream: no init, no frames, no usage — the spawn succeeds
      // and closes with no result event.
      const driver = cliDriver(scratchDir, []);
      const verdict = await driver.run(invocation());
      expect(verdict.stopReason).toBe('error');
      expect(verdict.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(verdict).not.toHaveProperty('costUSD');
      expect(verdict).not.toHaveProperty('costBasis');
    });
  });
});
