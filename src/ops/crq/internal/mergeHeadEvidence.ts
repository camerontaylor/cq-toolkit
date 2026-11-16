/** Bounded proof that a merged head retains the published repair changes. */
import { createHash } from 'node:crypto';
import type { RunGit } from '../../../adapters/crq/ledgerGit.js';
import { JsonObject } from '../../../policy/crq/jsonValue.js';
import { sourcePath } from '../../../policy/crq/repairBinding.js';
import { pythonSplitlines } from '../../../policy/crq/repairGates.js';

const sha = /^[0-9a-f]{40}$/;
const maxPatch = 262_144;
const maxTotal = 4_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Python reads patches as UTF-8 with surrogateescape and universal newlines.
function patchText(bytes: Buffer): string {
  const normalized = Buffer.from(bytes.toString('latin1').replace(/\r\n?/g, '\n'), 'latin1');
  let text = '';
  for (let i = 0; i < normalized.length;) {
    const b = normalized[i]!;
    const length =
      b < 0x80
        ? 1
        : b >= 0xc2 && b <= 0xdf
          ? 2
          : b >= 0xe0 && b <= 0xef
            ? 3
            : b >= 0xf0 && b <= 0xf4
              ? 4
              : 0;
    if (length && i + length <= normalized.length) {
      try {
        text += decoder.decode(normalized.subarray(i, i + length));
        i += length;
        continue;
      } catch {
        /* preserve the invalid byte below */
      }
    }
    text += String.fromCharCode(0xdc00 + b);
    i += 1;
  }
  return text;
}
function patchHash(bytes: Buffer): string {
  return createHash('sha256')
    .update(Buffer.from(bytes.toString('latin1').replace(/\r\n?/g, '\n'), 'latin1'))
    .digest('hex');
}

type Entry = readonly [string, string] | null;
export interface MergeHeadInput {
  readonly published: string | undefined;
  readonly actual: string;
  readonly commits: readonly string[];
  readonly anchors: readonly string[];
}
export interface MergeHeadProof {
  readonly published_head: string;
  readonly actual_head: string;
  readonly source_blobs: Record<string, string | null>;
  readonly source_modes?: Record<string, string | null>;
  readonly compared_paths?: readonly string[];
  readonly excluded_test_paths?: readonly string[];
  readonly published_commits?: readonly string[];
  readonly containment?: Record<string, unknown>;
  readonly extra_commits?: readonly { sha: string; subject: string }[];
  readonly extra_commits_total?: number;
  readonly extra_commits_truncated?: boolean;
  readonly match?: string;
}

