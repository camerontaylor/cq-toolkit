import { Refused } from './errors.js';
export { Refused };
/**
 * The two git-reading guards of the deploy runbook, over an injected git.
 *
 * Ports `Run.assert_clean` and `Run.require_unchanged_unit_templates` from
 * `apps/crq-python/ops/deploy-runbook.py`. Inactive and unimported: nothing
 * here runs a process; the caller supplies `git`.
 */

/** The tracked file the overlay renders; the only change a live checkout may carry. */
export const CONFIG_RELPATH = 'apps/crq-python/config.json';
export const UNIT_TEMPLATE_DIR = 'apps/crq-python/ops/systemd/';

export interface GitStatusResult {
  readonly returncode: number;
  /** Raw, unstripped stdout: the leading XY column is meaningful. */
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitGuardEffects {
  /** `git status --porcelain --untracked-files=all`, raw output. */
  statusPorcelain(): Promise<GitStatusResult>;
  /** Python `git(root, *args)`: stripped stdout, throws `Refused` on a non-zero exit. */
  git(...args: string[]): Promise<string>;
}

/** Python whitespace as `str.strip` and `str.isspace` see it. */
const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_BLANK = new RegExp(`^[${PY_SPACE}]*$`);
const PY_TRIM = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

const LINE_BREAKS = new Set([
  '\n',
  '\r',
  '\v',
  '\f',
  '\x1c',
  '\x1d',
  '\x1e',
  '\x85',
  '\u2028',
  '\u2029',
]);

/** Python `str.splitlines()` (universal newlines, no empty final element). */
export function splitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!LINE_BREAKS.has(text[i]!)) continue;
    lines.push(text.slice(start, i));
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function pyStrip(text: string): string {
  return text.replace(PY_TRIM, '');
}

/** Code-point order, as Python `sorted` on `str`. */
export function codePointSorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const x = left[i]!.codePointAt(0)!;
      const y = right[i]!.codePointAt(0)!;
      if (x !== y) return x - y;
    }
    return left.length - right.length;
  });
}

function clip(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

/** Python `Run.assert_clean`: only the rendered config may differ from HEAD. */
export async function assertClean(effects: GitGuardEffects): Promise<void> {
  const completed = await effects.statusPorcelain();
  if (completed.returncode !== 0)
    throw new Refused(`git status failed: ${clip(pyStrip(completed.stderr), 200)}`);
  const changes = splitlines(completed.stdout).filter((line) => !PY_BLANK.test(line));
  const allowed = new Set([` M ${CONFIG_RELPATH}`, `M  ${CONFIG_RELPATH}`]);
  const unexpected = changes.filter((line) => !allowed.has(line));
  if (unexpected.length > 0)
    throw new Refused(
      'deployment checkout has changes other than the rendered config: ' +
        unexpected.slice(0, 5).join('; '),
    );
}

/** Refuse a target whose rendered crq-* unit templates differ from the live HEAD's. */
export async function requireUnchangedUnitTemplates(
  effects: GitGuardEffects,
  priorSha: string,
  target: string,
): Promise<void> {
  const templates = async (sha: string): Promise<Map<string, string>> => {
    const listing = await effects.git('ls-tree', '-r', '--name-only', sha, UNIT_TEMPLATE_DIR);
    const blobs = new Map<string, string>();
    for (const name of codePointSorted(splitlines(listing))) {
      if (!name.slice(name.lastIndexOf('/') + 1).startsWith('crq-')) continue;
      blobs.set(name, await effects.git('rev-parse', `${sha}:${name}`));
    }
    return blobs;
  };
  const prior = await templates(priorSha);
  const next = await templates(target);
  const changed = codePointSorted(
    [...new Set([...prior.keys(), ...next.keys()])].filter(
      (name) => prior.get(name) !== next.get(name),
    ),
  );
  if (changed.length > 0)
    throw new Refused(
      `target ${target.slice(0, 12)} changes rendered unit templates this flow cannot reconcile: ` +
        'it installs no unit files, verifies none with the user manager, and rollback ' +
        'cannot restore the prior definitions. The owner must install and verify the ' +
        `changed unit definitions against this target first: ${changed.join(', ')}`,
    );
}
