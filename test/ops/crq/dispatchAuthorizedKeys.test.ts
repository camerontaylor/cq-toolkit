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
