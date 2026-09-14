// Slice C — sandbox e2e for ratchet-typecheck --update's baseline guard:
// thresholds only tighten, so --update must refuse to RAISE the count past
// the current baseline (a 0 -> 1 "update" is a regression, not a ratchet
// turn), while lowering (tightening) and first-time creation still work.
//
// The sandbox is a minimal throwaway repo OUTSIDE this repo: a copy of
// scripts/ratchet-typecheck.mjs, a tsconfig whose only input is a bad.ts
// carrying exactly one type error, and a node_modules whose .bin/tsc6 is a
// STUB — a fixed-output compiler stand-in emitting exactly one parsable
// `error TS2322:` line and exiting 1. The script derives its own ROOT from
// its location, so the sandbox isolates the baseline while the stub keeps
// the run deterministic and free of real-compiler load (a parallel vitest
// worker's time-sensitive tests must not eat a tsc cold start). The spawn →
// parse → count → baseline-compare path exercised is the script's real one.
// POSIX only: the script's win32 branch wants a .cmd shim; CI is linux.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let sandbox: string | undefined;

// bad.ts carries EXACTLY one type error: strict mode + the assignment of a
// string literal to a number -> one `error TS2322` line, so the ratchet
// counts 1 on every sandbox run (the stub below emits the matching line).
function makeSandbox(): string {
  const sbx = mkdtempSync(join(tmpdir(), 'ratchet-sandbox-'));
  mkdirSync(join(sbx, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/ratchet-typecheck.mjs'), join(sbx, 'scripts/ratchet-typecheck.mjs'));
  mkdirSync(join(sbx, 'baselines'), { recursive: true });
  writeFileSync(
    join(sbx, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ['bad.ts'] })}\n`,
  );
  writeFileSync(join(sbx, 'bad.ts'), `const n: number = 'not a number';\n`);
  // The stub toolchain: TSC_BIN is <sandbox>/node_modules/.bin/tsc6; it must
  // behave like an errored-but-parsable tsc run (one `error TS\d+:` line,
  // exit 1) or the script's I5 guard would fail before the baseline logic.
  mkdirSync(join(sbx, 'node_modules', '.bin'), { recursive: true });
  const stub = join(sbx, 'node_modules', '.bin', 'tsc6');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "bad.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'. (stubbed toolchain)"\nexit 1\n`,
  );
  chmodSync(stub, 0o755);
  return sbx;
}

function runUpdate(sbx: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs', '--update'], { cwd: sbx, encoding: 'utf8' });
}

function baselineOf(sbx: string): { count: number } {
  return JSON.parse(readFileSync(join(sbx, 'baselines/typecheck.json'), 'utf8')) as { count: number };
}

function outputOf(res: SpawnSyncReturns<string>): string {
  return `${res.stdout}${res.stderr}`;
}

describe('ratchet-typecheck --update: the baseline can only tighten', () => {
  afterEach(() => {
    if (sandbox !== undefined) {
      rmSync(sandbox, { recursive: true, force: true });
      sandbox = undefined;
    }
  });

  it('refuses to raise the baseline', { timeout: 30_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    writeFileSync(join(sbx, 'baselines/typecheck.json'), '{"count": 0}\n');
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(1);
    expect(outputOf(res)).toContain('refuses to raise the baseline');
    expect(baselineOf(sbx), 'the baseline must survive a refused raise untouched').toEqual({ count: 0 });
  });

  it('allows tightening', { timeout: 30_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    writeFileSync(join(sbx, 'baselines/typecheck.json'), '{"count": 2}\n');
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(0);
    expect(baselineOf(sbx)).toEqual({ count: 1 });
  });

  it('creates a missing baseline', { timeout: 30_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(0);
    expect(baselineOf(sbx)).toEqual({ count: 1 });
  });
});
