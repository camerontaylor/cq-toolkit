// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory; the shared fixtures and helpers
// live here. The moved bodies are byte-identical apart from the `export`
// keywords, relative import paths and this module boundary.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';

export async function withScratch(body: (scratchDir: string) => Promise<void>): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  try {
    await body(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** Harness config whose run allowlist is exactly `patterns`. */
export function runConfig(commandPatterns: string[]) {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: { enabled: true, commandPatterns, timeoutMs: 5_000, maxOutputChars: 10_000 },
    },
  };
}

/** Poll `probe` until it returns a value (not undefined) or `timeoutMs` passes. */
async function pollFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('pollFor: timed out');
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

/** The pid written to `file`, once it exists and holds a full line. */
export async function readPid(file: string): Promise<number> {
  return pollFor(async () => {
    const text = await readFile(file, 'utf8').catch(() => '');
    return text.endsWith('\n') ? Number(text.trim()) : undefined;
  });
}

/** True while `pid` is a live process. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Resolves once `pid` is gone; rejects after ~2 s. */
export async function expectDead(pid: number): Promise<void> {
  await pollFor(async () => (alive(pid) ? undefined : true), 2_000);
}

/** A run-only config: the given patterns, timeout and cap. */
export function runOnly(
  commandPatterns: string[],
  timeoutMs = 5_000,
  maxOutputChars = 10_000,
): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: { enabled: true, commandPatterns, timeoutMs, maxOutputChars },
    },
  };
}

/** The default tools, built ONCE so the prior-read ledger is shared. */
export function defaultTools(workspace: string) {
  const tools = buildTools(defaultHarnessConfig, workspace);
  const byName = (name: 'read' | 'edit' | 'write' | 'bash') => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing ${name}`);
    return tool;
  };
  return {
    read: byName('read'),
    edit: byName('edit'),
    write: byName('write'),
    bash: byName('bash'),
  };
}
