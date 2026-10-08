import { describe, expect, it } from 'vitest';

import { distPrepared, scrubbedBuildEnv } from './global-setup.js';

describe('scrubbedBuildEnv', () => {
  it('drops credential-bearing variables and keeps the rest', () => {
    const env = scrubbedBuildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GH_TOKEN: 'a',
      ANTHROPIC_API_KEY: 'b',
      OPENAI_API_KEY: 'c',
      NPM_CONFIG__AUTH: 'd',
      AWS_SECRET_ACCESS_KEY: 'e',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
  });
});

describe('distPrepared', () => {
  it('skips the build only for CQ_DIST_PREPARED exactly 1', () => {
    expect(distPrepared({ CQ_DIST_PREPARED: '1' })).toBe(true);
    expect(distPrepared({})).toBe(false);
    for (const value of ['0', '', 'true', ' 1', '1 ', 'yes']) {
      expect(distPrepared({ CQ_DIST_PREPARED: value })).toBe(false);
    }
  });
});
