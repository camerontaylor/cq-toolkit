import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filePushDiscoveryEffects,
  type PushRepository,
} from '../../../src/adapters/crq/pushDiscoverySource.js';
import { runPushDiscovery } from '../../../src/queue-runner/pushDiscovery.js';

const tip = 'b'.repeat(40);
const repo: PushRepository = {
  repo: 'o/r',
  name: 'r',
  clone: '/fake/clone',
  defaultBranch: 'main',
  enabled: true,
  floor: '2025-01-01',
  quietMinutes: 10,
};
describe('push discovery source', () => {
  it('uses forced tracking fetch and first-parent floor, then durably writes the queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crq-push-'));
    await writeFile(join(dir, 'queue.json'), '{"items":[],"unknown":1.5}\n');
    const calls: string[][] = [];
    const effects = filePushDiscoveryEffects({
      stateRoot: dir,
      repos: [repo],
      event: async () => {},
      git: () => async (args) => {
        calls.push([...args]);
        return {
          args,
          code: 0,
          stdout: new TextEncoder().encode(args[0] === 'rev-parse' ? tip : ''),
          stderr: '',
        };
      },
    });
    await runPushDiscovery([repo], false, 'primary/repo', effects);
    expect(calls[0]).toEqual(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(calls[2]).toEqual([
      'rev-list',
      '--first-parent',
      '-1',
      '--before=2025-01-01',
      'refs/remotes/origin/main',
    ]);
    expect(await readFile(join(dir, 'queue.json'), 'utf8')).toContain(tip);
    expect(await readFile(join(dir, 'queue.json'), 'utf8')).toContain('1.5');
  });
  it('does not interpret git failure as divergence and refuses nonregistry repos', async () => {
    const effects = filePushDiscoveryEffects({
      stateRoot: '/unused',
      repos: [repo],
      event: async () => {},
      git: () => async (args) => ({ args, code: 128, stdout: new Uint8Array(), stderr: 'error' }),
    });
    await expect(effects.isAncestor(repo, 'a'.repeat(40), tip)).rejects.toThrow(
      'ancestry unavailable',
    );
    await expect(effects.fetchTip({ ...repo })).rejects.toThrow('invalid push repository');
  });
});
