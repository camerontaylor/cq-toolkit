import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('scripts/build.mjs signal forwarding', () => {
  it('forwards SIGINT, SIGTERM and SIGHUP to the active child', () => {
    const source = readFileSync(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');
    const match = /for \(const signal of \[([^\]]*)\]\)/.exec(source);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain("'SIGHUP'");
    expect(match?.[1]).toContain("'SIGINT'");
    expect(match?.[1]).toContain("'SIGTERM'");
  });
});
