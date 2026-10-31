import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import { lintWorkflow, scanWorkflow } from '../../src/ops/gates/workflowScan.js';
import { observeRepository } from '../../src/selfhost/observe-prs.js';

describe('observation-only runner', () => {
  test('passes the full paginated open set to the durable writer once', async () => {
    const gh = vi.fn<GhFn>().mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([[{ number: 7 }], [{ number: 8 }, { number: 7 }]]),
    });
    const observe = vi.fn().mockResolvedValue({
      observed: [7, 8],
      skipped: [],
      discarded: [],
      write: { ok: true, commit: 'a'.repeat(40) },
    });
    const clock = () => 123;
    const result = await observeRepository(gh, 'octo/repo', clock, observe);
    expect(result.write?.ok).toBe(true);
    expect(gh.mock.calls[0]?.[0]).toContain('--paginate');
    expect(gh.mock.calls[0]?.[0]).toContain('--slurp');
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      { gh, owner: 'octo', repo: 'repo', nowMs: clock },
      [7, 8],
    );
  });

  test.each(['{}', '[{}]', '[[{"number":0}]]', '[[{"number":"7"}]]'])(
    'never prunes or writes from a malformed listing: %s',
    async (stdout) => {
      const gh: GhFn = async () => ({ code: 0, stdout, stderr: '' });
      const observe = vi.fn();
      await expect(observeRepository(gh, 'octo/repo', Date.now, observe)).rejects.toThrow();
      expect(observe).not.toHaveBeenCalled();
    },
  );

  test('a listing failure never reaches the writer', async () => {
    const gh: GhFn = async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' });
    const observe = vi.fn();
    await expect(observeRepository(gh, 'octo/repo', Date.now, observe)).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
  });

  test('workflow isolates PR wakes from the main-only write environment', () => {
    const observer = readFileSync('policy/templates/observe-prs.yml', 'utf8');
    const wake = readFileSync('policy/templates/observe-prs-wake.yml', 'utf8');
    expect(wake).toContain('actions: write');
    expect(wake).toContain('workflows: [cq-signal]');
    expect(wake).toContain('workflow_run:');
    expect(wake).not.toContain('pull_request_target');
    expect(wake).not.toContain('secrets.');
    expect(wake).not.toContain('actions/checkout');
    expect(observer).not.toContain('pull_request_target');
    expect(wake).not.toContain('environment:');
    for (const [name, text] of [
      ['observe-prs.yml', observer],
      ['observe-prs-wake.yml', wake],
    ]) {
      const scan = scanWorkflow(text ?? '');
      expect(scan.ok).toBe(true);
      if (scan.ok) expect(lintWorkflow(`.github/workflows/${name}`, scan)).toEqual([]);
    }
    expect(observer).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(observer).toContain('environment: automation');
    expect(observer).toContain('permission-pull-requests: read');
    expect(observer).not.toContain('pull_request.head');
  });
});
