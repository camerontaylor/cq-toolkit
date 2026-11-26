/**
 * Replay of the Python oracle for the file- and Git-backed repair cleanup.
 *
 * Each scenario in `crq-repair-harvest-effects/cases.json` was run through the
 * production `crq_repair.retain.cleanup_harvested` over a real linked worktree.
 * This test rebuilds the same tree with the real `git`, runs
 * `fileRepairCleanup`, and compares which `crq-repair-*` trees survive and the
 * exception class that escaped.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { fileRepairCleanup } from '../../../src/adapters/crq/repairCleanupEffects.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';

interface Snapshot {
  kind: string;
  where?: string;
}
interface Spec {
  verdict?: string;
  dir?: string;
  dirty?: string;
  locked?: boolean;
  snapshots?: Snapshot[];
  result_worktree?: string;
  drop_base?: boolean;
  alternate?: boolean;
}
interface Case {
  name: string;
  spec: Spec;
  expected: { returned: boolean | null; error: string | null; survivors: string[] };
}

const document = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/crq-python/fixtures/crq-repair-harvest-effects/cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { item: string; job: string; cleanup_cases: Case[] };
const ITEM = document.item;
const JOB = document.job;
const NAME = `crq-repair-${ITEM}-${JOB}`;
const ARCHIVES = [
  'staged.patch',
  'unstaged.patch',
  'committed.patch',
  'untracked.tar',
  'commits.bundle',
];
/** Repository-location variables a git hook or shell may export; git would act on that repository. */
const REPOSITORY_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !REPOSITORY_LOCATION_VARS.includes(key)),
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Python's `json.dumps(sort_keys=True, separators=(',', ':'))` for ASCII data. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function writeSnapshot(
  parent: string | Buffer,
  head: string,
  base: string,
  kind: string,
): Promise<string> {
  const contents = Object.fromEntries(
    ARCHIVES.map((name) => [name, Buffer.from(`archive:${name}`)]),
  );
  let manifest: unknown = {
    base,
    head,
    commits: [],
    untracked: [],
    sha256: Object.fromEntries(Object.entries(contents).map(([name, data]) => [name, sha(data)])),
  };
  const fields = manifest as Record<string, unknown>;
  if (kind === 'bad-head') fields['head'] = 'f'.repeat(40);
  else if (kind === 'bad-base') fields['base'] = 'e'.repeat(40);
  else if (kind === 'no-sha') delete fields['sha256'];
  let manifestText = JSON.stringify(manifest);
  if (kind === 'list-manifest') {
    manifest = [];
    manifestText = '[]';
  }
  const token = sha(canonical(manifest));
  const directory = Buffer.concat([
    Buffer.from(parent),
    Buffer.from('/retained-'),
    Buffer.from(kind === 'misnamed' ? 'misnamed' : token),
  ]);
  await mkdir(directory, { recursive: true });
  for (const [name, data] of Object.entries(contents)) {
    if (kind === 'missing-archive' && name === 'commits.bundle') continue;
    await writeFile(
      Buffer.concat([directory, Buffer.from(`/${name}`)]),
      kind === 'tamper' && name === 'staged.patch' ? Buffer.from('tampered') : data,
    );
  }
  await writeFile(
    Buffer.concat([directory, Buffer.from('/manifest.json')]),
    kind === 'bad-json' ? '{' : manifestText,
  );
  return directory.toString('utf8');
}

