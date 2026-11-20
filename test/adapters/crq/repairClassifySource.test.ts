/**
 * Differential for the drain's `classifyJob` file/git binding.
 *
 * Every `drain` case of the Python-generated selection fixture
 * (`apps/crq-python/fixtures/crq-repair-selection/cases.json`, produced by the
 * production `bounded.drain_job`) is materialised as a real temp state tree
 * (inbox file, triage row, started marker) plus an injected synchronous git, so
 * the binding is compared with Python's status, reason prose, job bytes and
 * ordered git reads. Extra cases cover the filesystem facts the fixture
 * cannot: a symlinked inbox target, a directory in place of the file, invalid
 * UTF-8 and a failing tip read.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileRepairClassifyJob,
  type RunGitSync,
} from '../../../src/adapters/crq/repairClassifySource.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';

const fixture = obj(
  parseJsonValue(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/crq-repair-selection/cases.json', import.meta.url),
      'utf8',
    ),
  ),
);
const drainCases = arr(fixture.get('cases'))
  .map(obj)
  .filter((entry) => entry.get('kind') === 'drain');

function obj(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('fixture value is not an object');
  return value;
}
function arr(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('fixture value is not an array');
  return value;
}
function str(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('fixture value is not a string');
  return value;
}
const optStr = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const text = (value: JsonValue): string =>
  pythonJsonText(value, { asciiOnly: true, sortKeys: false, indent: 2, trailingNewline: true });

/** Canonical bytes: the fixture's `job` is key-sorted, `job_keys` carries the real order. */
const canon = (value: JsonValue): string =>
  pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: 2,
    trailingNewline: true,
  });

