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

  it('drops connection-string variables and any value embedding URL credentials', () => {
    const env = scrubbedBuildEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/app',
      REDIS_URL: 'redis://:s3cret@cache.internal:6379',
      DB_URL: 'mysql://root@localhost/app',
      SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/2',
      // A neutral name carrying userinfo-with-password is still scrubbed by value.
      UPSTREAM: 'https://user:pw@example.com/path',
      // Credential-free URLs and non-URL values stay.
      HOMEPAGE: 'https://example.com/a@b',
      CI: 'true',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOMEPAGE: 'https://example.com/a@b', CI: 'true' });
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
