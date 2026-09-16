// Slice D + F — tests for the #30 selective credential gate in the
// demo-eval-axes workflow. Two describes:
//   1. MODULE-LEVEL (no skipIf): direct unit tests over the extracted pure
//      module scripts/lib/eval-axes-select.mjs — these run EVERYWHERE,
//      including CI (no dist, no network, no keys needed).
//   2. SPAWN E2E (skipIf dist missing): proves the real script wiring
//      end-to-end where dist exists (e.g. after a local build); CI covers
//      the module-level describe above and SKIPS these — the script imports
//      ../dist/index.js at module top and CI runs tests before build.
//
// Every case is spend-free: each refusal happens BEFORE any dispatch. The
// e2e cases' dummy key (ZAI_API_KEY='x') is never used — the credential
// gate refuses before makeDriver, so no provider, network, or paid call is
// ever reached.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The module is deliberately plain JS with no type declarations (standalone
// script infrastructure; allowJs is off repo-wide), so TS7016 is expected
// here and suppressed — the function shapes are pinned by the tests below.
// prettier-ignore
// @ts-expect-error TS7016: no declaration file for the plain-JS module
import { EVAL_AXES_PROVIDER_KEYS, requiredKeys, selectCells } from '../../scripts/lib/eval-axes-select.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The key vars the demo routes on (plus the stale host key the script
// neutralizes internally) — scrubbed so a login-shell export on the dev
// machine can never quietly satisfy a case that must run key-less.
const KEY_VARS = [
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

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

// Mirror of the script's cell table (same lane/provider/model quadruple).
const CELLS = [
  { lane: 'ai-sdk', provider: 'zai', model: 'glm-4.6' },
  { lane: 'ai-sdk', provider: 'deepseek', model: 'deepseek-chat' },
  { lane: 'claude-agent', provider: 'zai', model: 'glm-4.6' },
  { lane: 'subprocess', provider: 'zai', model: 'glm-4.6' },
];

describe('eval-axes-select module: --only selection and the credential gate (pure, dist-free)', () => {
  it('selectCells returns all 4 cells with no --only', () => {
    expect(selectCells(CELLS, ['node', 'scripts/demo-eval-axes.mjs'])).toEqual(CELLS);
  });

  it('selectCells filters by substring', () => {
    expect(selectCells(CELLS, ['node', 'x', '--only', 'glm-4.6'])).toHaveLength(3);
    expect(selectCells(CELLS, ['node', 'x', '--only', 'deepseek'])).toHaveLength(1);
  });

  it('selectCells throws the usage message on a missing value and on a no-match', () => {
    expect(() => selectCells(CELLS, ['node', 'x', '--only'])).toThrow('--only requires a value');
    expect(() => selectCells(CELLS, ['node', 'x', '--only', 'bogus'])).toThrow(
      "no cell matches 'bogus'",
    );
    expect(() => selectCells(CELLS, ['node', 'x', '--only', 'bogus'])).toThrow('valid cells:');
  });

  it('requiredKeys: a zai-only selection with ZAI_API_KEY set needs nothing', () => {
    const selected = selectCells(CELLS, ['node', 'x', '--only', 'glm-4.6']);
    expect(requiredKeys(selected, EVAL_AXES_PROVIDER_KEYS, { ZAI_API_KEY: 'x' })).toEqual({
      missing: [],
      unmapped: null,
    });
  });

  it('requiredKeys: a deepseek selection without DEEPSEEK_API_KEY demands exactly it', () => {
    const selected = selectCells(CELLS, ['node', 'x', '--only', 'deepseek']);
    expect(requiredKeys(selected, EVAL_AXES_PROVIDER_KEYS, {})).toEqual({
      missing: ['DEEPSEEK_API_KEY'],
      unmapped: null,
    });
  });

  it('requiredKeys: nothing set + a zai selection demands ZAI_API_KEY', () => {
    const selected = selectCells(CELLS, ['node', 'x', '--only', 'glm-4.6']);
    expect(requiredKeys(selected, EVAL_AXES_PROVIDER_KEYS, {})).toEqual({
      missing: ['ZAI_API_KEY'],
      unmapped: null,
    });
  });

  it('requiredKeys: an unmapped provider is named (first offender)', () => {
    const selected = [{ lane: 'ai-sdk', provider: 'acme', model: 'acme-model' }];
    const { missing, unmapped } = requiredKeys(selected, EVAL_AXES_PROVIDER_KEYS, {});
    expect(missing).toEqual([]);
    expect(unmapped).toBe('acme');
  });
});

describe.skipIf(!existsSync(join(ROOT, 'dist', 'index.js')))(
  'demo-eval-axes: the #30 selective credential gate (spawn e2e)',
  () => {
    // CI covers the module-level describe above and SKIPS these: the script
    // imports ../dist/index.js at module top and CI runs tests before build.

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
      const res = runDemo(['--only', 'deepseek-flash'], { ZAI_API_KEY: 'x' });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(1);
      expect(res.stderr).toContain('DEEPSEEK_API_KEY');
    });
  },
);