async function place(
  directory: string,
  snapshot: Snapshot,
  head: string,
  base: string,
  tmp: string,
): Promise<void> {
  const where = snapshot.where ?? 'direct';
  await mkdir(directory, { recursive: true });
  if (where === 'direct') await writeSnapshot(directory, head, base, snapshot.kind);
  else if (where === 'nested')
    await writeSnapshot(join(directory, 'deep', 'er'), head, base, snapshot.kind);
  else if (where === 'non-utf8')
    await writeSnapshot(
      Buffer.concat([
        Buffer.from(directory),
        Buffer.from('/'),
        Buffer.from([0xff]),
        Buffer.from('dir'),
      ]),
      head,
      base,
      snapshot.kind,
    );
  else if (where === 'under-symlink') {
    const outside = join(tmp, 'outside-snapshots');
    await mkdir(outside);
    await writeSnapshot(outside, head, base, snapshot.kind);
    await symlink(outside, join(directory, 'link'), 'dir');
  } else if (where === 'symlinked-snapshot') {
    const elsewhere = join(tmp, 'elsewhere');
    await mkdir(elsewhere);
    const real = await writeSnapshot(elsewhere, head, base, snapshot.kind);
    await symlink(real, join(directory, real.slice(real.lastIndexOf('/') + 1)), 'dir');
  } else throw new Error(`unknown placement ${where}`);
}

describe('repair cleanup effects against the Python oracle', () => {
  test('the fixture is not vacuous', () => {
    const survivors = new Set(document.cleanup_cases.map((c) => c.expected.survivors.length));
    expect(survivors).toEqual(new Set([0, 1]));
    expect(document.cleanup_cases.length).toBeGreaterThan(25);
  });

  test.each(document.cleanup_cases.map((c) => [c.name, c] as const))(
    '%s',
    async (_name, chosen) => {
      const spec = chosen.spec;
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'crq-cleanup-effects-')));
      temporary.push(tmp);
      const clone = join(tmp, 'clone');
      const root = join(tmp, 'wt');
      const stateRoot = join(tmp, 'state');
      const directory = join(stateRoot, 'repair', JOB);
      await mkdir(clone);
      await mkdir(root);
      git(clone, 'init', '-q', '-b', 'main');
      await writeFile(join(clone, 'f.txt'), 'one\n');
      git(clone, 'add', 'f.txt');
      git(clone, 'commit', '-q', '-m', 'base');
      const base = git(clone, 'rev-parse', 'HEAD');
      const dirname = NAME + (spec.dir === 'a2' ? '-A2' : '');
      const wt = join(root, dirname);
      git(clone, 'worktree', 'add', '-q', '-b', 'br', wt);
      const head = git(wt, 'rev-parse', 'HEAD');
      if (spec.dirty === 'untracked') await writeFile(join(wt, 'u.txt'), 'x');
      else if (spec.dirty === 'ignored') {
        await appendFile(join(clone, '.git', 'info', 'exclude'), 'ig.txt\n');
        await writeFile(join(wt, 'ig.txt'), 'x');
      } else if (spec.dirty === 'staged') {
        await writeFile(join(wt, 's.txt'), 'x');
        git(wt, 'add', 's.txt');
      }
      if (spec.locked) git(clone, 'worktree', 'lock', wt);
      for (const snapshot of spec.snapshots ?? [])
        await place(directory, snapshot, head, base, tmp);

      const result: Record<string, unknown> = {
        verdict: spec.verdict ?? 'FIXED',
        repair_base: base,
      };
      const target = spec.result_worktree ?? 'self';
      if (target === 'self') result['worktree'] = wt;
      else if (target === 'a2') result['worktree'] = join(root, `${NAME}-A2`);
      else if (target === 'outside') {
        await mkdir(join(tmp, 'other'));
        result['worktree'] = join(tmp, 'other', dirname);
      } else if (target === 'symlink') {
        await symlink(wt, join(root, 'link'), 'dir');
        result['worktree'] = join(root, 'link');
      } else if (target !== 'absent') throw new Error(`unknown target ${target}`);
      if (spec.drop_base) delete result['repair_base'];

      const cleanup = fileRepairCleanup({ stateRoot, worktreeRoot: root, clone });
      let error: string | null = null;
      try {
        await cleanup(ITEM, JOB, result, spec.alternate === true);
      } catch (caught) {
        if (!(caught instanceof PyError)) throw caught;
        error = caught.kind;
      }
      const survivors = (await readdir(root))
        .filter((name) => name.startsWith('crq-repair-'))
        .sort();
      expect({ error, survivors }).toEqual({
        error: chosen.expected.error,
        survivors: chosen.expected.survivors,
      });
    },
  );
});
