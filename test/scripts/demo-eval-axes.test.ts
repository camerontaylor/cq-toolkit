// Slice D — spawn-based tests for the #30 selective credential gate in
// scripts/demo-eval-axes.mjs: `--only` may select cells that never contact
// every provider, so only the providers the SELECTED cells actually touch
// are required. The old unconditional check demanded DEEPSEEK_API_KEY even
// for a zai-only run; the discriminator below pins the new behavior.
//
// Standalone-by-design: the demo script imports ../dist/index.js at module
// top, and CI runs tests BEFORE build — so this whole describe runs only
// where dist exists (e.g. after a local build); CI skips rather than
// failing on the missing module.
//
// Every case is spend-free: each refusal happens BEFORE any dispatch.
// Case 3's dummy key (ZAI_API_KEY='x') is never used — the credential gate
// refuses before makeDriver, so no provider, network, or paid call is ever
// reached.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The key vars the demo routes on (plus the stale host key the script
// neutralizes internally) — scrubbed so a login-shell export on the dev
// machine can never quietly satisfy a case that must run key-less.
const KEY_VARS = ['ZAI_API_KEY', 'Z_AI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function envFor(keys: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of KEY_VARS) delete env[k];
  for (const [k, v] of Object.entries(keys)) env[k] = v;
  return env;
}

function runDemo(args: string[], keys: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['scripts/demo-eval-axes.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: envFor(keys),
  });
}

describe.skipIf(!existsSync(join(ROOT, 'dist', 'index.js')))('demo-eval-axes: the #30 selective credential gate', () => {
  it('usage guard: --only without a value exits 1 listing the valid cells', () => {
    const res = runDemo(['--only']);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(1);
    expect(res.stderr).toContain('valid cells:');
  });

  it('#30 discriminator: a zai-only selection demands only ZAI_API_KEY, never DEEPSEEK_API_KEY', () => {
    // No keys in env at all: the OLD unconditional gate listed BOTH key vars
    // here; the selective gate must name ZAI_API_KEY only (the glm cells
    // never contact DeepSeek).
    const res = runDemo(['--only', 'glm-4.6']);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(1);
    expect(res.stderr).toContain('missing key env var(s) for the selected cells: ZAI_API_KEY');
    expect(res.stderr).not.toContain('DEEPSEEK_API_KEY');
  });

  it('a selected deepseek cell still demands DEEPSEEK_API_KEY (refusal precedes any dispatch)', () => {
    // ZAI_API_KEY='x' is never used: the credential gate refuses before
    // makeDriver — the selected deepseek cells are never constructed, no
    // network is touched, no paid call is made.
    const res = runDemo(['--only', 'deepseek-chat'], { ZAI_API_KEY: 'x' });
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(1);
    expect(res.stderr).toContain('DEEPSEEK_API_KEY');
  });
});
