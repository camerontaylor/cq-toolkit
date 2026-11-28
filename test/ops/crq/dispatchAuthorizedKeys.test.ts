import { describe, expect, it } from 'vitest';
import { checkDispatchAuthorizedKeysLine } from '../../../src/ops/crq/dispatchAuthorizedKeys.js';

// The ceres layout: config.json and state/ under the deploy root, dist/ only
// in the packaged artifact.
const ROOT = '/srv/crq/deploy/apps/crq-python';
const ARTIFACT = '/srv/crq/opt/crq-0123abcd';
const ROOTS = { deployRoot: ROOT, artifactRoot: ARTIFACT };
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample client@host';
const PATH_ENV = 'PATH=/home/q/.local/bin:/usr/bin:/bin';
const line = (command: string, options = 'restrict'): string =>
  `${options},command="${command}" ${KEY}`;
const queueCommand = (extra = '', env = ''): string =>
  `cd ${ROOT} && /usr/bin/env ${PATH_ENV} CRQ_QUEUE_PRINCIPAL=dev CRQ_QUEUE_POLICY=/srv/crq/policy.json ${env}${extra}/usr/bin/node ${ARTIFACT}/dist/queue-runner/crq.js dispatch`;
const authorEnv =
  'CRQ_AUTHOR_REVIEW_POLICY=/srv/crq/author.json CRQ_AUTHOR_FALLBACK_REVIEWER=reviewer CRQ_AUTHOR_TARGET=origin/main';
const authorCommand = `cd ${ROOT} && /usr/bin/env ${PATH_ENV} ${authorEnv} /usr/bin/node ${ARTIFACT}/dist/queue-runner/crq.js dispatch`;

