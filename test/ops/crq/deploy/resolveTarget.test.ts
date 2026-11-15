import { describe, expect, test } from 'vitest';
import {
  Refused,
  resolveTarget,
  type GitResult,
} from '../../../../src/ops/crq/deploy/resolveTarget.js';

const A = 'a'.repeat(40);
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
function fake(answer: (args: readonly string[]) => GitResult) {
  const calls: string[] = [];
  return {
    calls,
    effects: { git: async (args: readonly string[]) => (calls.push(args.join(' ')), answer(args)) },
  };
}
describe('resolveTarget', () => {
  test('defaults to origin/main, trims output and fetches only when asked', async () => {
    const f = fake((a) => (a[0] === 'rev-parse' ? ok(`${A}\n`) : ok()));
    expect(await resolveTarget(null, true, f.effects)).toBe(A);
    expect(f.calls).toEqual([
      'fetch --quiet origin main',
      'rev-parse --verify refs/remotes/origin/main^{commit}',
      `cat-file -e ${A}^{commit}`,
      `merge-base --is-ancestor ${A} refs/remotes/origin/main`,
    ]);
    const g = fake((a) => (a[0] === 'rev-parse' ? ok(A) : ok()));
    await resolveTarget(null, false, g.effects);
    expect(g.calls[0]).toMatch(/^rev-parse/);
  });
  test('an explicit SHA must be a full lowercase 40-hex commit', async () => {
    const f = fake(() => ok());
    expect(await resolveTarget(A, false, f.effects)).toBe(A);
    expect(f.calls.some((c) => c.startsWith('rev-parse'))).toBe(false);
    for (const bad of ['abc123', 'A'.repeat(40), `${A}0`, '']) {
      const g = fake(() => ok());
      await expect(resolveTarget(bad, false, g.effects)).rejects.toThrow(
        '--target-sha must be a full 40-hex commit SHA',
      );
      expect(g.calls).toEqual([]);
    }
  });
  test('refuses a target that is not a commit here, before the ancestry test', async () => {
    const f = fake((a) => (a[0] === 'cat-file' ? { code: 1, stdout: '', stderr: '' } : ok()));
    await expect(resolveTarget(A, false, f.effects)).rejects.toThrow(
      `target ${A} is not a commit in this checkout`,
    );
    expect(f.calls.some((c) => c.startsWith('merge-base'))).toBe(false);
  });
  test('refuses a commit that is not merged to origin/main', async () => {
    const f = fake((a) => (a[0] === 'merge-base' ? { code: 1, stdout: '', stderr: '' } : ok()));
    await expect(resolveTarget(A, false, f.effects)).rejects.toThrow(
      `target ${A} is not merged to origin/main; only a merged main SHA is deployable`,
    );
  });
  test('a failed fetch or rev-parse is a Refused naming the last stderr line or exit code', async () => {
    const f = fake((a) =>
      a[0] === 'fetch' ? { code: 128, stdout: '', stderr: 'x\nfatal: no remote\n' } : ok(),
    );
    await expect(resolveTarget(null, true, f.effects)).rejects.toThrow(
      'git fetch --quiet origin main failed: fatal: no remote',
    );
    const g = fake(() => ({ code: 3, stdout: '', stderr: '' }));
    const err = await resolveTarget(null, false, g.effects).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Error).message).toBe(
      'git rev-parse --verify refs/remotes/origin/main^{commit} failed: exit 3',
    );
  });
});
