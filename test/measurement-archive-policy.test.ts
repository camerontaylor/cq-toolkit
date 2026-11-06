// The archive fails closed when policy/denylist/patterns.yml loses one of the
// secret classes its redaction depends on. Loaded in isolation because the
// guard runs at module evaluation time against the real policy file.
import { expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = vi.fn(actual.readFile);
  readFile.mockImplementation(async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).endsWith('patterns.yml'))
      return 'rules:\n  - id: class:route-key-material\n    regex: "a"\n';
    return actual.readFile(...args);
  });
  return { ...actual, readFile };
});

test('fails closed when a required policy secret rule is missing', async () => {
  await expect(import('../scripts/archive-measurement-evidence.mjs')).rejects.toThrow(
    'lacks required rule(s): class:token-ssh-plumbing, class:inline-secret-assignments',
  );
});
