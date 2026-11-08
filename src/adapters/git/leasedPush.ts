import type { GhFn, GhResult } from '../forge-github/gh.js';

/** Pin a named remote's push URL; concrete URLs and paths already name a destination. */
export async function resolvePushDestination(
  run: GhFn,
  path: string,
  target: string,
): Promise<string> {
  if (/[/:]/.test(target) || target.startsWith('.')) return target;
  const result = await run(['-C', path, 'remote', 'get-url', '--push', target]);
  const destination = result.stdout.trim();
  if (result.code !== 0 || destination === '' || destination.includes('\n'))
    throw new Error('publication push destination unavailable');
  return destination;
}

/** Compare the explicit remote tip without granting permission to rewrite history. */
export async function leasedPush(
  run: GhFn,
  path: string,
  target: string,
  branch: string,
  expected: string,
  sha: string,
): Promise<GhResult> {
  const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
  const ref = `refs/heads/${branch}`;
  try {
    target = await resolvePushDestination(run, path, target);
  } catch {
    return fail('publication push destination unavailable');
  }

  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return fail('publication SHA unavailable');
  if (expected !== '') {
    const ancestor = await run(['-C', path, 'merge-base', '--is-ancestor', expected, sha]);
    if (ancestor.code !== 0) return fail('publication would not fast-forward expected head');
  }
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
