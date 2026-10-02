import { describe, expect, test, vi, beforeEach } from 'vitest';

import type { SandboxBackendAdapter } from '../../src/sandbox/backend.js';
import { probeBackend } from '../../src/sandbox/probe.js';

const fs = vi.hoisted(() => ({
  chmod: vi.fn<(path: string, mode: number) => Promise<void>>(),
  mkdtemp: vi.fn<(prefix: string) => Promise<string>>(),
  rm: vi.fn<(path: string, options: { recursive: boolean; force: boolean }) => Promise<void>>(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fs,
}));

const adapter: SandboxBackendAdapter = {
  backend: 'bwrap',
  available: async () => ({ available: true }),
  workspaceParent: () => '/scratch',
  launch: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  fs.rm.mockResolvedValue(undefined);
  fs.chmod.mockResolvedValue(undefined);
});

describe('scratch setup failure settlement', () => {
  test('workspace setup failure removes the already allocated root', async () => {
    fs.mkdtemp.mockResolvedValueOnce('/root').mockRejectedValueOnce(new Error('workspace setup'));
    await expect(probeBackend(adapter)).rejects.toThrow('workspace setup');
    expect(fs.rm.mock.calls).toEqual([['/root', { recursive: true, force: true }]]);
    expect(adapter.launch).not.toHaveBeenCalled();
  });

  test('sibling setup failure removes both prior allocations', async () => {
    fs.mkdtemp
      .mockResolvedValueOnce('/root')
      .mockResolvedValueOnce('/workspace')
      .mockRejectedValueOnce(new Error('sibling setup'));
    await expect(probeBackend(adapter)).rejects.toThrow('sibling setup');
    expect(fs.rm.mock.calls.map(([path]) => path)).toEqual(['/root', '/workspace']);
    expect(adapter.launch).not.toHaveBeenCalled();
  });

  test('one cleanup error does not prevent removing the other allocation', async () => {
    fs.mkdtemp
      .mockResolvedValueOnce('/root')
      .mockResolvedValueOnce('/workspace')
      .mockRejectedValueOnce(new Error('sibling setup'));
    fs.rm.mockRejectedValueOnce(new Error('root cleanup'));
    await expect(probeBackend(adapter)).rejects.toThrow('sandbox scratch cleanup failed');
    expect(fs.rm.mock.calls.map(([path]) => path)).toEqual(['/root', '/workspace']);
  });
});
