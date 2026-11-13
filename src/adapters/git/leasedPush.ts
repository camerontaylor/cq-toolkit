import type { GhFn, GhResult } from '../forge-github/gh.js';

/** A concrete destination, resolved once by the composition and never reinterpreted as a remote. */
export interface PushDestination {
  readonly url: string;
}

/** Pin a named remote's push URL; concrete URLs and paths already name a destination. */
export async function resolvePushDestination(
  run: GhFn,
  path: string,
  target: string,
): Promise<PushDestination> {
  let destination = target;
  if (!/[/:]/.test(target) && !target.startsWith('.')) {
    const result = await run(['-C', path, 'remote', 'get-url', '--push', '--all', target]);
    const destinations = result.stdout.trim().split('\n');
    if (result.code !== 0 || destinations.length !== 1 || destinations[0] === '')
      throw new Error('publication requires exactly one push destination');
    destination = destinations[0]!;
  }
  return { url: destination };
}

/** Compare the explicit remote tip without granting permission to rewrite history. */
export async function leasedPush(
  run: GhFn,
  path: string,
  destination: PushDestination,
  branch: string,
  expected: string,
  sha: string,
): Promise<GhResult> {
  const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
  const ref = `refs/heads/${branch}`;
  const target = destination.url;

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
    if (remote.code === 0 && remote.stdout.trim() === `${sha.toLowerCase()}\t${ref}`)
      return { code: 0, stdout: '', stderr: '' };
  } catch {
    /* Remote state remains uncertain: withhold publication effects. */
  }
  return result;
}
