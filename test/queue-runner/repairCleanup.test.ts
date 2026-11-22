/**
 * Differential test for the repair-cleanup eligibility decision
 * (src/queue-runner/repairCleanup.ts) against Python's
 * `crq_repair.retain.cleanup_harvested`.
 *
 * Offline and non-destructive by construction: every scenario is a temporary
 * fixture; the Python oracle runs with `retain.command` and `retain.git`
 * replaced, so `git status`/`rev-parse` are scripted and `git worktree remove`
 * is only RECORDED, never executed. Nothing here removes a worktree.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import { parseJsonValue, toPlainJsonRetainingNumbers } from '../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../src/policy/crq/pythonJson.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import {
  decideRepairCleanup,
  normalizePosixPath,
  RETAINED_ARCHIVES,
  type RepairCleanupDecision,
  type RepairCleanupProbes,
  type RepairCleanupRequest,
  type RetentionRecord,
} from '../../src/queue-runner/repairCleanup.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ITEM = 'pr1-merged';
const JOB = 'crq-R-F1';
const OWNED = `crq-repair-${ITEM}-${JOB}`;

type Tweak =
  | 'ok'
  | 'head'
  | 'base'
  | 'archive-digest'
  | 'archive-missing'
  | 'malformed'
  | 'not-object'
  | 'bad-token'
  | 'no-sha256'
  | 'sha256-list'
  | 'sha256-missing-name'
  | 'sha256-non-string'
  | 'no-head'
  | 'no-base'
  | 'bom'
  | 'invalid-utf8'
  | 'manifest-is-directory'
  | 'nan-field'
  | 'float-base'
  | 'unicode-extra';

interface Retained {
  /** Directory under the job directory the `retained-<token>` dir sits in ('' = directly). */
  readonly under: string;
  readonly tweak: Tweak;
}

interface Scenario {
  readonly name: string;
  readonly expectRemove: boolean;
  readonly alternate?: boolean;
  readonly itemId?: string;
  readonly jobId?: string;
  /** Directories created under WT_ROOT (default: the owned tree). */
  readonly trees?: readonly string[];
  /** Symlinks under WT_ROOT: name -> target relative to the fixture root. */
  readonly links?: Readonly<Record<string, string>>;
  /** The result `worktree`, relative to WT_ROOT unless a raw override is given. */
  readonly worktree?: string;
  readonly worktreeRaw?: unknown;
  /**
   * The result `worktree` as JSON text. Python parses it (so `1.0` is a float);
   * the TS side gets it through `toPlainJsonRetainingNumbers`, which keeps the
   * int/float kind a plain JS number would lose.
   */
  readonly worktreeJson?: string;
  readonly omitWorktree?: boolean;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly status?: { readonly rc: number; readonly out: string };
  readonly headError?: string;
  readonly retained?: readonly Retained[];
}

const OK: Retained = { under: 'final', tweak: 'ok' };

interface Fixture {
  readonly root: string;
  readonly wtRoot: string;
  readonly directory: string;
  readonly request: RepairCleanupRequest;
  /** `worktree` JSON text the Python oracle parses over the request's value, if any. */
  readonly worktreeJson?: string;
}

