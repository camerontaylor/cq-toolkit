import { describe, expect, it } from 'vitest';

import { scrubbedBuildEnv } from './global-setup.js';

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
