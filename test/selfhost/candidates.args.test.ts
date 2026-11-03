// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the entry-argument-parser subject. It needs no shared
// fixtures.
import { describe, expect, test } from 'vitest';
import { parseSelfhostArgs } from '../../src/selfhost/config.js';

// ---------------------------------------------------------------------------
// parseSelfhostArgs
// ---------------------------------------------------------------------------

describe('parseSelfhostArgs', () => {
  test('happy path: every override is honored; empty argv means dryRun false only', () => {
    expect(parseSelfhostArgs(['--max-usd', '2', '--journal-root', '/tmp/j', '--dry-run'])).toEqual({
      maxUsd: 2,
      journalRoot: '/tmp/j',
      dryRun: true,
    });
    expect(parseSelfhostArgs([])).toEqual({ dryRun: false });
    expect(parseSelfhostArgs(['--max-usd', '0']).maxUsd).toBe(0); // zero is a legal cap
    expect(parseSelfhostArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  test('unknown flags and bare arguments throw with usage', () => {
    expect(() => parseSelfhostArgs(['--wat'])).toThrow(/unknown argument "--wat".*usage:/s);
    expect(() => parseSelfhostArgs(['stray-positional'])).toThrow(/usage:/);
    expect(() => parseSelfhostArgs(['--max-usd'])).toThrow(/requires a value/);
    expect(() => parseSelfhostArgs(['--journal-root', ''])).toThrow(/non-empty/);
  });

  test('--max-usd rejects negative and non-finite values fail-loud', () => {
    expect(() => parseSelfhostArgs(['--max-usd', '-1'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'abc'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'Infinity'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'NaN'])).toThrow(/finite number >= 0/);
  });

  test('slice 2 flags: --repo validates the owner/name shape; --responder-login is an optional string', () => {
    expect(parseSelfhostArgs(['--repo', 'octo/widget', '--responder-login', 'cq-bot'])).toEqual({
      repo: 'octo/widget',
      responderLogin: 'cq-bot',
      dryRun: false,
    });
    // Absent → undefined (the entry falls back to GH_REPOSITORY / null).
    const bare = parseSelfhostArgs([]);
    expect(bare.repo).toBeUndefined();
    expect(bare.responderLogin).toBeUndefined();
    // Malformed repository specs throw with usage.
    expect(() => parseSelfhostArgs(['--repo', 'octo'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', 'octo/widget/extra'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', '/widget'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', 'octo/'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', ''])).toThrow(/non-empty/);
    expect(() => parseSelfhostArgs(['--responder-login'])).toThrow(/requires a value/);
  });
});