/** Build a scenario's temporary tree and return what both oracles are fed. */
function build(scenario: Scenario): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'repair-cleanup-'));
  dirs.push(root);
  const wtRoot = join(root, 'wt');
  const directory = join(root, 'state', 'repair', scenario.jobId ?? JOB);
  mkdirSync(wtRoot, { recursive: true });
  mkdirSync(directory, { recursive: true });
  for (const tree of scenario.trees ?? [OWNED]) mkdirSync(join(wtRoot, tree), { recursive: true });
  for (const [name, target] of Object.entries(scenario.links ?? {})) {
    mkdirSync(join(root, target), { recursive: true });
    symlinkSync(join(root, target), join(wtRoot, name));
  }
  for (const [index, retained] of (scenario.retained ?? []).entries()) {
    writeRetained(join(directory, retained.under), retained.tweak, index);
  }
  const worktree = 'worktreeRaw' in scenario ? scenario.worktreeRaw : (scenario.worktree ?? OWNED);
  const result: Record<string, unknown> = {
    verdict: 'FIXED',
    repair_base: BASE,
    ...(scenario.omitWorktree
      ? {}
      : { worktree: typeof worktree === 'string' ? join(wtRoot, worktree) : worktree }),
    ...scenario.result,
  };
  // `undefined` means the key is absent (JSON drops it for the Python side).
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  if (scenario.worktreeJson !== undefined) {
    result.worktree = toPlainJsonRetainingNumbers(parseJsonValue(scenario.worktreeJson));
  }
  return {
    root,
    wtRoot,
    directory,
    ...(scenario.worktreeJson === undefined ? {} : { worktreeJson: scenario.worktreeJson }),
    request: {
      worktreeRoot: wtRoot,
      directory,
      itemId: scenario.itemId ?? ITEM,
      jobId: scenario.jobId ?? JOB,
      result,
      alternate: scenario.alternate ?? false,
    },
  };
}

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Write one `retained-<token>/` snapshot the way `retain()` does, then damage it per `tweak`. */
function writeRetained(parent: string, tweak: Tweak, index: number): void {
  const contents: Record<string, string> = Object.fromEntries(
    RETAINED_ARCHIVES.map((name) => [name, `${name}:${String(index)}\n`]),
  );
  const digests: Record<string, unknown> = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [name, sha(text)]),
  );
  const manifest: Record<string, unknown> = {
    base: tweak === 'base' ? 'c'.repeat(40) : tweak === 'float-base' ? 1 : BASE,
    head: tweak === 'head' ? 'd'.repeat(40) : HEAD,
    commits: [],
    untracked: tweak === 'unicode-extra' ? ['naïve-ß-\u{1f600}.txt'] : [],
    sha256: digests,
  };
  if (tweak === 'archive-digest') digests['untracked.tar'] = '0'.repeat(64);
  if (tweak === 'sha256-missing-name') delete digests['commits.bundle'];
  if (tweak === 'sha256-non-string') digests['staged.patch'] = 7;
  if (tweak === 'no-sha256') delete manifest.sha256;
  if (tweak === 'sha256-list') manifest.sha256 = Object.values(digests);
  if (tweak === 'no-head') delete manifest.head;
  if (tweak === 'no-base') delete manifest.base;
  const asText = (m: unknown): string => JSON.stringify(m);
  let text = asText(manifest);
  let token = receiptJsonDigest(JSON.parse(text) as unknown);
  if (tweak === 'nan-field') {
    // Python's json.dumps writes a bare NaN and a matching token covers it.
    manifest.extra = 'NAN';
    text = asText(manifest).replace('"NAN"', 'NaN');
    token = pyToken(text);
  }
  if (tweak === 'float-base') {
    text = text.replace('"base":1,', '"base":1.0,');
    token = pyToken(text);
  }
  if (tweak === 'unicode-extra') token = pyToken(text);
  if (tweak === 'not-object') {
    text = '["not","a","dict"]';
    token = receiptJsonDigest(JSON.parse(text) as unknown);
  }
  if (tweak === 'malformed') text = '{"base": ';
  if (tweak === 'bom') text = `﻿${text}`;
  if (tweak === 'bad-token') token = '0'.repeat(64);
  const target = join(parent, `retained-${token}`);
  mkdirSync(target, { recursive: true });
  for (const [name, body] of Object.entries(contents)) {
    if (tweak === 'archive-missing' && name === 'untracked.tar') continue;
    writeFileSync(join(target, name), body);
  }
  if (tweak === 'manifest-is-directory') mkdirSync(join(target, 'manifest.json'));
  else if (tweak === 'invalid-utf8')
    writeFileSync(join(target, 'manifest.json'), Buffer.from([0xff]));
  else writeFileSync(join(target, 'manifest.json'), text);
}

/** `sha256(json.dumps(json.loads(text), sort_keys=True, separators=(',', ':')))` run by Python itself. */
function pyToken(text: string): string {
  return execFileSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import sys, json, hashlib',
        'm = json.loads(sys.argv[1])',
        "print(hashlib.sha256(json.dumps(m, sort_keys=True, separators=(',', ':')).encode()).hexdigest())",
      ].join('\n'),
      text,
    ],
    { encoding: 'utf8' },
  ).trim();
}

