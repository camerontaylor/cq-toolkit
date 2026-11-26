import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReviewChildMain } from '../../../src/adapters/crq/reviewChildMain.js';
import { LIVE_UNIT_COMMANDS } from '../../../src/queue-runner/capabilities.js';

async function fixture(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crq-review-main-'));
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  return root;
}

function harness(root: string, argv: string[], code = 0) {
  const errors: string[] = [];
  const calls: unknown[] = [];
  const run = () =>
    runReviewChildMain({
      argv,
      root,
      stateRoot: '/state',
      env: {},
      stderr: (m) => errors.push(m),
      child: async (options) => {
        calls.push(options);
        return code;
      },
    });
  return { errors, calls, run };
}

describe('runReviewChildMain (crq.cmd_review_child)', () => {
  it('passes the run id, timeout and timeout_bin to the child body', async () => {
    const root = await fixture({ review_timeout_min: 45, timeout_bin: '/usr/bin/timeout' });
    const h = harness(root, ['run-1'], 7);
    expect(await h.run()).toBe(7);
    expect(h.calls).toEqual([
      {
        stateRoot: '/state',
        runId: 'run-1',
        timeoutMinutes: 45,
        timeoutBinary: '/usr/bin/timeout',
        env: {},
      },
    ]);
  });

  it('omits timeoutBinary when config has none (Python default "timeout")', async () => {
    const h = harness(await fixture({ review_timeout_min: 5 }), ['r']);
    await h.run();
    expect(h.calls[0]).not.toHaveProperty('timeoutBinary');
  });

  it('exits 2 on a missing or extra argument without reading config', async () => {
    for (const argv of [[], ['a', 'b'], ['']]) {
      const h = harness('/nonexistent', argv);
      expect(await h.run()).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it.each([
    [{}],
    [{ review_timeout_min: 0 }],
    [{ review_timeout_min: '30' }],
    [{ review_timeout_min: 1.5 }],
    [{ review_timeout_min: 5, timeout_bin: '' }],
  ])('exits 1 on invalid config %j', async (config) => {
    const h = harness(await fixture(config), ['r']);
    expect(await h.run()).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it('exits 1 when config.json is unreadable', async () => {
    const h = harness('/nonexistent-crq-root', ['r']);
    expect(await h.run()).toBe(1);
  });

  it('exits 1 and reports when the child body throws', async () => {
    const root = await fixture({ review_timeout_min: 5 });
    const errors: string[] = [];
    const code = await runReviewChildMain({
      argv: ['r'],
      root,
      stateRoot: '/state',
      env: {},
      stderr: (m) => errors.push(m),
      child: async () => {
        throw new Error('boom');
      },
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('boom');
  });
});

describe('_review routing', () => {
  it('is internal: not a live unit command, and tick/slot stay undeclared', () => {
    expect(LIVE_UNIT_COMMANDS).not.toContain('_review');
    expect(LIVE_UNIT_COMMANDS).not.toContain('tick');
    expect(LIVE_UNIT_COMMANDS).not.toContain('slot');
  });

  it('is routed in crq.ts', async () => {
    const source = await readFile(join(process.cwd(), 'src/queue-runner/crq.ts'), 'utf8');
    expect(source).toContain("command === '_review'");
  });
});
