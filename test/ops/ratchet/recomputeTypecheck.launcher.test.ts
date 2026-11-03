// Split provenance: test/ops/ratchet/recomputeTypecheck.test.ts was split by
// subject into recomputeTypecheck.core.test.ts, recomputeTypecheck.preflight.test.ts,
// recomputeTypecheck.dependency-boundary.test.ts and
// recomputeTypecheck.launcher.test.ts (shared fixtures:
// recomputeTypecheck.helpers.ts).
import { describe, expect, test } from 'vitest';
import { pnpmLauncherKind } from './recomputeTypecheck.helpers.js';

// These synthetic bytes test recognition only; they do not simulate executable
// output or establish which header the failing CI runner actually encountered.
describe('provisioned pnpm launcher recognition', () => {
  const macho = (cpu: number, filetype = 2): Buffer => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpu, 4);
    header.writeUInt32LE(filetype, 12);
    return header;
  };
  test('preserves ELF and Node entrypoint recognition', () => {
    expect(pnpmLauncherKind(Buffer.from('7f454c46', 'hex'), 'linux', 'x64')).toBe('native');
    expect(pnpmLauncherKind(Buffer.from('#!/usr/bin/env node\n'), 'linux', 'x64')).toBe('node');
  });
  test('accepts only supported Darwin thin64LE executable headers for the host CPU', () => {
    expect(pnpmLauncherKind(macho(0x0100000c), 'darwin', 'arm64')).toBe('native');
    expect(pnpmLauncherKind(macho(0x01000007), 'darwin', 'x64')).toBe('native');
  });
  test('rejects unsupported, truncated, wrong-platform/CPU and nonexecutable shapes', () => {
    const rejected: [Buffer, NodeJS.Platform, string][] = [
      [Buffer.alloc(0), 'darwin', 'arm64'],
      [macho(0x0100000c).subarray(0, 31), 'darwin', 'arm64'],
      [macho(0x0100000c), 'linux', 'arm64'],
      [macho(0x0100000c), 'darwin', 'x64'],
      [macho(0x01000007), 'darwin', 'arm64'],
      [macho(0x0100000c), 'darwin', 'ia32'],
      [macho(0x0100000c, 6), 'darwin', 'arm64'],
      [Buffer.from('feedfacf000000000000000000000002', 'hex'), 'darwin', 'arm64'],
      [Buffer.from('cafebabe00000001', 'hex'), 'darwin', 'arm64'],
      [Buffer.from('#!/bin/sh\nexec pnpm "$@"\n'), 'darwin', 'arm64'],
    ];
    for (const [header, platform, arch] of rejected) {
      expect(() => pnpmLauncherKind(header, platform, arch)).toThrow(
        'unsupported provisioned pnpm launcher',
      );
    }
  });
});
