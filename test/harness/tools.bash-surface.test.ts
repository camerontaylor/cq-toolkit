// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the F1 bash-surface cases (run alias +
// timeout, maxTools shedding) and the top-level default-cwd containment case.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { runConfig, withScratch } from './tools.helpers.js';

describe('F1 bash tool', () => {
  test('the run alias is advertised for one release and the timeout can only shorten the policy', async () => {
    await withScratch(async (scratchDir) => {
      const bash = buildTools(runConfig(['sleep']), scratchDir).find(
        (candidate) => candidate.name === 'bash',
      );
      expect(bash?.aliases).toEqual(['run']);
      const started = Date.now();
      const result = await bash?.execute({ command: 'sleep 5', timeout: 50 });
      expect(result).toMatchObject({ ok: true, killed: true, exitCode: null });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  test('maxTools: 3 keeps the pre-F1 read/edit/bash surface (write is shed first)', async () => {
    await withScratch(async (scratchDir) => {
      const config: HarnessConfig = {
        ...defaultHarnessConfig,
        promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 3 },
      };
      expect(buildTools(config, scratchDir).map((tool) => tool.name)).toEqual([
        'read',
        'edit',
        'bash',
      ]);
    });
  });
});

test('bash defaults to the configured nested cwd and still enforces containment and exact commands', async () => {
  await withScratch(async (scratchDir) => {
    await mkdir(join(scratchDir, 'nested'));
    await writeFile(join(scratchDir, 'marker'), 'printf root');
    await writeFile(join(scratchDir, 'nested', 'marker'), 'printf nested');
    const config = runConfig(['re:^\\. \\./marker$']);
    const command = '. ./marker';
    const tools = buildTools(
      {
        ...config,
        tools: { ...config.tools, bash: { ...config.tools.bash, defaultCwd: 'nested' } },
      },
      scratchDir,
    );
    const bash = tools.find((tool) => tool.name === 'bash');
    const result = await bash?.execute({ command });
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.output).toContain('--- stdout ---\nnested');
    expect((await bash?.execute({ command: 'echo other' }))?.ok).toBe(false);
    const escaped = buildTools(
      {
        ...config,
        tools: { ...config.tools, bash: { ...config.tools.bash, defaultCwd: '../outside' } },
      },
      scratchDir,
    ).find((tool) => tool.name === 'bash');
    expect((await escaped?.execute({ command }))?.ok).toBe(false);
  });
});
