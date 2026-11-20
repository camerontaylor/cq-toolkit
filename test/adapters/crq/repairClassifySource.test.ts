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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileRepairClassifyJob,
  osErrorText,
  type RunGitSync,
} from '../../../src/adapters/crq/repairClassifySource.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
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

function caseNamed(name: string): JsonObject {
  const entry = drainCases.find((candidate) => candidate.get('name') === name);
  if (entry === undefined) throw new Error(`missing fixture case ${name}`);
  return entry;
}

const spawnFailure = (code: string): Error =>
  Object.assign(new Error(`spawnSync git ${code}`), { code });

describe('fileRepairClassifyJob git execution failures', () => {
  // Python's `command()` raises when git cannot run or times out, so the drain
  // errors and the job stays queued; only a completed non-zero exit is the
  // ordinary "absent" observation that may become a terminal stale result.
  const failing = [
    'prepared-run', // rev-parse origin/main, then <sha>:<path> (checkedBlob)
    'legacy-default-source-changed', // pin blob, then origin/main blob
    'legacy-open-pr-head-on-default', // pin blob, then merge-base --is-ancestor
    'legacy-open-pr-branch-other-same-blob', // branch head, then head blob
  ];
  for (const name of failing) {
    const entry = caseNamed(name);
    const reads = arr(entry.get('git_reads')).map((read) => str(read));
    for (const [index, read] of reads.entries()) {
      for (const code of ['ENOENT', 'EAGAIN', 'ETIMEDOUT']) {
        it(`rejects ${name} when git read ${String(index)} (${read.slice(0, 24)}) fails with ${code}`, async () => {
          materialize(entry);
          const { run } = fixtureGit(entry);
          let seen = 0;
          const guarded: RunGitSync = (args) => {
            const at = seen;
            seen += 1;
            if (at === index) return { status: null, stdout: '', error: spawnFailure(code) };
            return run(args);
          };
          await expect(
            fileRepairClassifyJob({ stateRoot: state, clone: '/clone', runGitSync: guarded })(
              obj(entry.get('queue')),
              str(entry.get('job_id')),
            ),
          ).rejects.toThrow(/could not run/u);
        });
      }
    }
  }

  it('rejects a branch-gone probe that failed to run, where a clean miss is stale', async () => {
    const entry = caseNamed('legacy-open-pr-branch-gone');
    materialize(entry);
    const clean = fixtureGit(entry);
    const ok = await fileRepairClassifyJob({
      stateRoot: state,
      clone: '/clone',
      runGitSync: clean.run,
    })(obj(entry.get('queue')), str(entry.get('job_id')));
    expect(ok).toMatchObject({
      status: 'stale',
      reason: 'PR branch is gone from origin (closed or deleted)',
    });
    const { run } = fixtureGit(entry);
    const broken: RunGitSync = (args) =>
      args.includes('refs/remotes/origin/feat/x^{commit}')
        ? { status: null, stdout: '', error: spawnFailure('ENOENT') }
        : run(args);
    await expect(
      fileRepairClassifyJob({ stateRoot: state, clone: '/clone', runGitSync: broken })(
        obj(entry.get('queue')),
        str(entry.get('job_id')),
      ),
    ).rejects.toThrow(/could not run/u);
  });

  it('keeps a completed non-zero exit as the ordinary stale observation', async () => {
    const entry = caseNamed('legacy-run-binds-pin');
    materialize(entry);
    const result = await fileRepairClassifyJob({
      stateRoot: state,
      clone: '/clone',
      runGitSync: () => ({ status: 1, stdout: '' }),
    })(obj(entry.get('queue')), str(entry.get('job_id')));
    expect(result).toMatchObject({
      status: 'stale',
      reason: 'finding path is absent at the job pin',
    });
  });

  it('rejects, not stale, when the real git binary cannot be spawned', async () => {
    const entry = caseNamed('legacy-run-binds-pin');
    materialize(entry);
    vi.stubEnv('PATH', join(root, 'no-such-bin'));
    try {
      await expect(
        fileRepairClassifyJob({ stateRoot: state, clone: root })(
          obj(entry.get('queue')),
          str(entry.get('job_id')),
        ),
      ).rejects.toThrow(/could not run/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('fileRepairClassifyJob JSON read semantics', () => {
  const legacy = () => caseNamed('legacy-run-binds-pin');
  const classifyFixture = (entry: JsonObject) => {
    const { run } = fixtureGit(entry);
    return fileRepairClassifyJob({ stateRoot: state, clone: '/clone', runGitSync: run })(
      obj(entry.get('queue')),
      str(entry.get('job_id')),
    );
  };

  it('keeps NaN, Infinity and -Infinity in a job as Python json.loads does', async () => {
    const entry = legacy();
    const target = join(state, 'repair', 'inbox', `${str(entry.get('job_id'))}.json`);
    writeFileSync(
      target,
      text(obj(entry.get('job'))).replace(
        '{\n',
        '{\n  "nan": NaN,\n  "up": Infinity,\n  "down": -Infinity,\n',
      ),
    );
    const result = await classifyFixture(entry);
    // Python: ('run', job, '') with the constants kept as floats.
    expect(result.status).toBe('run');
    expect(result.reason).toBe('');
    const job = obj(result.job as JsonValue);
    const nan = job.get('nan');
    expect(nan instanceof JsonNumber && Number.isNaN(nan.float)).toBe(true);
    expect((job.get('up') as JsonNumber).float).toBe(Number.POSITIVE_INFINITY);
    expect((job.get('down') as JsonNumber).float).toBe(Number.NEGATIVE_INFINITY);
  });

  it('keeps non-finite constants in a canonical triage row', async () => {
    const entry = caseNamed('severity-minor-canonical-delivered');
    materialize(entry);
    const fid = str(obj(entry.get('job')).get('canonical_finding_id'));
    writeFileSync(
      join(state, 'backfill', 'findings', 'triage', `${fid}.json`),
      `{"status": "delivered", "receipt": {"repair_task": ${JSON.stringify(
        str(entry.get('job_id')),
      )}, "n": NaN, "m": -Infinity}}`,
    );
    const result = await classifyFixture(entry);
    // Python: json.loads accepts the row, so delivery is confirmed: ('run', job, '').
    expect(result).toMatchObject({ status: 'run', reason: '' });
  });

  it('refuses a leading BOM on the job file and the triage row, as read_text + json.loads do', async () => {
    // Counterfactual: the same job without a BOM runs.
    materialize(legacy());
    expect((await classifyFixture(legacy())).status).toBe('run');
    const bomJob = caseNamed('job-bom');
    materialize(bomJob);
    expect(await classifyFixture(bomJob)).toEqual({
      status: 'skip',
      job: null,
      reason:
        'unreadable job: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)',
    });
  });
});

describe('osErrorText', () => {
  it.each([
    ['ENFILE', 23, 'Too many open files in system'],
    ['EFAULT', 14, 'Bad address'],
    ['EOVERFLOW', 75, 'Value too large for defined data type'],
    ['ENOMEM', 12, 'Cannot allocate memory'],
  ])('renders %s as CPython does', (code, errno, message) => {
    expect(osErrorText(Object.assign(new Error('x'), { code }), '/a/b')).toBe(
      `[Errno ${String(errno)}] ${message}: '/a/b'`,
    );
  });
});
