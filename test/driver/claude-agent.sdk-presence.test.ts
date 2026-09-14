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
//
// ABSENT vs BROKEN (issue #29): the peer being GENUINELY ABSENT is the
// documented without-peer posture (skip signal); anything else — a missing
// TRANSITIVE dependency (the peer IS installed but cannot load) or any
// other failure shape (module-init throw, incompatible runtime) — is a
// BROKEN INSTALL that must fail the with-peer job loudly, never
// masquerade as "peer absent". classifySdkPresence makes the distinction
// explicit and testable; the top-level probe THROWS on 'broken' with the
// underlying error attached.
//
// Resolution-target matching: the specifier must appear as the QUOTED
// resolution target in the message (node: `Cannot find package '<spec>'`;
// vitest's module runner: `Could not resolve "<spec>"`) — because an
// ERR_MODULE_NOT_FOUND for a TRANSITIVE dependency names the SDK's own
// dist path as the IMPORTING module, and a bare substring match would
// misread that as absence.
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeAgentDriver, SDK_MODULE_SPECIFIER } from '../../src/driver/claude-agent/index.js';
import type { OpInvocation } from '../../src/driver/types.js';

/**
 * Classify ONE import rejection (issue #29): 'absent' when the top-level
 * SDK_MODULE_SPECIFIER itself could not be resolved (its quoted
 * resolution-target form in the message — with ERR_MODULE_NOT_FOUND, or
 * bare under vitest's module-runner wrapper); 'broken' for everything
 * else, including an ERR_MODULE_NOT_FOUND whose resolution target is a
 * DIFFERENT specifier (a missing transitive dependency) and any
 * non-ENOENT-shaped failure (module-init throw, incompatible runtime, …).
 */
export function classifySdkPresence(err: unknown): 'absent' | 'broken' {
  if (typeof err !== 'object' || err === null) return 'broken';
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return 'broken';
  const quotedTarget =
    message.includes(`'${SDK_MODULE_SPECIFIER}'`) || message.includes(`"${SDK_MODULE_SPECIFIER}"`);
  if (code === 'ERR_MODULE_NOT_FOUND' || quotedTarget) {
    return quotedTarget ? 'absent' : 'broken';
  }
  return 'broken';
}

// Top-level probe: does the optional peer resolve in THIS tree — and did it
// LOAD cleanly? 'absent' is the skip signal; a 'broken' verdict throws
// loudly with the underlying error attached (issue #29).
let sdkPresent = true;
try {
  await import(SDK_MODULE_SPECIFIER);
} catch (err) {
  if (classifySdkPresence(err) === 'absent') {
    sdkPresent = false; // the genuine without-peer posture — skip silently
  } else {
    throw new Error(
      'claude-agent sdk-presence: the optional peer is installed but FAILED to load — ' +
        'fix the install; the with-peer job must never go green over a broken peer (issue #29)',
      { cause: err },
    );
  }
}

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

// ---------------------------------------------------------------------------
// Issue #29 — the absent/broken classifier, unit-tested with synthetic
// errors (no install matrix needed to pin the distinction)
// ---------------------------------------------------------------------------

describe('classifySdkPresence (issue #29: genuinely absent vs broken install)', () => {
  test('ERR_MODULE_NOT_FOUND naming the TOP-LEVEL specifier → absent (the without-peer posture)', () => {
    expect(
      classifySdkPresence({
        code: 'ERR_MODULE_NOT_FOUND',
        message: `Cannot find package '${SDK_MODULE_SPECIFIER}' imported from /repo/src/driver/claude-agent/index.ts`,
      }),
    ).toBe('absent');
  });

  test('the module-runner wrapper shape (no code, quoted specifier) → absent too', () => {
    // Vitest intercepts the dynamic import and rejects with ITS OWN error —
    // the real shape this environment produces for a missing optional peer.
    expect(
      classifySdkPresence({
        message: `Could not resolve "${SDK_MODULE_SPECIFIER}" imported by "@camerontaylor/cq-toolkit".`,
      }),
    ).toBe('absent');
  });

  test('ERR_MODULE_NOT_FOUND naming any OTHER specifier → broken (a missing transitive dependency)', () => {
    expect(
      classifySdkPresence({
        code: 'ERR_MODULE_NOT_FOUND',
        message:
          "Cannot find package 'some-transitive-dep' imported from node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js",
      }),
    ).toBe('broken');
  });

  test('any other rejection shape → broken (module-init failure, incompatible runtime, junk)', () => {
    expect(classifySdkPresence({ code: 'ERR_INCOMPATIBLE' })).toBe('broken');
    expect(
      classifySdkPresence(new Error('SyntaxError: classes may extend only a class or a function')),
    ).toBe('broken');
    expect(classifySdkPresence(undefined)).toBe('broken');
    expect(classifySdkPresence('boom')).toBe('broken');
  });
});
