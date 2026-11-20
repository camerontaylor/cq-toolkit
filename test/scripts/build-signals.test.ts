// scripts/build.mjs must forward every terminating signal to its active child,
// so a SIGHUP to the wrapper cannot leave tsc writing dist after the wrapper exits.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('scripts/build.mjs signal forwarding', () => {
  test('forwards SIGINT, SIGTERM and SIGHUP to the child', () => {
    const source = readFileSync('scripts/build.mjs', 'utf8');
    const match =
      /for \(const signal of \[([^\]]*)\]\)\s*process\.once\(signal, \(\) => child\.kill\(signal\)\)/.exec(
        source,
      );
    expect(match).not.toBeNull();
    const signals = [...match![1]!.matchAll(/'(SIG[A-Z]+)'/g)].map((m) => m[1]);
    expect(signals).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGHUP']));
  });
});