let root: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'classify-source-'));
  state = join(root, 'state');
  mkdirSync(join(state, 'repair', 'inbox'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A synchronous git that answers from the fixture's injected state. */
function fixtureGit(entry: JsonObject): { run: RunGitSync; reads: string[] } {
  const spec = obj(entry.get('git'));
  const blobs = obj(spec.get('blobs'));
  const branches = obj(spec.get('branches'));
  const ancestors = new Set(
    arr(spec.get('ancestors')).map((pair) => {
      const [a, b] = arr(pair);
      return `${str(a)}\u0000${str(b)}`;
    }),
  );
  const reads: string[] = [];
  const ok = (stdout: string) => ({ status: 0, stdout: `${stdout}\n` });
  const miss = { status: 1, stdout: '' };
  const run: RunGitSync = (args) => {
    reads.push(args.join(' '));
    const [verb, ...rest] = args;
    if (verb === 'merge-base') {
      return ancestors.has(`${rest[1] ?? ''}\u0000${rest[2] ?? ''}`)
        ? { status: 0, stdout: '' }
        : { status: 1, stdout: '' };
    }
    const quiet = rest[0] === '--verify';
    const name = quiet ? (rest[2] ?? '') : (rest[0] ?? '');
    if (name === 'origin/main') return ok(str(spec.get('tip')));
    const branch = /^refs\/remotes\/origin\/(.*)\^\{commit\}$/u.exec(name)?.[1];
    if (branch !== undefined) {
      const head = optStr(branches.get(branch));
      return head === undefined ? miss : ok(head);
    }
    const blob = optStr(blobs.get(name));
    return blob === undefined ? miss : ok(blob);
  };
  return { run, reads };
}

function materialize(entry: JsonObject): void {
  const jobId = str(entry.get('job_id'));
  const raw = entry.get('job_raw');
  const job = entry.get('job');
  const target = join(state, 'repair', 'inbox', `${jobId}.json`);
  if (typeof raw === 'string') writeFileSync(target, raw);
  else if (job !== undefined && job !== null) writeFileSync(target, text(job));
  const fid = job instanceof JsonObject ? job.get('canonical_finding_id') : undefined;
  if (typeof fid === 'string' && fid !== '') {
    const rowRaw = entry.get('triage_row_raw');
    const row = entry.get('triage_row');
    const dir = join(state, 'backfill', 'findings', 'triage');
    mkdirSync(dir, { recursive: true });
    if (typeof rowRaw === 'string') writeFileSync(join(dir, `${fid}.json`), rowRaw);
    else if (row !== undefined && row !== null) writeFileSync(join(dir, `${fid}.json`), text(row));
  }
  if (entry.get('started') === true) {
    mkdirSync(join(state, 'repair', jobId), { recursive: true });
    writeFileSync(join(state, 'repair', jobId, 'progress.json'), '{"attempts": []}');
  }
}

/** Cases whose Python tail is a `json.JSONDecodeError` message. */
const JSON_SYNTAX_CASES = new Set(['job-unreadable-json']);

describe('fileRepairClassifyJob against the Python drain_job oracle', () => {
  for (const entry of drainCases) {
    const name = str(entry.get('name'));
    it(`matches Python for ${name}`, async () => {
      materialize(entry);
      const { run, reads } = fixtureGit(entry);
      const classify = fileRepairClassifyJob({
        stateRoot: state,
        clone: '/clone',
        runGitSync: run,
      });
      const actual = await classify(obj(entry.get('queue')), str(entry.get('job_id')));
      const expected = obj(entry.get('expected'));
      expect(actual.status).toBe(str(expected.get('status')));
      const reason = str(expected.get('reason')).replaceAll('<state-root>', root);
      if (JSON_SYNTAX_CASES.has(name)) {
        // Documented deviation: the parser's wording, not CPython's tail.
        expect(actual.reason.startsWith('unreadable job: ')).toBe(true);
      } else {
        expect(actual.reason).toBe(reason);
      }
      const job = actual.job;
      expect(job === null ? null : canon(job)).toBe(
        expected.get('job') === null ? null : canon(expected.get('job') as JsonValue),
      );
      expect(job === null ? null : job.entries.map(([key]) => key)).toEqual(
        expected.get('job_keys') === null
          ? null
          : arr(expected.get('job_keys')).map((key) => str(key)),
      );
      expect(reads).toEqual(arr(entry.get('git_reads')).map((read) => str(read)));
    });
  }
});

describe('fileRepairClassifyJob filesystem facts', () => {
  const queue = new JsonObject([['items', []]]);
  const idle: RunGitSync = () => ({ status: 1, stdout: '' });
  const classify = () =>
    fileRepairClassifyJob({ stateRoot: state, clone: '/clone', runGitSync: idle });

  it('refuses a symlinked inbox file like job_path', async () => {
    writeFileSync(join(root, 'elsewhere.json'), '{}');
    symlinkSync(join(root, 'elsewhere.json'), join(state, 'repair', 'inbox', 'crq-a-F1.json'));
    expect(await classify()(queue, 'crq-a-F1')).toEqual({
      status: 'skip',
      job: null,
      reason: 'unreadable job: job path outside inbox',
    });
  });

  it('refuses a dangling symlink the same way', async () => {
    symlinkSync(join(root, 'nowhere.json'), join(state, 'repair', 'inbox', 'crq-a-F1.json'));
    expect((await classify()(queue, 'crq-a-F1')).reason).toBe(
      'unreadable job: job path outside inbox',
    );
  });

  it('renders a directory in place of the file as EISDIR', async () => {
    mkdirSync(join(state, 'repair', 'inbox', 'crq-a-F1.json'));
    expect((await classify()(queue, 'crq-a-F1')).reason).toBe(
      `unreadable job: [Errno 21] Is a directory: '${join(state, 'repair', 'inbox', 'crq-a-F1.json')}'`,
    );
  });

  it('skips a job file that is not valid UTF-8', async () => {
    writeFileSync(join(state, 'repair', 'inbox', 'crq-a-F1.json'), Buffer.from([0xff, 0xfe]));
    const result = await classify()(queue, 'crq-a-F1');
    expect(result.status).toBe('skip');
    expect(result.job).toBeNull();
    expect(result.reason.startsWith('unreadable job: ')).toBe(true);
  });

  it('never touches the filesystem for an invalid job id', async () => {
    expect(await classify()(queue, '../escape')).toEqual({
      status: 'skip',
      job: null,
      reason: 'unreadable job: expected one exact CRQ job id',
    });
  });

  it('counts result.json as a started marker', async () => {
    const entry = drainCases.find(
      (candidate) => candidate.get('name') === 'legacy-resume-skips-source-drift',
    );
    if (entry === undefined) throw new Error('missing fixture case');
    const jobId = str(entry.get('job_id'));
    writeFileSync(join(state, 'repair', 'inbox', `${jobId}.json`), text(obj(entry.get('job'))));
    mkdirSync(join(state, 'repair', jobId), { recursive: true });
    writeFileSync(join(state, 'repair', jobId, 'result.json'), '{}');
    const { run, reads } = fixtureGit(entry);
    const result = await fileRepairClassifyJob({
      stateRoot: state,
      clone: '/clone',
      runGitSync: run,
    })(obj(entry.get('queue')), jobId);
    // Resumed: no stale probes, only the pinned-path read.
    expect(result.status).toBe(str(obj(entry.get('expected')).get('status')));
    expect(reads.length).toBeLessThanOrEqual(1);
  });

  it('rejects when the current-tip read fails, as Python propagates the git error', async () => {
    const entry = drainCases.find((candidate) => candidate.get('name') === 'prepared-run');
    if (entry === undefined) throw new Error('missing fixture case');
    materialize(entry);
    await expect(
      fileRepairClassifyJob({ stateRoot: state, clone: '/clone', runGitSync: idle })(
        obj(entry.get('queue')),
        str(entry.get('job_id')),
      ),
    ).rejects.toThrow('git rev-parse failed');
  });
});
