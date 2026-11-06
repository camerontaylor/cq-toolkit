// C3a: the CLI reads the CQ_* environment once, before dispatch. Errors list
// together and exit 2; warnings print once on stderr; --json keeps stdout one
// JSON artifact.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import { capture, opsRoot } from './i1-helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const warningLines = (err: string): string[] =>
  err.split('\n').filter((line) => line.startsWith('cq: warning:'));

describe('CLI env entry', () => {
  test('a misspelled CQ_SANDBOX keeps the sandbox required and warns exactly once', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(0);
    const warnings = warningLines(run.err);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CQ_SANDBOX');
    const cqEnv = readCqEnv({ CQ_SANBOX: 'off' });
    expect(resolveSandboxConfig({ cqEnv }).mode).toBe('required');
  });

  test('two invalid values exit 2 and list both errors before dispatch', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(2);
    expect(run.out).toBe('');
    const errors = run.err.split('\n').filter((line) => line.startsWith('cq: error:'));
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('CQ_SANDBOX');
    expect(errors.join('\n')).toContain('CQ_RUN_TOOL');
  });

  test('--json: invalid values give one JSON error artifact and exit 2', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    const run = await capture(['echo', '--msg=hi', '--json'], { opsRoot });
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.out) as { error: { message: string; exitCode: number } };
    expect(parsed.error.exitCode).toBe(2);
    expect(parsed.error.message).toContain('CQ_SANDBOX');
    expect(parsed.error.message).toContain('CQ_RUN_TOOL');
  });

  test('--json: warnings go to stderr and stdout stays valid JSON', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const run = await capture(['echo', '--msg=hi', '--json'], { opsRoot });
    expect(run.code).toBe(0);
    expect((JSON.parse(run.out) as { status: string }).status).toBe('ok');
    expect(warningLines(run.err)).toHaveLength(1);
  });

  test('identity names never warn', async () => {
    for (const name of ['CQ_WORK_ID', 'CQ_ROLE', 'CQ_TASK', 'CQ_RUN_ID', 'CQ_PARENT_WORK_ID']) {
      vi.stubEnv(name, 'x');
    }
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(0);
    expect(warningLines(run.err)).toEqual([]);
  });
});
