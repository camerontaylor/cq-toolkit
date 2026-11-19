// Parity vectors for `capability_dispatcher.py`: `test_exact_command_dispatch_only`
// and `test_dispatcher_real_permission_failure_remains_nonzero`.
import { describe, expect, test } from 'vitest';
import {
  CAPABILITIES,
  DISPATCH_REFUSAL,
  runCapabilityDispatcher,
  selectCapability,
  type Capability,
} from '../../../src/adapters/crq/capabilityDispatcher.js';

function harness(command: string | undefined, argv: readonly string[] = [], failing?: Capability) {
  const calls: string[] = [];
  const errors: string[] = [];
  const handler = (name: Capability, code: number) => async () => {
    calls.push(name);
    if (name === failing) throw new Error('denied');
    return code;
  };
  const run = () =>
    runCapabilityDispatcher({
      argv,
      env: (name) => (name === 'SSH_ORIGINAL_COMMAND' ? command : undefined),
      stderr: (message) => errors.push(message),
      handlers: {
        'author-v1': handler('author-v1', 0),
        'queue-v1': handler('queue-v1', 1),
        'review-v1': handler('review-v1', 3),
      },
    });
  return { run, calls, errors };
}

describe('capability dispatcher', () => {
  test('routes each exact capability and returns its exit code', async () => {
    for (const [command, code] of [
      ['author-v1', 0],
      ['queue-v1', 1],
      ['review-v1', 3],
    ] as const) {
      const h = harness(command);
      expect(await h.run()).toBe(code);
      expect(h.calls).toEqual([command]);
      expect(h.errors).toEqual([]);
    }
  });

  test('refuses anything but an exact allowlisted command, before any handler', async () => {
    for (const command of [
      undefined,
      '',
      'queue-v1 ',
      ' queue-v1',
      'author-v1; id',
      'queue-v1 --path=/tmp',
      'QUEUE-V1',
      'review-v2',
      'sh',
    ]) {
      const h = harness(command);
      expect(await h.run()).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.errors).toEqual([DISPATCH_REFUSAL]);
    }
  });

  test('refuses extra arguments even for a valid command', async () => {
    const h = harness('queue-v1', ['--x']);
    expect(await h.run()).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.errors).toEqual([DISPATCH_REFUSAL]);
  });

  test('a capability that throws is the opaque refusal, exit 2', async () => {
    const h = harness('queue-v1', [], 'queue-v1');
    expect(await h.run()).toBe(2);
    expect(h.errors).toEqual(['queue capability refused; no permission']);
  });

  test('selectCapability matches only the allowlist', () => {
    expect(CAPABILITIES.map(selectCapability)).toEqual([...CAPABILITIES]);
    expect(selectCapability('toString')).toBeUndefined();
    expect(selectCapability(undefined)).toBeUndefined();
  });
});
