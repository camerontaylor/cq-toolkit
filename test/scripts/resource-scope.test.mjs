import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
  spawn: mocks.spawn,
}));
import { checkHeadroom, enterResourceScope } from '../../scripts/lib/resource-scope.mjs';

describe('resource scope', () => {
  let signalListeners;
  beforeEach(() => {
    signalListeners = new Map(
      ['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]),
    );
    vi.resetAllMocks();
    vi.stubEnv('CQ_RESOURCE_SCOPED', '');
    vi.stubEnv('NODE_OPTIONS', process.env.NODE_OPTIONS ?? '');
    mocks.readFileSync.mockReturnValue('MemAvailable: 4194304 kB\n');
    mocks.spawnSync.mockReturnValue({ status: 0 });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    vi.spyOn(process, 'exit').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [signal, original] of signalListeners) {
      for (const listener of process.listeners(signal))
        if (!original.includes(listener)) process.removeListener(signal, listener);
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refuses low headroom immediately with the top three memory users', () => {
    if (process.platform !== 'linux') return;
    mocks.readFileSync.mockReturnValue('MemAvailable: 1000 kB\n');
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'PID RSS COMMAND\n1 500 a\n2 400 b\n3 300 c\n4 200 d\n',
    });
    expect(checkHeadroom).toThrow(
      expect.objectContaining({ code: 75, message: expect.stringContaining('3 300 c') }),
    );
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('keeps memory limits when scope OOM adjustment is unsupported', async () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });
    await enterResourceScope('/runner.mjs', ['file.test.ts']);
    const args = mocks.spawn.mock.calls[0][1];
    expect(args).toContain('MemoryMax=3G');
    expect(args).toContain('MemorySwapMax=0');
    expect(args).toContain('CPUWeight=50');
    expect(args).not.toContain('OOMScoreAdjust=500');
    if (process.platform === 'linux')
      expect(mocks.writeFileSync).toHaveBeenCalledWith('/proc/self/oom_score_adj', '500');
  });

  it('runs directly when systemd-run is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({ error: { code: 'ENOENT' } });
    await enterResourceScope('/runner.mjs', []);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and runs directly when installed systemd cannot enforce a scope', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({ status: 1 });
    await enterResourceScope('/runner.mjs', []);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('running uncapped'));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('retains caller Node options while enforcing the heap cap', async () => {
    vi.stubEnv('CQ_RESOURCE_SCOPED', '1');
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings --max-old-space-size=4096');
    mocks.readFileSync.mockReturnValue('MemAvailable: 4194304 kB\n');
    await enterResourceScope('/runner.mjs', []);
    expect(process.env.NODE_OPTIONS).toBe('--trace-warnings --max-old-space-size=2048');
    vi.unstubAllEnvs();
  });

  it('reports the actual signal exit for a killed scoped runner', async () => {
    vi.stubEnv('CQ_RESOURCE_SCOPED', '');
    mocks.readFileSync.mockReturnValue('MemAvailable: 4194304 kB\n');
    mocks.spawnSync.mockReturnValue({ status: 0 });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return child;
    });
    const report = vi.fn();
    expect(await enterResourceScope('/runner.mjs', [], { onSignalExit: report })).toEqual({
      exit: 137,
    });
    expect(report).toHaveBeenCalledWith('SIGKILL', 137);
    vi.unstubAllEnvs();
  });
});
