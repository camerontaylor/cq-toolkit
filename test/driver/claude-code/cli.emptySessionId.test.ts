// The CLI transport's empty-session-id guard (asNonEmptyString at both frame
// sites in handleStdoutLine): a frame carrying `session_id: ''` must not
// replace the id an earlier frame reported, or the WorkerResult non-empty
// schema would reject the run. sdk.emptySessionId.test.ts covers the SDK half.
import { describe, expect, test } from 'vitest';
import { handleStdoutLine } from '../../../src/driver/claude-code/cli.js';
import { harnessObservation, initLine, line } from './cli.helpers.js';

describe('claude-code cli: empty native session id', () => {
  test('an empty result-frame session_id keeps the id from the init frame', () => {
    const observation = harnessObservation([]);
    handleStdoutLine(observation, initLine([]));
    expect(observation.cliSessionId).toBe('cli-1');
    handleStdoutLine(observation, line({ type: 'result', subtype: 'success', session_id: '' }));
    expect(observation.cliSessionId).toBe('cli-1');
  });

  test('an empty later init-frame session_id keeps the earlier id', () => {
    const observation = harnessObservation([]);
    handleStdoutLine(observation, initLine([]));
    handleStdoutLine(
      observation,
      line({ type: 'system', subtype: 'init', session_id: '', model: 'conformance-1' }),
    );
    expect(observation.cliSessionId).toBe('cli-1');
  });

  test('a non-empty result-frame session_id still replaces the id', () => {
    const observation = harnessObservation([]);
    handleStdoutLine(observation, initLine([]));
    handleStdoutLine(
      observation,
      line({ type: 'result', subtype: 'success', session_id: 'cli-2' }),
    );
    expect(observation.cliSessionId).toBe('cli-2');
  });
});
