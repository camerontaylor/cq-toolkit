// Focused unit tests for gitSubprocess batch-mode enforcement in addressMany.
// Regression coverage for the CodeRabbit/Codex finding: OpenSSH honors the
// first occurrence of an option, so appending `-oBatchMode=yes` after a
// configured `-oBatchMode=no` left interactive prompts enabled.
import { expect, test } from 'vitest';
import { gitSubprocess } from '../../../src/ops/review/addressMany.js';

const sshCommand = (configured?: string): string | undefined => {
  const env = gitSubprocess(configured).env;
  return env['GIT_SSH'] === undefined ? env['GIT_SSH_COMMAND'] : undefined;
};

test('plain ssh gains BatchMode=yes', () => {
  expect(sshCommand(undefined)).toBe('ssh -oBatchMode=yes');
});

test('configured command without BatchMode gains it, preserving other options', () => {
  expect(sshCommand('ssh -i /tmp/key -o IdentitiesOnly=yes')).toBe(
    'ssh -i /tmp/key -o IdentitiesOnly=yes -oBatchMode=yes',
  );
});

test('existing BatchMode=yes is normalized (position may move, kept once)', () => {
  expect(sshCommand('ssh -oBatchMode=yes -i /tmp/key')).toBe('ssh -i /tmp/key -oBatchMode=yes');
});

test('conflicting BatchMode=no is replaced by BatchMode=yes', () => {
  expect(sshCommand('ssh -oBatchMode=no')).toBe('ssh -oBatchMode=yes');
});

test('conflicting BatchMode in the middle is replaced, other options survive', () => {
  expect(sshCommand('ssh -oBatchMode=no -o ConnectTimeout=5 -p 2222')).toBe(
    'ssh -o ConnectTimeout=5 -p 2222 -oBatchMode=yes',
  );
});

test('case-insensitive match replaces -oBatchMode=No', () => {
  expect(sshCommand('ssh -oBatchMode=No')).toBe('ssh -oBatchMode=yes');
});
