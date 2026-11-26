// Fallback usage (no result frame usage): repeated assistant events that share
// one `message.id` carry the same usage and must be counted once.
import { describe, expect, test } from 'vitest';
import { handleStdoutLine } from '../../../src/driver/claude-code/cli.js';
import { harnessObservation, line } from './cli.helpers.js';

const assistant = (id: string | undefined, output: number): string =>
  line({
    type: 'assistant',
    message: {
      ...(id !== undefined ? { id } : {}),
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 10, output_tokens: output },
    },
  });

describe('assistant fallback usage', () => {
  test('counts a repeated message.id once', () => {
    const observation = harnessObservation([]);
    handleStdoutLine(observation, assistant('msg_1', 5));
    handleStdoutLine(observation, assistant('msg_1', 5));
    handleStdoutLine(observation, assistant('msg_2', 7));
    expect(observation.assistantUsage).toMatchObject({ input: 20, output: 12 });
  });

  test('events without a message.id are all counted', () => {
    const observation = harnessObservation([]);
    handleStdoutLine(observation, assistant(undefined, 5));
    handleStdoutLine(observation, assistant(undefined, 5));
    expect(observation.assistantUsage).toMatchObject({ input: 20, output: 10 });
  });
});