describe('dispatch authorized_keys line check', () => {
  it('accepts the queue identity line', () => {
    const result = checkDispatchAuthorizedKeysLine(line(queueCommand()), ROOTS);
    expect(result).toEqual({ ok: true, identity: 'queue', problems: [] });
  });

  it('accepts the author identity line', () => {
    const result = checkDispatchAuthorizedKeysLine(line(authorCommand), ROOTS);
    expect(result).toEqual({ ok: true, identity: 'author', problems: [] });
  });

  it('accepts valid optional from and expiry-time options', () => {
    const result = checkDispatchAuthorizedKeysLine(
      line(queueCommand(), 'restrict,from="*.example.com",expiry-time="20301231235959Z"'),
      ROOTS,
    );
    expect(result).toEqual({ ok: true, identity: 'queue', problems: [] });
  });

  it.each([
    '20301231Z',
    '203012312359Z',
    '20301231235959Z',
    '20301231',
    '20301231z',
    '20301231UTC',
    '20301231utc',
    '203012312359utc',
    '20301231235960',
    '20301231235961',
    '19700101000001',
    '197001010001Z',
    '19700102',
  ])('accepts expiry-time %s', (value) => {
    const result = checkDispatchAuthorizedKeysLine(
      line(queueCommand(), `restrict,expiry-time="${value}"`),
      ROOTS,
    );
    expect(result).toEqual({ ok: true, identity: 'queue', problems: [] });
  });

  it.each([
    ['missing restrict', `command="${queueCommand()}" ${KEY}`, 'restrict is required'],
    ['permissive option', line(queueCommand(), 'restrict,pty'), 'option not allowed: pty'],
    [
      'environment option',
      line(queueCommand(), 'restrict,environment="X=1"'),
      'option not allowed: environment',
    ],
    [
      'client command used',
      line(queueCommand().replace(' dispatch', ' $SSH_ORIGINAL_COMMAND')),
      'command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)',
    ],
    [
      'old Python dispatcher',
      line(
        queueCommand().replace(/\/usr\/bin\/node.*/, '/usr/bin/python3 x/capability_dispatcher.py'),
      ),
      `script must be ${ARTIFACT}/dist/queue-runner/crq.js`,
    ],
    [
      'queue identity with author settings',
      line(queueCommand(`${authorEnv} `)),
      'a queue identity must not carry CRQ_AUTHOR_* settings (use a separate key)',
    ],
    [
      'extra subcommand',
      line(`${queueCommand()} extra`),
      'the final argument must be exactly "dispatch"',
    ],
    [
      'chained command',
      line(`${queueCommand()}; sh`),
      'command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)',
    ],
    [
      'relative policy',
      line(queueCommand().replace('/srv/crq/policy.json', 'policy.json')),
      'CRQ_QUEUE_POLICY must be an absolute path',
    ],
    [
      'unknown env',
      line(queueCommand('LD_PRELOAD=/x ')),
      'unexpected environment variable LD_PRELOAD',
    ],
    [
      'no cd to the root',
      line(queueCommand().replace(`cd ${ROOT} && `, '')),
      `command must start with "cd ${ROOT} && /usr/bin/env " (the runner reads config.json and state/ from cwd)`,
    ],
    [
      'script under the deploy root (no dist/ there)',
      line(queueCommand().replace(ARTIFACT, ROOT)),
      `script must be ${ARTIFACT}/dist/queue-runner/crq.js`,
    ],
    [
      'background separator in a value',
      line(authorCommand.replace('origin/main', 'origin/main&id')),
      'command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)',
    ],
    [
      'chained && in a value',
      line(authorCommand.replace('origin/main', 'origin/main&&id')),
      'command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)',
    ],
    [
      'chained && after the command',
      line(`${queueCommand()} && sh`),
      'command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)',
    ],
    [
      'single-quoted value the shell keeps as one assignment',
      line(
        queueCommand().replace(
          'CRQ_QUEUE_PRINCIPAL=dev CRQ_QUEUE_POLICY=/srv/crq/policy.json',
          "CRQ_QUEUE_PRINCIPAL='dev CRQ_QUEUE_POLICY=/srv/crq/policy.json'",
        ),
      ),
      'command must not contain quotes or whitespace other than single spaces',
    ],
    [
      'double-quoted value',
      line(queueCommand().replace('CRQ_QUEUE_PRINCIPAL=dev', 'CRQ_QUEUE_PRINCIPAL="dev"')),
      'command must not contain quotes or whitespace other than single spaces',
    ],
    [
      'tab between assignments',
      line(queueCommand().replace(' CRQ_QUEUE_POLICY', '\tCRQ_QUEUE_POLICY')),
      'command must not contain quotes or whitespace other than single spaces',
    ],
    [
      'bad expiry-time value',
      line(queueCommand(), 'restrict,expiry-time="not-a-date"'),
      'expiry-time must be YYYYMMDD[HHMM[SS]] with an optional Z or UTC suffix',
    ],
    ...['forever', '+52w1d', '-1d', '20301232', '20301231Zz', '202012312360'].map((v) => [
      `expiry-time ${v} that OpenSSH rejects`,
      line(queueCommand(), `restrict,expiry-time="${v}"`),
      'expiry-time must be YYYYMMDD[HHMM[SS]] with an optional Z or UTC suffix',
    ]),
    ...[
      '00000101Z',
      '19000229UTC',
      '19691231',
      '19691231235959Z',
      '19700101',
      '197001010000Z',
      '19700101000000',
      '19700101000000utc',
    ].map((v) => [
      `expiry-time ${v} at or before the epoch`,
      line(queueCommand(), `restrict,expiry-time="${v}"`),
      'expiry-time must be after 1970-01-01T00:00:00Z (OpenSSH rejects it)',
    ]),
    [
      'unquoted expiry-time',
      line(queueCommand(), 'restrict,expiry-time=+52w1d'),
      'expiry-time must be a double-quoted string',
    ],
    [
      'unquoted from',
      line(queueCommand(), 'restrict,from=*.example.com'),
      'from must be a double-quoted pattern list',
    ],
    [
      'second command option',
      `restrict,command="false",command="${queueCommand()}" ${KEY}`,
      'at most one command option is allowed',
    ],
  ])('refuses %s', (_name, input, problem) => {
    const result = checkDispatchAuthorizedKeysLine(input, ROOTS);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(problem);
  });

  it('accepts one directory as both roots', () => {
    const same = queueCommand().replace(ARTIFACT, ROOT);
    const result = checkDispatchAuthorizedKeysLine(line(same), {
      deployRoot: ROOT,
      artifactRoot: ROOT,
    });
    expect(result).toEqual({ ok: true, identity: 'queue', problems: [] });
  });

  it.each([
    ['relative', 'srv/crq'],
    ['trailing slash', '/srv/crq/'],
    ['home shorthand', '~/repos/crq-deploy'],
    ['separator', '/srv/crq&&id'],
  ])('refuses a %s root', (_name, root) => {
    const result = checkDispatchAuthorizedKeysLine(line(queueCommand()), {
      deployRoot: ROOT,
      artifactRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'artifactRoot must be absolute with no trailing slash, whitespace or metacharacters',
    );
  });

  it('refuses a line with an unbalanced quote or no key', () => {
    expect(checkDispatchAuthorizedKeysLine(`restrict,command="x ${KEY}`, ROOTS).ok).toBe(false);
    expect(checkDispatchAuthorizedKeysLine(`restrict,command="${queueCommand()}"`, ROOTS).ok).toBe(
      false,
    );
  });
});
