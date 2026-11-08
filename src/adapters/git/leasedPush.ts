import type { GhFn, GhResult } from '../forge-github/gh.js';

/** Compare the explicit remote tip without granting permission to rewrite history. */
export async function leasedPush(
  run: GhFn,
  path: string,
  target: string,
  branch: string,
  expected: string,
): Promise<GhResult> {
  const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
  const ref = `refs/heads/${branch}`;
  const tip = await run(['-C', path, 'rev-parse', 'HEAD']);
  if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(tip.stdout.trim()))
    return fail('publication HEAD unavailable');
  const sha = tip.stdout.trim();
  const ancestor = await run(['-C', path, 'merge-base', '--is-ancestor', expected, sha]);
  if (ancestor.code !== 0) return fail('publication would not fast-forward expected head');
  let result: GhResult;
  try {
    result = await run([
      '-C',
      path,
      'push',
      `--force-with-lease=${ref}:${expected}`,
      target,
      `${sha}:${ref}`,
    ]);
  } catch {
    result = fail('publication transport failed');
  }
  if (result.code === 0) return result;
  // A lost acknowledgement may hide a successful push. Never adopt any
  // other remote tip or retry old work against a refreshed expectation.
  try {
    const remote = await run(['-C', path, 'ls-remote', '--refs', target, ref]);
    if (remote.code === 0 && remote.stdout.trim() === `${sha}\t${ref}`)
      return { code: 0, stdout: '', stderr: '' };
  } catch {
    /* Remote state remains uncertain: withhold publication effects. */
  }
  return result;
}
