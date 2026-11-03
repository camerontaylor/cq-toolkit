// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject into
// strict-token-budget-guard.{assertion,direct-entry,factory-bindings,ai-sdk-unchanged,cancellation,entry-guard-sweep}.test.ts;
// this module holds the fixtures they share and declares no tests.
//
// Strict-budget lane gate — the fail-closed boundary that keeps the shared
// `Budget.strictTokenBudget` promise honest on lanes that do NOT enforce a
// pre-request ceiling (subprocess / claude-agent / acp). A strict request
// routed to such a lane must REFUSE before any session, credential read, spawn
// or provider contact — via the factory's resolved-driver guard AND via direct
// lane construction. The ai-sdk lane (the one lane that enforces the ceiling)
// is unchanged: it still needs an injected trusted capability and still
// refuses without one.
//
// Offline: every lane is constructed with a throwing spy on its own dispatch
// seam (spawn / sdkLoader / spawn), so "not called" is the no-dispatch proof.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { ModelSpec, OpInvocation } from '../../src/driver/types.js';

export const STRICT = { strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 } };

export function invocation(
  modelSpec: ModelSpec,
  budget: OpInvocation['budget'] = STRICT,
): OpInvocation {
  return {
    prompt: 'strict-budget guard probe',
    modelSpec,
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget,
  };
}

/** A dispatch-seam spy that records the call and then fails loudly. */
export function seamSpy(): { calls: number; fn: () => never } {
  const spy = {
    calls: 0,
    fn: (): never => {
      spy.calls += 1;
      throw new Error('dispatch-seam-reached');
    },
  };
  return spy;
}

export async function scratch(): Promise<{ root: string; sessionsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cq-strict-guard-'));
  return { root, sessionsDir: join(root, 'sessions') };
}

export function textResult(): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
}

export const FAKE_CAPABILITY = {
  provenance: 'test:guard',
  count: (serialized: string) => Buffer.byteLength(serialized, 'utf8'),
  withOutputCeiling: (
    params: LanguageModelV4CallOptions,
    reserveOutputTokens: number,
  ): LanguageModelV4CallOptions => ({ ...params, maxOutputTokens: reserveOutputTokens }),
};
