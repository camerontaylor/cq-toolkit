// The REAL-SDK presence test — T1.6 (Codex round-3 thread).
//
// WHY THIS FILE EXISTS: every other claude-agent test injects a mock module
// through the driver's `sdkLoader` seam (deterministic, offline), which
// means the install matrix's `with-peer` job — the half that installs
// `@anthropic-ai/claude-agent-sdk@0.3.270` — never actually exercised the
// PRODUCTION dynamic-import path against the REAL installed package. This
// file closes that gap: when the optional peer is present, it drives the
// driver's own loader and capability detection against the real surface,
// with ZERO endpoint traffic.
//
// WHY IT SKIPS WITHOUT THE PEER: the repo's `without-peer` half is
// deliberate (the SDK is an optional peerDependency, never a dependency;
// the whole package must build and pass with it absent). `sdkPresent`
// probes resolution and the describe is skipped silently when the peer is
// missing — the claude-agent.test.ts mock tests are the without-peer
// coverage; this file is the with-peer complement.
//
// RESOLUTION PATH: the driver's production loader dynamically imports the
// bare specifier exported as `SDK_MODULE_SPECIFIER`, which node resolves
// from node_modules at run time. The test imports that SAME exported
// constant and dynamically imports it — node resolves the identical
// package from the identical tree (a literal specifier here would also ask
// tsc to statically resolve a package this repo deliberately does not
// install). No SDK types are imported, ever (I10).
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeAgentDriver, SDK_MODULE_SPECIFIER } from '../../src/driver/claude-agent/index.js';
import type { OpInvocation } from '../../src/driver/types.js';

// Top-level probe: does the optional peer resolve in THIS tree? A missing
// package rejects the dynamic import — that is the skip signal, never an
// error.
const sdkPresent: boolean = await import(SDK_MODULE_SPECIFIER).then(
  () => true,
  () => false,
);

function invocation(): OpInvocation {
  return {
    prompt: 'sdk-presence probe',
    modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    // A non-positive token cap is rejected in PRE-DISPATCH validation,
    // AFTER the SDK load + capability detection and BEFORE any session or
    // network exists — the one documented failure that proves the whole
    // production import path ran, with zero endpoint traffic.
    budget: { maxTokens: 0 },
  };
}

describe.skipIf(!sdkPresent)('claude-agent driver × REAL installed SDK (production import path)', () => {
  test('the production loader resolves the real module and its surface feature-detects', async () => {
    const mod = (await import(SDK_MODULE_SPECIFIER)) as Record<string, unknown>;
    // The exact feature detection the driver performs on the loaded module
    // (asAgentSdkModule): the real package must expose the driven surface —
    // query / tool / createSdkMcpServer.
    expect(typeof mod['query']).toBe('function');
    expect(typeof mod['tool']).toBe('function');
    expect(typeof mod['createSdkMcpServer']).toBe('function');
  }, 30_000);

  test('run() with the default loader fails DOCUMENTED pre-dispatch (no network, no session)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'sdk-presence-'));
    const savedKey = process.env['ANTHROPIC_API_KEY'];
    try {
      // Satisfy the pre-dispatch key check with a DUMMY value (never used:
      // this run is rejected before dispatch, so no endpoint is contacted).
      process.env['ANTHROPIC_API_KEY'] = 'sdk-presence-dummy-key';
      const driver = new ClaudeAgentDriver({ sessionsDir: join(scratchDir, 'sessions') });
      // The rejection must be the budget-validation error — reaching it
      // PROVES the default loader resolved the real module and capability
      // detection passed (a peer problem would have thrown the peer-absent
      // or capability error instead, before this line could).
      await expect(driver.run(invocation())).rejects.toThrow(
        /budget.maxTokens must be a finite number > 0/,
      );
      // Pre-dispatch means pre-session: the store directory was never even
      // created (mkdir is the first store side effect).
      await expect(stat(join(scratchDir, 'sessions'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = savedKey;
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 30_000);
});
