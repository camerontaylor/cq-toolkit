// Slice C — sandbox e2e for ratchet-typecheck --update's baseline guard:
// thresholds only tighten, so --update must refuse to RAISE the count past
// the current baseline (a 0 -> 1 "update" is a regression, not a ratchet
// turn), while lowering (tightening) and first-time creation still work.
//
// The sandbox is a minimal throwaway repo OUTSIDE this repo: a copy of
// scripts/ratchet-typecheck.mjs, a tsconfig whose only input is a bad.ts
// carrying exactly one type error, and a node_modules symlink back into the
// real repo so the pinned tsc6 bin resolves. The script derives its own ROOT
// from its location, so the sandbox isolates the baseline and the compiled
// tree while sharing only the toolchain.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let sandbox: string | undefined;

// bad.ts carries EXACTLY one type error: strict mode + the assignment of a
// string literal to a number -> one `error TS2322` line, so the ratchet
// counts 1 on every sandbox run (deterministic across tsc cold starts).
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
  symlinkSync(join(ROOT, 'node_modules'), join(sbx, 'node_modules'), 'dir');
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

  it('refuses to raise the baseline', { timeout: 120_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    writeFileSync(join(sbx, 'baselines/typecheck.json'), '{"count": 0}\n');
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(1);
    expect(outputOf(res)).toContain('refuses to raise the baseline');
    expect(baselineOf(sbx), 'the baseline must survive a refused raise untouched').toEqual({ count: 0 });
  });

  it('allows tightening', { timeout: 120_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    writeFileSync(join(sbx, 'baselines/typecheck.json'), '{"count": 2}\n');
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(0);
    expect(baselineOf(sbx)).toEqual({ count: 1 });
  });

  it('creates a missing baseline', { timeout: 120_000 }, () => {
    const sbx = makeSandbox();
    sandbox = sbx;
    const res = runUpdate(sbx);
    expect(res.status, outputOf(res)).toBe(0);
    expect(baselineOf(sbx)).toEqual({ count: 1 });
  });
});