const PY = `
import sys, json
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import crq_repair.retain as retain
out = []
for s in json.loads(sys.argv[2]):
    seen = {'removed': [], 'statusCwd': [], 'headCwd': []}
    def fake_command(argv, cwd=None, env=None, timeout=1200, s=s, seen=seen):
        if argv[:3] == ['git', 'worktree', 'remove']:
            seen['removed'].append(argv[3])  # recorded, never executed
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        if argv[:2] == ['git', 'status']:
            seen['statusCwd'].append(str(cwd))
            return SimpleNamespace(returncode=s['rc'], stdout=s['out'], stderr='')
        raise AssertionError(argv)
    def fake_git(wt, *args, s=s, seen=seen):
        assert args == ('rev-parse', 'HEAD'), args
        seen['headCwd'].append(str(wt))
        if s.get('headError'):
            raise RuntimeError(s['headError'])
        return s['head']
    retain.command = fake_command
    retain.git = fake_git
    entry = dict(seen)
    if s.get('worktreeJson') is not None:
        s['result']['worktree'] = json.loads(s['worktreeJson'])
    try:
        entry['returned'] = retain.cleanup_harvested(
            s['wtRoot'], s['wtRoot'], s['directory'], s['item'], s['job'], s['result'],
            alternate=s['alternate'])
    except Exception as e:
        entry['error'] = type(e).__name__
        entry['message'] = str(e)
    out.append(entry)
print(json.dumps(out))
`;

interface Seen {
  readonly removed: string[];
  readonly statusCwd: string[];
  readonly headCwd: string[];
  readonly returned?: boolean;
  readonly error?: string;
  readonly message?: string;
}

function runPython(items: readonly { scenario: Scenario; fixture: Fixture }[]): Seen[] {
  const specs = items.map(({ scenario, fixture }) => ({
    wtRoot: fixture.wtRoot,
    directory: fixture.directory,
    item: fixture.request.itemId,
    job: fixture.request.jobId,
    // A JsonNumber would not serialise; the oracle parses `worktreeJson` instead.
    result:
      fixture.worktreeJson === undefined
        ? fixture.request.result
        : { ...fixture.request.result, worktree: null },
    alternate: fixture.request.alternate,
    rc: scenario.status?.rc ?? 0,
    out: scenario.status?.out ?? '',
    head: HEAD,
    headError: scenario.headError ?? null,
    worktreeJson: fixture.worktreeJson ?? null,
  }));
  const stdout = execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, JSON.stringify(specs)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Seen[];
}

interface Trace {
  /** Every path handed to `resolve`: a symlinked worktree must never reach it. */
  readonly resolved: string[];
  readonly statusCwd: string[];
  readonly headCwd: string[];
  readonly archiveReads: string[];
}

/** Read-only probes over a real temporary fixture, with scripted Git answers. */
function probesFor(scenario: Scenario, fixture: Fixture, trace: Trace): RepairCleanupProbes {
  const reads = fileRepairHarvestReads({
    stateRoot: join(fixture.root, 'state'),
    worktreeRoot: fixture.wtRoot,
  });
  const isDir = (path: string): boolean => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const find = (dir: string, out: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let walk = false;
      try {
        walk = !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory();
      } catch {
        walk = false;
      }
      if (!walk) continue;
      if (entry.startsWith('retained-') && existsAny(join(path, 'manifest.json'))) out.push(path);
      find(path, out);
    }
  };
  return {
    resolve: (path) => {
      trace.resolved.push(path);
      return reads.resolvePath(path);
    },
    isSymlink: async (path) => {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch {
        return false;
      }
    },
    isDirectory: (path) => Promise.resolve(isDir(path)),
    status: (worktree) => {
      trace.statusCwd.push(worktree);
      return Promise.resolve({
        failed: (scenario.status?.rc ?? 0) !== 0,
        stdout: scenario.status?.out ?? '',
      });
    },
    head: (worktree) => {
      trace.headCwd.push(worktree);
      if (scenario.headError !== undefined) {
        return Promise.reject(new PyError('RuntimeError', scenario.headError));
      }
      return Promise.resolve(HEAD);
    },
    retainedManifests: (directory) => {
      const found: string[] = [];
      find(directory, found);
      return Promise.resolve(
        found.map((path): RetentionRecord => {
          const name = path.slice(path.lastIndexOf('/') + 1);
          return {
            directoryName: name,
            readManifest: () => readBytes(join(path, 'manifest.json')),
            archiveDigest: async (archive) => {
              trace.archiveReads.push(`${name}/${archive}`);
              return sha(await readBytes(join(path, archive)));
            },
          };
        }),
      );
    },
  };
}

