// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the direct-lane-entry refusal (before the dispatch seam and
// before any session store). Shared fixtures live in
// ./strict-token-budget-guard.helpers.ts.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { ClaudeCodeDriver } from '../../src/driver/claude-code/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { invocation, scratch, seamSpy } from './strict-token-budget-guard.helpers.js';

// ---------------------------------------------------------------------------
// 2. Direct lane entry — refuse before the dispatch seam (and before sessions)
// ---------------------------------------------------------------------------

describe('direct lane entry refuses a strict budget before dispatch', () => {
  test('subprocess: config throw, seam untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new ClaudeCodeDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      // SPECIFIC guard phrase + lane: a lane-specific preflight failure
      // (missing route key) can no longer masquerade as this refusal.
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('claude-code');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('claude-agent: config throw, sdkLoader untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new ClaudeCodeDriver({ transport: 'sdk', sdkLoader: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('claude-code');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('acp: config throw, spawn untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new AcpDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('acp');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maxUsd-only is NOT refused by the guard (advisory preserved)', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new ClaudeCodeDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }, { maxUsd: 1 }))
        .catch((e: unknown) => e);
      // The guard is a no-op for a non-strict budget: whatever happens next
      // (here a normal lane pre-dispatch route/env check) is NOT the
      // strict-budget refusal.
      expect(String((err as Error).message)).not.toContain(
        'does not enforce a pre-request token ceiling',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