/** Git output is kept as bytes until explicitly decoded; patches are never trimmed. */
export async function mergeHeadEvidence(
  input: MergeHeadInput,
  git: RunGit,
): Promise<MergeHeadProof | null> {
  if (!input.published) return null;
  const published = input.published;
  const evidence: MergeHeadProof = {
    published_head: published,
    actual_head: input.actual,
    source_blobs: {},
  };
  if (published === input.actual) return evidence;
  const run = async (args: string[]): Promise<Uint8Array> => {
    const result = await git(args);
    if (result.code !== 0) throw new Error('git evidence unavailable');
    return result.stdout;
  };
  const ancestor = async (a: string, b: string): Promise<boolean> => {
    const result = await git(['merge-base', '--is-ancestor', a, b]);
    if (result.code !== 0 && result.code !== 1) throw new Error('git ancestry unavailable');
    return result.code === 0;
  };
  if (
    !sha.test(published) ||
    !sha.test(input.actual) ||
    !input.anchors.length ||
    !(await ancestor(published, input.actual))
  )
    throw new Error('merged repair head is not a descendant of the published fix');
  if (!input.commits.length || input.commits.length > 64)
    throw new Error('published repair commits unavailable or exceed bound');
  const changed = new Set<string>();
  for (const commit of input.commits) {
    if (!sha.test(commit) || !(await ancestor(commit, published)))
      throw new Error('published repair commit lineage unavailable');
    const paths = decoder.decode(
      await run([
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        commit,
      ]),
    );
    for (const path of paths.split('\0')) if (path) changed.add(path);
  }
  const testPath = (p: string): boolean =>
    /^(?:test\/.*\.test\.(?:ts|mjs)|lint\/.*\.test\.ts)$/.test(p);
  const paths = [
    ...new Set([...input.anchors, ...[...changed].filter((p) => !testPath(p))]),
  ].sort();
  if (paths.length > 128) throw new Error('merged repair compared paths exceed bound');
  const excluded = [...changed].filter((p) => !paths.includes(p)).sort();
  const range = `${published}..${input.actual}`;
  const countText = decoder.decode(await run(['rev-list', '--count', range])).trim();
  if (!/^\d+$/.test(countText) || !Number.isSafeInteger(Number(countText)))
    throw new Error('extra commit count unavailable');
  const totalCommits = Number(countText);
  const listing = decoder.decode(await run(['log', '--max-count=32', '--format=%H%x09%s', range]));
  const extraCommits = listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('\t');
      if (index < 0 || !sha.test(line.slice(0, index)))
        throw new Error('extra commit listing unavailable');
      return {
        sha: line.slice(0, index),
        subject: Array.from(line.slice(index + 1))
          .slice(0, 200)
          .join(''),
      };
    });
  const lineage = decoder
    .decode(await run(['rev-list', '--parents', '-n', '1', input.commits[0]!]))
    .trim()
    .split(/\s+/);
  const parent = lineage[1];
  if (parent !== undefined && !sha.test(parent))
    throw new Error('published repair parent unavailable');
  const entry = async (head: string, path: string): Promise<Entry> => {
    const raw = decoder.decode(await run(['ls-tree', '-z', head, '--', path]));
    if (!raw) return null;
    const match = /^(\d+) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(raw);
    if (!match || match[3] !== path)
      throw new Error('repair source is not an exact blob path: ' + path);
    return [match[1]!, match[2]!];
  };
  const modes: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const blobs: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const containment: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let total = 0;
  let excerptBudget = 8192;
  const patch = async (args: string[]): Promise<Buffer> => {
    const bytes = Buffer.from(await run(args));
    total += bytes.length;
    if (bytes.length > maxPatch || total > maxTotal)
      throw new Error('published repair change too large to verify; needs revalidation');
    return bytes;
  };
  const lines = (text: string): [string[], string[]] => {
    const added: string[] = [];
    const removed: string[] = [];
    let hunk = false;
    for (const line of pythonSplitlines(text)) {
      if (line.startsWith('diff --git ')) hunk = false;
      else if (line.startsWith('@@')) hunk = true;
      else if (hunk && line.startsWith('+')) added.push(line.slice(1));
      else if (hunk && line.startsWith('-')) removed.push(line.slice(1));
    }
    return [added, removed];
  };
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0'];
  for (const path of paths) {
    const normalized = sourcePath(new JsonObject([['path', path]]));
    if (!normalized.ok || normalized.path !== path) throw new Error('invalid repair source path');
    const before = await entry(published, path);
    const after = await entry(input.actual, path);
    const prior = parent ? await entry(parent, path) : null;
    blobs[path] = before?.[1] ?? null;
    modes[path] = before?.[0] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) {
      containment[path] = { published: before, actual: after, status: 'identical' };
      continue;
    }
    if (before && !after)
      throw new Error('merged repair source changed; needs revalidation: ' + path);
    // A root publication spans the empty tree through the published head,
    // not just the first commit. Git recognizes its empty tree object by ID.
    let changeBase = parent;
    if (!changeBase) {
      const format = decoder.decode(await run(['rev-parse', '--show-object-format'])).trim();
      // This proof's commit/blob validation currently supports SHA-1 only.
      if (format !== 'sha1') throw new Error('unsupported Git object format; needs revalidation');
      changeBase = createHash('sha1').update('tree 0\0').digest('hex');
    }
    const original = await patch(['diff', ...options, changeBase, published, '--', path]);
    const originalText = patchText(original);
    if (!originalText.trim()) {
      containment[path] = {
        published: before,
        actual: after,
        status: 'unchanged-by-publication',
        published_parent: parent ?? null,
      };
      continue;
    }
    if (
      (!before && after) ||
      pythonSplitlines(originalText).some(
        (line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'),
      )
    )
      throw new Error('merged repair source changed; needs revalidation: ' + path);
    const [added, removed] = lines(originalText);
    const modeChanged = !!before && (!prior || prior[0] !== before[0]);
    if (!added.length && !removed.length && !modeChanged)
      throw new Error('merged repair source changed; needs revalidation: ' + path);
    const extra = await patch(['diff', ...options, published, input.actual, '--', path]);
    const extraText = patchText(extra);
    if (
      pythonSplitlines(extraText).some(
        (line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'),
      )
    )
      throw new Error('merged repair source changed; needs revalidation: ' + path);
    const [extraAdded, extraRemoved] = lines(extraText);
    const extraAddedSet = new Set(extraAdded);
    const extraRemovedSet = new Set(extraRemoved);
    if (
      added.some((l) => extraRemovedSet.has(l)) ||
      removed.some((l) => extraAddedSet.has(l)) ||
      (modeChanged && after?.[0] !== before?.[0])
    )
      throw new Error('merged repair source changed; needs revalidation: ' + path);
    const excerpts: Record<string, string | boolean> = {};
    for (const [key, text] of [
      ['patch', originalText],
      ['extra_patch', extraText],
    ] as const) {
      const kept = Math.min(2048, excerptBudget);
      if (kept > 0) {
        const chars = Array.from(text);
        excerpts[key] = chars.slice(0, kept).join('');
        excerpts[key + '_truncated'] = chars.length > kept;
        excerptBudget -= Math.min(kept, chars.length);
      } else excerpts[key + '_omitted'] = true;
    }
    containment[path] = {
      published: before,
      actual: after,
      status: 'contained',
      published_parent: parent ?? null,
      mode_checked: modeChanged,
      changed_added: added.length,
      changed_removed: removed.length,
      patch_sha256: patchHash(original),
      patch_bytes: original.length,
      extra_patch_sha256: patchHash(extra),
      extra_patch_bytes: extra.length,
      ...excerpts,
    };
  }
  return {
    ...evidence,
    source_blobs: blobs,
    source_modes: modes,
    compared_paths: paths,
    excluded_test_paths: excluded,
    published_commits: [...input.commits],
    containment,
    extra_commits: extraCommits,
    extra_commits_total: totalCommits,
    extra_commits_truncated: totalCommits > extraCommits.length,
    match: paths.length ? 'containment' : 'no-compared-paths',
  };
}