function existsAny(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readBytes(path: string): Promise<Buffer> {
  try {
    return Promise.resolve(readFileSync(path));
  } catch (e) {
    return Promise.reject(new PyError('OSError', e instanceof Error ? e.message : String(e)));
  }
}

async function runTs(
  scenario: Scenario,
  fixture: Fixture,
): Promise<{ decision?: RepairCleanupDecision; error?: PyError; trace: Trace }> {
  const trace: Trace = { resolved: [], statusCwd: [], headCwd: [], archiveReads: [] };
  try {
    const decision = await decideRepairCleanup(
      fixture.request,
      probesFor(scenario, fixture, trace),
    );
    return { decision, trace };
  } catch (e) {
    if (e instanceof PyError) return { error: e, trace };
    throw e;
  }
}

const SCENARIOS: readonly Scenario[] = [
  // --- verdict gate ---
  { name: 'FIXED with a matching archive', expectRemove: true, retained: [OK] },
  {
    name: 'NOT-FIXED is cleaned too',
    expectRemove: true,
    result: { verdict: 'NOT-FIXED' },
    retained: [OK],
  },
  {
    name: 'FAILED keeps its tree',
    expectRemove: false,
    result: { verdict: 'FAILED' },
    retained: [OK],
  },
  {
    name: 'STALE keeps its tree',
    expectRemove: false,
    result: { verdict: 'STALE' },
    retained: [OK],
  },
  {
    name: 'a lower-case verdict is not cleaned',
    expectRemove: false,
    result: { verdict: 'fixed' },
    retained: [OK],
  },
  {
    name: 'a list verdict is not cleaned',
    expectRemove: false,
    result: { verdict: ['FIXED'] },
    retained: [OK],
  },
  // --- worktree ownership ---
  {
    name: 'wrong job id is not owned',
    expectRemove: false,
    worktree: `crq-repair-${ITEM}-crq-R-F2`,
    trees: [`crq-repair-${ITEM}-crq-R-F2`],
    retained: [OK],
  },
  {
    name: 'wrong item id is not owned',
    expectRemove: false,
    worktree: 'crq-repair-other-crq-R-F1',
    trees: ['crq-repair-other-crq-R-F1'],
    retained: [OK],
  },
  {
    name: 'the legacy name is not owned (harvest accepts it, cleanup does not)',
    expectRemove: false,
    worktree: `crq-repair-${ITEM}`,
    trees: [`crq-repair-${ITEM}`],
    retained: [OK],
  },
  {
    name: 'a prefix of the owned name is not owned',
    expectRemove: false,
    worktree: `${OWNED}-A22`,
    trees: [`${OWNED}-A22`],
    retained: [OK],
  },
  {
    name: 'the -A2 tree is owned',
    expectRemove: true,
    worktree: `${OWNED}-A2`,
    trees: [`${OWNED}-A2`],
    retained: [OK],
  },
  {
    name: 'a tree below WT_ROOT/sub is not directly under it',
    expectRemove: false,
    worktree: `sub/${OWNED}`,
    trees: [`sub/${OWNED}`],
    retained: [OK],
  },
  {
    name: 'a ../ escape that lands outside WT_ROOT is not owned',
    expectRemove: false,
    worktree: `../${OWNED}`,
    trees: [OWNED],
    retained: [OK],
  },
  {
    name: 'a ../ that resolves back into WT_ROOT is owned',
    expectRemove: true,
    worktree: `sub/../${OWNED}`,
    trees: [OWNED, 'sub'],
    retained: [OK],
  },
  {
    name: 'a trailing slash is still the owned tree',
    expectRemove: true,
    worktree: `${OWNED}/`,
    retained: [OK],
  },
  {
    name: 'doubled and dotted segments normalise',
    expectRemove: true,
    worktree: `./${OWNED}//.`,
    retained: [OK],
  },
  { name: 'an empty worktree is not owned', expectRemove: false, worktreeRaw: '', retained: [OK] },
  {
    name: 'a missing worktree key is treated as empty',
    expectRemove: false,
    omitWorktree: true,
    retained: [OK],
  },
  {
    name: 'the owned name is a symlink: refused before resolving',
    expectRemove: false,
    trees: [],
    links: { [OWNED]: 'elsewhere/real' },
    retained: [OK],
  },
  {
    // The link's target is the sibling `-A2` tree: owned, directly under the
    // root, a clean directory with a matching archive. Resolving the link
    // would make it removable, so only the raw-symlink refusal keeps it.
    name: 'a symlink to an otherwise eligible in-root tree is refused',
    expectRemove: false,
    trees: [`${OWNED}-A2`],
    links: { [OWNED]: `wt/${OWNED}-A2` },
    retained: [OK],
  },
  {
    name: 'a -A2 symlink to an otherwise eligible in-root tree is refused',
    expectRemove: false,
    worktree: `${OWNED}-A2`,
    trees: [OWNED],
    links: { [`${OWNED}-A2`]: `wt/${OWNED}` },
    retained: [OK],
  },
  {
    name: 'a symlink to an eligible in-root tree is refused under alternate too',
    expectRemove: false,
    alternate: true,
    trees: [`${OWNED}-A2`],
    links: { [OWNED]: `wt/${OWNED}-A2` },
    retained: [OK],
  },
  {
    name: 'a trailing slash does not hide a symlink to an eligible in-root tree',
    expectRemove: false,
    worktree: `${OWNED}/`,
    trees: [`${OWNED}-A2`],
    links: { [OWNED]: `wt/${OWNED}-A2` },
    retained: [OK],
  },
  {
    name: 'the -A2 name is a symlink',
    expectRemove: false,
    worktree: `${OWNED}-A2`,
    trees: [],
    links: { [`${OWNED}-A2`]: 'elsewhere/real' },
    retained: [OK],
  },
  {
    name: 'an owned name that does not exist is not a directory',
    expectRemove: false,
    trees: [],
    retained: [OK],
  },
  {
    name: 'a trailing slash on a symlinked name does not hide the link',
    expectRemove: false,
    worktree: `${OWNED}/`,
    trees: [],
    links: { [OWNED]: 'elsewhere/real' },
    retained: [OK],
  },
  {
    name: 'an item id with a dash still names the tree',
    expectRemove: true,
    itemId: 'pr-1-merged',
    trees: ['crq-repair-pr-1-merged-crq-R-F1'],
    worktree: 'crq-repair-pr-1-merged-crq-R-F1',
    retained: [OK],
  },
  // --- alternate retarget ---
  {
    name: 'alternate from the base tree targets -A2 (present)',
    expectRemove: true,
    alternate: true,
    trees: [OWNED, `${OWNED}-A2`],
    retained: [OK],
  },
  {
    name: 'alternate from the base tree: -A2 absent',
    expectRemove: false,
    alternate: true,
    retained: [OK],
  },
  {
    name: 'alternate from the -A2 tree targets the base tree',
    expectRemove: true,
    alternate: true,
    worktree: `${OWNED}-A2`,
    trees: [OWNED, `${OWNED}-A2`],
    retained: [OK],
  },
  {
    name: 'alternate target is a symlink',
    expectRemove: false,
    alternate: true,
    trees: [OWNED],
    links: { [`${OWNED}-A2`]: 'elsewhere/real' },
    retained: [OK],
  },
  {
    name: 'a job id ending in -A2 retargets to the same tree',
    expectRemove: true,
    alternate: true,
    jobId: 'crq-R-A2',
    worktree: `crq-repair-${ITEM}-crq-R-A2`,
    trees: [`crq-repair-${ITEM}-crq-R-A2`],
    retained: [OK],
  },
  {
    name: 'a job id ending in -A2: its own -A2 tree is owned',
    expectRemove: true,
    jobId: 'crq-R-A2',
    worktree: `crq-repair-${ITEM}-crq-R-A2-A2`,
    trees: [`crq-repair-${ITEM}-crq-R-A2-A2`],
    retained: [OK],
  },
  // --- dirty trees ---
  {
    name: 'a dirty tree is refused',
    expectRemove: false,
    status: { rc: 0, out: ' M file\n' },
    retained: [OK],
  },
  {
    name: 'an ignored-only tree is refused',
    expectRemove: false,
    status: { rc: 0, out: '!! build/\n' },
    retained: [OK],
  },
  {
    name: 'a failing status is refused',
    expectRemove: false,
    status: { rc: 128, out: '' },
    retained: [OK],
  },
  {
    name: 'a failing status with output is refused',
    expectRemove: false,
    status: { rc: 1, out: 'fatal' },
    retained: [OK],
  },
  {
    name: 'alternate asks about the alternate tree, not the named one',
    expectRemove: false,
    alternate: true,
    trees: [OWNED, `${OWNED}-A2`],
    status: { rc: 0, out: '?? x\n' },
    retained: [OK],
  },
  // --- archive matching ---
  { name: 'no retained directory at all', expectRemove: false },
  {
    name: 'a snapshot directly under the job directory',
    expectRemove: true,
    retained: [{ under: '', tweak: 'ok' }],
  },
  {
    name: 'a snapshot nested several directories down',
    expectRemove: true,
    retained: [{ under: 'a/b/c', tweak: 'ok' }],
  },
  {
    name: 'HEAD moved since the snapshot',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'head' }],
  },
  {
    name: 'the snapshot is for another base',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'base' }],
  },
  {
    name: 'the result has no repair_base',
    expectRemove: false,
    result: { repair_base: undefined },
    retained: [OK],
  },
  {
    name: 'an archive digest differs',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'archive-digest' }],
  },
  {
    name: 'an archive file is missing',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'archive-missing' }],
  },
  {
    name: 'a malformed manifest is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'malformed' }],
  },
  {
    name: 'a non-object manifest is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'not-object' }],
  },
  {
    name: 'a manifest under the wrong content token is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'bad-token' }],
  },
  {
    name: 'a manifest without sha256 is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'no-sha256' }],
  },
  {
    name: 'a list sha256 is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'sha256-list' }],
  },
  {
    name: 'a sha256 map missing an archive is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'sha256-missing-name' }],
  },
  {
    name: 'a non-string archive digest is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'sha256-non-string' }],
  },
  {
    name: 'a manifest without head is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'no-head' }],
  },
  {
    name: 'a manifest without base is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'no-base' }],
  },
  {
    name: 'a BOM-prefixed manifest is malformed JSON',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'bom' }],
  },
  {
    name: 'an invalid-UTF-8 manifest is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'invalid-utf8' }],
  },
  {
    name: 'manifest.json that is a directory is skipped',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'manifest-is-directory' }],
  },
  {
    name: 'a bad snapshot does not hide a later good one',
    expectRemove: true,
    retained: [
      { under: 'a', tweak: 'head' },
      { under: 'b', tweak: 'archive-digest' },
      { under: 'c', tweak: 'ok' },
    ],
  },
  {
    name: 'a good snapshot is enough beside many bad ones',
    expectRemove: true,
    retained: [
      { under: 'a', tweak: 'ok' },
      { under: 'b', tweak: 'malformed' },
    ],
  },
  {
    name: 'only bad snapshots',
    expectRemove: false,
    retained: [
      { under: 'a', tweak: 'head' },
      { under: 'b', tweak: 'base' },
    ],
  },
  {
    name: 'a NaN field is a valid JSON document with its own token',
    expectRemove: true,
    retained: [{ under: 'final', tweak: 'nan-field' }],
  },
  {
    name: 'non-ASCII manifest text tokens as ensure_ascii escapes',
    expectRemove: true,
    retained: [{ under: 'final', tweak: 'unicode-extra' }],
  },
  {
    name: 'a numeric base equals a float repair_base (1 == 1.0)',
    expectRemove: true,
    result: { repair_base: 1.0 },
    retained: [{ under: 'final', tweak: 'float-base' }],
  },
  {
    name: 'a numeric base does not equal a string repair_base',
    expectRemove: false,
    retained: [{ under: 'final', tweak: 'float-base' }],
  },
  {
    name: 'a boolean repair_base equals a numeric base 1 (True == 1)',
    expectRemove: true,
    result: { repair_base: true },
    retained: [{ under: 'final', tweak: 'float-base' }],
  },
  // --- escaping failures ---
  {
    name: 'a failing git rev-parse raises RuntimeError',
    expectRemove: false,
    headError: 'git rev-parse failed: not a repo',
    retained: [OK],
  },
  {
    name: 'a numeric worktree raises TypeError',
    expectRemove: false,
    worktreeRaw: 5,
    retained: [OK],
  },
  {
    name: 'a null worktree raises TypeError',
    expectRemove: false,
    worktreeRaw: null,
    retained: [OK],
  },
  {
    name: 'a list worktree raises TypeError',
    expectRemove: false,
    worktreeRaw: [],
    retained: [OK],
  },
  {
    name: 'a float worktree raises TypeError',
    expectRemove: false,
    worktreeRaw: 1.5,
    retained: [OK],
  },
  {
    name: 'an integral float worktree (1.0) raises TypeError naming float',
    expectRemove: false,
    worktreeJson: '1.0',
    retained: [OK],
  },
  {
    name: 'an exponent float worktree (1e21) raises TypeError naming float',
    expectRemove: false,
    worktreeJson: '1e21',
    retained: [OK],
  },
  {
    name: 'an integer worktree from JSON text raises TypeError naming int',
    expectRemove: false,
    worktreeJson: '12345678901234567890',
    retained: [OK],
  },
  {
    name: 'a boolean worktree raises TypeError',
    expectRemove: false,
    worktreeRaw: true,
    retained: [OK],
  },
  {
    name: 'a non-cleanable verdict never inspects the worktree type',
    expectRemove: false,
    worktreeRaw: 5,
    result: { verdict: 'FAILED' },
  },
];

