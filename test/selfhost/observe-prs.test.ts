import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
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
    const workflow = readFileSync('policy/templates/observe-prs.yml', 'utf8');
    const [wake = '', observer = ''] = workflow.split('  observe:');
    expect(wake).toContain('actions: write');
    expect(wake).not.toContain('secrets.');
    expect(wake).not.toContain('actions/checkout');
    expect(observer).toContain("github.event_name != 'pull_request_target'");
    expect(observer).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(observer).toContain('environment: automation');
    expect(observer).toContain('permission-pull-requests: read');
    expect(observer).not.toContain('pull_request.head');
  });
});
