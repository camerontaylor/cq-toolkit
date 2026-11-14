import { describe, expect, it } from 'vitest';
import {
  openPrDiscoveryEffects,
  type OpenPrRepository,
} from '../../../src/adapters/crq/openPrDiscoverySource.js';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const repo: OpenPrRepository = {
  repo: 'o/r',
  name: 'r',
  clone: '/fake',
  defaultBranch: 'main',
  primary: false,
  enabled: true,
  branches: ['main'],
};
describe('open PR discovery source', () => {
  it('uses bounded forge listing and checks commit after fetching a PR ref', async () => {
    const calls: string[][] = [];
    let probes = 0;
    const effects = openPrDiscoveryEffects({
      repos: [repo],
      associate: async (queue) => ({ queue, associated: false }),
      ownRange: async () => false,
      event: async () => {},
      gh: async (args) => {
        calls.push(args);
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify([
            {
              number: 7,
              isDraft: false,
              baseRefName: 'main',
              headRefName: 'feature',
              headRefOid: head,
            },
          ]),
        };
      },
      git: () => async (args) => {
        calls.push([...args]);
        const code = args[0] === 'cat-file' && probes++ === 0 ? 1 : 0;
        return {
          args,
          code,
          stdout: new TextEncoder().encode(args[0] === 'merge-base' ? base : ''),
          stderr: '',
        };
      },
    });
    const prs = await effects.list(repo);
    await effects.fetchDefault(repo);
    expect(await effects.rangeBase(repo, prs[0]!)).toBe(base);
    expect(calls[0]).toContain('200');
    expect(calls).toContainEqual([
      'fetch',
      '--quiet',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    expect(calls).toContainEqual([
      'fetch',
      '--quiet',
      'origin',
      '+refs/pull/7/head:refs/remotes/pr/7',
    ]);
    expect(calls).toContainEqual(['merge-base', 'origin/main', head]);
  });
  it('refuses malformed inventory and unconfigured repository objects', async () => {
    const effects = openPrDiscoveryEffects({
      repos: [repo],
      associate: async (queue) => ({ queue, associated: false }),
      ownRange: async () => false,
      event: async () => {},
      gh: async () => ({ code: 0, stdout: '[{"number":7}]', stderr: '' }),
    });
    await expect(effects.list(repo)).rejects.toThrow('invalid PR inventory');
    await expect(effects.list({ ...repo })).rejects.toThrow('invalid PR repository');
  });
});