describe('repair cleanup eligibility (Python cleanup_harvested vs the TS decision)', () => {
  it('has unique scenario names', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // One Python process for the whole table; each scenario is then compared on its own.
  // `beforeAll` runs whenever any test of the suite does, so `-t 'parity: ...'`
  // still has its oracle answers; the stub records a removal and never runs one.
  const fixtures = SCENARIOS.map((scenario) => ({ scenario, fixture: build(scenario) }));
  let python: Seen[] = [];
  beforeAll(() => {
    python = runPython(fixtures);
  });

  it('ran the Python oracle once with command/git stubbed (no removal can happen)', () => {
    expect(python).toHaveLength(SCENARIOS.length);
    for (const seen of python) {
      // The recorded "remove" is the only trace of the mutation, and it is a stub.
      expect(seen.removed.length).toBeLessThanOrEqual(1);
    }
  });

  for (const [index, { scenario, fixture }] of fixtures.entries()) {
    it(`parity: ${scenario.name}`, async () => {
      const py = python[index];
      if (py === undefined) throw new Error('python oracle did not run');
      const ts = await runTs(scenario, fixture);
      if (py.error !== undefined) {
        // An escaping Python failure is the same class and text on the TS side.
        expect(ts.error?.kind).toBe(py.error);
        expect(ts.error?.message).toBe(py.message);
        expect(ts.decision).toBeUndefined();
      } else {
        expect(ts.error).toBeUndefined();
        const decision = ts.decision;
        expect(decision?.remove).toBe(py.returned);
        expect(decision?.remove).toBe(scenario.expectRemove);
        if (decision?.remove) {
          expect(py.removed).toEqual([decision.worktree]);
        } else {
          expect(py.removed).toEqual([]);
        }
      }
      // The same trees were asked about, in the same order of questions.
      expect(ts.trace.statusCwd).toEqual(py.statusCwd);
      expect(ts.trace.headCwd).toEqual(py.headCwd);
    });
  }
});

describe('repair cleanup eligibility: ordering and laziness', () => {
  it('asks no Git question once a cheaper check refuses', async () => {
    for (const scenario of [
      { name: 'verdict', expectRemove: false, result: { verdict: 'FAILED' }, retained: [OK] },
      {
        name: 'owned',
        expectRemove: false,
        worktree: 'crq-repair-nope',
        trees: ['crq-repair-nope'],
        retained: [OK],
      },
      { name: 'gone', expectRemove: false, trees: [], retained: [OK] },
    ] satisfies Scenario[]) {
      const fixture = build(scenario);
      const ts = await runTs(scenario, fixture);
      expect(ts.decision?.remove).toBe(false);
      expect(ts.trace.statusCwd).toEqual([]);
      expect(ts.trace.headCwd).toEqual([]);
    }
  });

  it('refuses a symlinked worktree without ever resolving it', async () => {
    const scenario: Scenario = {
      name: 'link',
      expectRemove: false,
      trees: [`${OWNED}-A2`],
      links: { [OWNED]: `wt/${OWNED}-A2` },
      retained: [OK],
    };
    const fixture = build(scenario);
    const ts = await runTs(scenario, fixture);
    expect(ts.decision).toEqual({ remove: false, reason: 'worktree-symlink' });
    // Only WT_ROOT was resolved; the link itself never was.
    expect(ts.trace.resolved).toEqual([fixture.wtRoot]);
    expect(ts.trace.statusCwd).toEqual([]);
  });

  it('reads HEAD only after a clean status, and archives only after head/base match', async () => {
    const dirty: Scenario = {
      name: 'dirty',
      expectRemove: false,
      status: { rc: 0, out: ' M x' },
      retained: [OK],
    };
    const dirtyRun = await runTs(dirty, build(dirty));
    expect(dirtyRun.trace.statusCwd).toHaveLength(1);
    expect(dirtyRun.trace.headCwd).toEqual([]);
    const moved: Scenario = {
      name: 'moved',
      expectRemove: false,
      retained: [{ under: 'final', tweak: 'head' }],
    };
    const movedRun = await runTs(moved, build(moved));
    expect(movedRun.trace.headCwd).toHaveLength(1);
    expect(movedRun.trace.archiveReads).toEqual([]);
  });

  it('stops hashing at the first mismatching archive, in verification order', async () => {
    const scenario: Scenario = {
      name: 'digest',
      expectRemove: false,
      retained: [{ under: 'final', tweak: 'archive-digest' }],
    };
    const run = await runTs(scenario, build(scenario));
    expect(run.trace.archiveReads.map((r) => r.split('/')[1])).toEqual([
      'staged.patch',
      'unstaged.patch',
      'committed.patch',
      'untracked.tar',
    ]);
  });

  it('stops at the first valid snapshot', async () => {
    const scenario: Scenario = { name: 'first', expectRemove: true, retained: [OK] };
    const run = await runTs(scenario, build(scenario));
    expect(run.trace.archiveReads).toHaveLength(RETAINED_ARCHIVES.length);
  });

  it('returns the worktree to remove, never removing it itself', async () => {
    const scenario: Scenario = {
      name: 'ok',
      expectRemove: true,
      alternate: true,
      trees: [OWNED, `${OWNED}-A2`],
      retained: [OK],
    };
    const fixture = build(scenario);
    const run = await runTs(scenario, fixture);
    expect(run.decision).toEqual({ remove: true, worktree: join(fixture.wtRoot, `${OWNED}-A2`) });
    expect(statSync(join(fixture.wtRoot, `${OWNED}-A2`)).isDirectory()).toBe(true);
  });

  it('propagates a non-skippable probe failure from an archive read', async () => {
    const scenario: Scenario = { name: 'boom', expectRemove: false, retained: [OK] };
    const fixture = build(scenario);
    const probes = probesFor(scenario, fixture, {
      resolved: [],
      statusCwd: [],
      headCwd: [],
      archiveReads: [],
    });
    const boom = new PyError('RuntimeError', 'archive probe exploded');
    const failing: RepairCleanupProbes = {
      ...probes,
      retainedManifests: async (directory) =>
        (await probes.retainedManifests(directory)).map((record) => ({
          ...record,
          archiveDigest: () => Promise.reject(boom),
        })),
    };
    await expect(decideRepairCleanup(fixture.request, failing)).rejects.toBe(boom);
  });
});

describe('normalizePosixPath', () => {
  it.each([
    ['', '.'],
    ['.', '.'],
    ['./', '.'],
    ['a/b', 'a/b'],
    ['a//b/', 'a/b'],
    ['./a/./b', 'a/b'],
    ['/', '/'],
    ['//', '//'],
    ['///', '/'],
    ['//a', '//a'],
    ['///a', '/a'],
    ['/a/b/', '/a/b'],
    ['a/../b', 'a/../b'],
  ])('%j -> %j (PurePosixPath)', (input, expected) => {
    expect(normalizePosixPath(input)).toBe(expected);
  });

  it('matches PurePosixPath for the same inputs', () => {
    const inputs = [
      '',
      '.',
      './',
      'a/b',
      'a//b/',
      './a/./b',
      '/',
      '//',
      '///',
      '//a',
      '///a',
      '/a/b/',
      'a/../b',
    ];
    const out = execFileSync(
      'python3',
      [
        '-I',
        '-c',
        'import sys, json\nfrom pathlib import PurePosixPath\nprint(json.dumps([str(PurePosixPath(p)) for p in json.loads(sys.argv[1])]))',
        JSON.stringify(inputs),
      ],
      { encoding: 'utf8' },
    );
    expect(inputs.map(normalizePosixPath)).toEqual(JSON.parse(out) as string[]);
  });
});
