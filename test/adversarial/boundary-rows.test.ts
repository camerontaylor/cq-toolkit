import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { selectToolNames } from '../../src/harness/surface.js';
import { buildSandboxLauncherEnv, harnessRunGate } from '../../src/sandbox/index.js';
import { isProtectedPolicyPath } from '../../src/ops/gates/protectedPaths.js';

describe('§7 worker and protected-path attacks', () => {
  test('A5 ratchet target rename and extra baseline cannot escape human review', () => {
    for (const path of [
      'policy/templates/ratchet.yml',
      '.github/workflows/ratchet.yml',
      'baselines/ratchets.json',
      'baselines/new-target--typecheck--0123456789ab.json',
    ]) {
      expect(isProtectedPolicyPath(path), path).toBe(true);
    }
  });

  test('A6 coverage exclusions change protected measurement configuration', () => {
    for (const path of ['vitest.config.ts', 'package.json', 'policy/templates/ci.yml']) {
      expect(isProtectedPolicyPath(path), path).toBe(true);
    }
  });

  test('A10 mode none with adversarial Read and Bash requests exposes no harness tool', () => {
    const requested = ['read', 'run', 'Bash'] as const;
    expect(selectToolNames(requested, { mode: 'none', allow: [...requested] })).toEqual([]);
  });

  test('A11/A17 a run child cannot inherit ambient runner or promote credentials', () => {
    const child = buildSandboxLauncherEnv(
      {
        PATH: '/usr/bin',
        GH_TOKEN: 'runner-secret',
        GITHUB_TOKEN: 'runner-secret',
        CQ_PROMOTE_TOKEN: 'promote-secret',
      },
      { envPassthrough: [] },
    );
    expect(child).toEqual({ PATH: '/usr/bin' });
    expect(harnessRunGate({ env: { CQ_SANDBOX: 'required' } }).enabled).toBe(false);
  });

  test('A14 privileged gate and promotion workflow edits enter the protected path gate', () => {
    const policy = JSON.parse(readFileSync('policy/protected-paths.json', 'utf8')) as {
      protectedPaths: string[];
    };
    expect(
      policy.protectedPaths.some((source) =>
        new RegExp(source).test('src/ops/merge/classifyPrs.ts'),
      ),
    ).toBe(true);
    for (const path of ['policy/templates/cq-policy.yml', '.github/workflows/promote.yml']) {
      expect(isProtectedPolicyPath(path), path).toBe(true);
    }
  });
});
