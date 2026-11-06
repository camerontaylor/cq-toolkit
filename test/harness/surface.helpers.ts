// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus this shared fixture module.
// Shared fixtures for the harness tool-surface tests — no tests and no
// `describe` blocks live here.
import { rmSync } from 'node:fs';
import { realTmpDirSync } from '../helpers/tmp-dir.js';
import { onTestFinished } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { HarnessManifestSchema } from '../../src/harness/surface.js';
import type { HarnessManifest } from '../../src/harness/surface.js';

/** A realpath'd scratch workspace (macOS /var → /private/var), removed after the test. */
export function scratch(): string {
  const dir = realTmpDirSync('harness-surface-');
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The default harness config with the given bash allowlist. */
export function withRun(commandPatterns: string[], timeoutMs = 5_000): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: { enabled: true, commandPatterns, timeoutMs, maxOutputChars: 10_000 },
    },
  };
}

/** A strictly-parsed manifest over `workspace`. */
export function manifest(workspace: string, over: Partial<HarnessManifest> = {}): HarnessManifest {
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: 'workspace-write',
    tools: ['read', 'edit', 'bash'],
    harness: withRun(['echo', 'sleep']),
    envNames: [],
    ...over,
  });
}
