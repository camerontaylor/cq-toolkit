// Focused unit tests for gitSubprocess batch-mode enforcement in addressMany.
// Regression coverage for the CodeRabbit/Codex finding: OpenSSH honors the
// first occurrence of an option, so appending `-oBatchMode=yes` after a
// configured `-oBatchMode=no` left interactive prompts enabled. Both the
// attached (`-oBatchMode=no`) and separated (`-o BatchMode=no`) forms must be
// normalized before the enforcement option is appended. Quoted occurrences
// (`"-oBatchMode=no"`) must be removed too, without consuming their bounding
// quotes so shell quoting stays balanced, and repeated occurrences must not
// survive the rewrite so exactly one `-oBatchMode=yes` remains.
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

test('separated -o BatchMode=no is replaced when both SSH env vars are unset', () => {
  const previousGitSsh = process.env['GIT_SSH'];
  const previousGitSshCommand = process.env['GIT_SSH_COMMAND'];
  delete process.env['GIT_SSH'];
  delete process.env['GIT_SSH_COMMAND'];
  try {
    expect(sshCommand('ssh -o BatchMode=no -p 2222')).toBe('ssh -p 2222 -oBatchMode=yes');
  } finally {
    if (previousGitSsh !== undefined) process.env['GIT_SSH'] = previousGitSsh;
    if (previousGitSshCommand !== undefined) process.env['GIT_SSH_COMMAND'] = previousGitSshCommand;
  }
});

test('quoted "-oBatchMode=no" is removed without breaking shell quoting', () => {
  // Removal keeps both bounding quotes of the quoted argument, so quoting
  // stays balanced and the rewritten GIT_SSH_COMMAND remains valid for shell
  // execution: the leftover quoted token is inert and every other option and
  // argument survives, with the appended enforcement option the only
  // BatchMode occurrence in the command.
  const command = sshCommand('ssh "-oBatchMode=no" -p 2222');
  expect(command).toBe('ssh " " -p 2222 -oBatchMode=yes');
  expect((command?.match(/"/g) ?? []).length % 2).toBe(0);
  expect((command?.match(/-oBatchMode=/gi) ?? []).length).toBe(1);
});

test('repeated existing BatchMode options leave exactly one appended option', () => {
  // Adjacent occurrences share one delimiter, so a first rewrite that consumed
  // the whitespace between them left the second in place and OpenSSH would
  // still honor a configured BatchMode=no; both occurrences must be gone for
  // the appended `-oBatchMode=yes` to be the only BatchMode option in force.
  expect(sshCommand('ssh -oBatchMode=no -oBatchMode=yes')).toBe('ssh -oBatchMode=yes');
});
