/**
 * Real-process acceptance test for the operator-only `crq repair-prepare` (F1).
 *
 * Every case spawns the SHIPPED binary (`dist/queue-runner/crq.js`) with
 * explicit roots and a working directory that is an unrelated empty temp dir.
 * This file imports nothing from `src/`, so it cannot call the composer
 * directly; the effects under test are real OS objects:
 *
 * - a real git repository rebuilt from the recorded file set, with a real
 *   `refs/remotes/origin/main` and a real blob for the finding path,
 * - real `state/queue.json`, inbox, triage and rollout files,
 * - the real atomic writer, the real flock (a competing Python child holds
 *   `tick.lock` for the busy case and `findings.lock` for the handoff race),
 * - the real denylist/gitleaks path.
 *
 * Expected job/queue/triage/outbox bytes come from the recorded Python oracle
 * `apps/crq-python/fixtures/crq-repair-prepare-live/cases.json`, produced by
 * the production `repair_tick.prepare_current_job` over the same deterministic
 * repository. The outbox event id embeds `occurred_at`, so the expected id is
 * re-derived from the observed timestamp.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, type Dirent } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/queue-runner/crq.js', import.meta.url));
const FIXTURE = new URL(
  '../../apps/crq-python/fixtures/crq-repair-prepare-live/cases.json',
  import.meta.url,
);

const CALLER_GATES = ['dispatch-request-construction', 'enqueue-dispatch', 'harvest-disposition'];
const CANONICAL = 'f'.repeat(64);

interface LiveCase {
  readonly job_id: string;
  readonly evidence: Record<string, unknown>;
  readonly old_job_canonical: string;
  readonly queue_input_canonical: string;
  readonly triage_input_canonical: string | null;
  readonly job_canonical: string;
  readonly queue_canonical: string;
  readonly triage_canonical: string | null;
  readonly outbox_canonical: string | null;
}

interface LiveFixture {
  readonly repository: {
    readonly message: string;
    readonly author_name: string;
    readonly author_email: string;
    readonly date: string;
    readonly files: Record<string, string>;
    readonly source_sha: string;
    readonly source_blob_sha: string;
  };
  readonly state: {
    readonly old_job_id: string;
    readonly item_id: string;
    readonly old_run: string;
    readonly historical_repair_base: string;
    readonly canonical_finding_id: string;
    readonly finding_sha256: string;
    readonly handoff_at: string;
    readonly clean_scan_report: unknown;
  };
  readonly cases: { readonly canonical: LiveCase; readonly non_canonical: LiveCase };
}

interface Artifact {
  readonly status?: string;
  readonly error?: string;
  readonly refusal?: string;
  readonly detail?: string;
  readonly value?: Record<string, unknown>;
}

const fixture = JSON.parse(readFileSync(new URL(FIXTURE), 'utf8')) as unknown as LiveFixture;

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'crq-repair-prepare-live-'));
  dirs.push(path);
  return path;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: fixture.repository.author_name,
    GIT_AUTHOR_EMAIL: fixture.repository.author_email,
    GIT_AUTHOR_DATE: fixture.repository.date,
    GIT_COMMITTER_NAME: fixture.repository.author_name,
    GIT_COMMITTER_EMAIL: fixture.repository.author_email,
    GIT_COMMITTER_DATE: fixture.repository.date,
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Rebuild the recorded repository; returns its object names. */
async function makeRepository(files: Record<string, string>): Promise<{
  repo: string;
  sourceSha: string;
  blobSha: string;
}> {
  const repo = await tempDir();
  for (const [relative, text] of Object.entries(files)) {
    const path = join(repo, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { encoding: 'utf8', mode: 0o644 });
    await chmod(path, 0o644);
  }
  git(repo, ['init', '-q', '--object-format=sha1', '-b', 'main', repo]);
  git(repo, ['-C', repo, '-c', 'core.autocrlf=false', 'add', '-A']);
  git(repo, ['-C', repo, 'commit', '-q', '-m', fixture.repository.message]);
  git(repo, ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const sourceSha = git(repo, ['-C', repo, 'rev-parse', 'origin/main']);
  const blobSha = git(repo, ['-C', repo, 'rev-parse', `${sourceSha}:src/lock.ts`]);
  return { repo, sourceSha, blobSha };
}

/** The recorded repository must reproduce the oracle object names exactly. */
async function fixtureRepository(): Promise<string> {
  const built = await makeRepository(fixture.repository.files);
  expect(built.sourceSha).toBe(fixture.repository.source_sha);
  expect(built.blobSha).toBe(fixture.repository.source_blob_sha);
  return built.repo;
}

interface StateRoots {
  readonly runnerRoot: string;
  readonly stateRoot: string;
  readonly evidencePath: string;
}

async function makeState(input: {
  repo: string;
  liveCase: LiveCase;
  triage: boolean;
  rollout: boolean;
  maxRounds?: number;
  evidenceSha?: string;
  evidenceBlob?: string;
  queue?: string;
}): Promise<StateRoots> {
  const base = await tempDir();
  const runnerRoot = join(base, 'runner');
  const stateRoot = join(base, 'state');
  await mkdir(runnerRoot, { recursive: true });
  await mkdir(join(stateRoot, 'repair', 'inbox'), { recursive: true });
  await writeFile(
    join(runnerRoot, 'config.json'),
    `${JSON.stringify({ clone: input.repo, repair: { max_rounds_per_pin: input.maxRounds ?? 2 } }, null, 2)}\n`,
  );
  await writeFile(
    join(stateRoot, 'queue.json'),
    input.queue ?? input.liveCase.queue_input_canonical,
  );
  await writeFile(
    join(stateRoot, 'repair', 'inbox', `${fixture.state.old_job_id}.json`),
    input.liveCase.old_job_canonical,
  );
  if (input.triage) {
    await mkdir(join(stateRoot, 'backfill', 'findings', 'triage'), { recursive: true });
    await writeFile(
      join(
        stateRoot,
        'backfill',
        'findings',
        'triage',
        `${fixture.state.canonical_finding_id}.json`,
      ),
      input.liveCase.triage_input_canonical ?? '',
    );
  }
  if (input.rollout) {
    await writeFile(
      join(stateRoot, 'backfill-rollout.json'),
      `${JSON.stringify({ durable_artifact_root: join(base, 'durable') }, null, 2)}\n`,
    );
  }
  const evidencePath = join(base, 'evidence.json');
  const evidence = {
    ...input.liveCase.evidence,
    ...(input.evidenceSha === undefined ? {} : { source_sha: input.evidenceSha }),
    ...(input.evidenceBlob === undefined ? {} : { source_blob_sha: input.evidenceBlob }),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { runnerRoot, stateRoot, evidencePath };
}

function argvFor(roots: StateRoots, sourceSha: string, extra: string[] = []): string[] {
  return [
    fixture.state.old_job_id,
    '--source-sha',
    sourceSha,
    '--revalidation',
    roots.evidencePath,
    '--runner-root',
    roots.runnerRoot,
    '--state-root',
    roots.stateRoot,
    ...extra,
  ];
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

interface CliRun {
  readonly status: number | null;
  readonly artifact: Artifact;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[], cwd: string): CliRun {
  const result = spawnSync(process.execPath, [CLI, 'repair-prepare', ...args], {
    cwd,
    encoding: 'utf8',
    env: cliEnv(),
    timeout: 90_000,
  });
  const stdout = result.stdout ?? '';
  const lines = stdout.trimEnd() === '' ? [] : stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return {
    status: result.status,
    artifact: JSON.parse(lines[0] ?? '{}') as Artifact,
    stdout,
    stderr: result.stderr ?? '',
  };
}

async function emptyCwd(): Promise<string> {
  return tempDir();
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(relative: string): Promise<void> {
    const directory = join(root, relative);
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const path = join(relative, child.name);
      if (child.isDirectory()) {
        entries[`${path}/`] = '';
        await walk(path);
      } else {
        entries[path] = (await readFile(join(root, path))).toString('base64');
      }
    }
  }
  await walk('');
  return entries;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A refusal still acquires and releases the real `tick.lock`, so the lock file
 * is an allowed artifact: "no writes" means no job, queue or handoff bytes.
 */
function withoutLock(entries: Record<string, string>): Record<string, string> {
  const { ['tick.lock']: _lock, ...rest } = entries;
  return rest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Kill and await one background child. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

describe('crq repair-prepare through the shipped binary', () => {
  it('prepares a canonical job, queue and handoff byte-identically to the Python oracle', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.canonical;
    const roots = await makeState({ repo, liveCase: live, triage: true, rollout: true });
    const cwd = await emptyCwd();

    const run = runCli(argvFor(roots, fixture.repository.source_sha), cwd);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.artifact.status).toBe('ok');
    expect(run.artifact.value?.['jobId']).toBe(live.job_id);
    expect(run.artifact.value?.['remainingGates']).toEqual(CALLER_GATES);

    expect(
      await readFile(join(roots.stateRoot, 'repair', 'inbox', `${live.job_id}.json`), 'utf8'),
    ).toBe(live.job_canonical);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(live.queue_canonical);

    const pendingDir = join(roots.stateRoot, 'backfill', 'publication', 'pending');
    const pending = await readdir(pendingDir);
    expect(pending).toHaveLength(1);
    const eventText = await readFile(join(pendingDir, pending[0]!), 'utf8');
    const observed = JSON.parse(eventText) as {
      id: string;
      occurred_at: string;
      [key: string]: unknown;
    };
    expect(observed.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    const template = live.outbox_canonical ?? '';
    const templateId = (JSON.parse(template) as { id: string }).id;
    const withObservedTime = template.replace(
      `"occurred_at":"${fixture.state.handoff_at}"`,
      `"occurred_at":"${observed.occurred_at}"`,
    );
    const canonicalWithoutId = withObservedTime.replace(/,"id":"[0-9a-f]{64}"/, '');
    expect(sha256(canonicalWithoutId)).toBe(observed.id);
    expect(pending[0]).toBe(`${observed.id}.json`);
    expect(eventText).toBe(withObservedTime.replace(templateId, observed.id));

    const triageText = await readFile(
      join(roots.stateRoot, 'backfill', 'findings', 'triage', `${CANONICAL}.json`),
      'utf8',
    );
    expect(triageText).toBe((live.triage_canonical ?? '').replace(templateId, observed.id));
    expect(
      (JSON.parse(triageText) as { receipt: { repair_task: string } }).receipt.repair_task,
    ).toBe(live.job_id);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('prepares a non-canonical job without any rollout file and writes no handoff', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.non_canonical;
    const roots = await makeState({ repo, liveCase: live, triage: false, rollout: false });

    const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
    expect(run.status).toBe(0);
    expect(run.artifact.status).toBe('ok');
    expect(run.artifact.value?.['jobId']).toBe(live.job_id);
    expect(run.artifact.value?.['handoff']).toBeUndefined();
    expect(
      await readFile(join(roots.stateRoot, 'repair', 'inbox', `${live.job_id}.json`), 'utf8'),
    ).toBe(live.job_canonical);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(live.queue_canonical);
    expect(await exists(join(roots.stateRoot, 'backfill'))).toBe(false);
  });

  it('re-runs idempotently: same job, same bytes, one event, already handed off', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.canonical;
    const roots = await makeState({ repo, liveCase: live, triage: true, rollout: true });
    const cwd = await emptyCwd();
    const argv = argvFor(roots, fixture.repository.source_sha);

    expect(runCli(argv, cwd).status).toBe(0);
    const jobPath = join(roots.stateRoot, 'repair', 'inbox', `${live.job_id}.json`);
    const firstJob = await readFile(jobPath, 'utf8');
    const firstQueue = await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
    const pendingDir = join(roots.stateRoot, 'backfill', 'publication', 'pending');
    const firstPending = await readdir(pendingDir);
    const triagePath = join(roots.stateRoot, 'backfill', 'findings', 'triage', `${CANONICAL}.json`);
    const firstTriage = await readFile(triagePath, 'utf8');

    const second = runCli(argv, cwd);
    expect(second.status).toBe(0);
    expect(second.artifact.status).toBe('ok');
    expect(second.artifact.value?.['jobId']).toBe(live.job_id);
    expect(second.artifact.value?.['handoff']).toEqual({ result: 'already-handed-off' });
    expect(await readFile(jobPath, 'utf8')).toBe(firstJob);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(firstQueue);
    expect(await readFile(triagePath, 'utf8')).toBe(firstTriage);
    expect(await readdir(pendingDir)).toEqual(firstPending);
  });

  it('exits 3 on a busy tick lock and creates or changes no path', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.non_canonical;
    const roots = await makeState({ repo, liveCase: live, triage: false, rollout: false });
    const lock = join(roots.stateRoot, 'tick.lock');
    await writeFile(lock, '');
    const child = spawn(
      'python3',
      [
        '-u',
        '-c',
        'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)',
        lock,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    await once(child.stdout!, 'data');
    const before = await snapshot(roots.stateRoot);

    const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
    expect(run.status).toBe(3);
    expect(run.artifact).toEqual({ status: 'failed', error: 'tick lock busy' });
    expect(await snapshot(roots.stateRoot)).toEqual(before);
    await stopChild(child);
  });

  it('refuses a dirty full-source scan with no writes', async () => {
    const dirtyFiles = {
      ...fixture.repository.files,
      'src/lock.ts': 'SECRET-ABCD\n',
    };
    const built = await makeRepository(dirtyFiles);
    const live = fixture.cases.non_canonical;
    const roots = await makeState({
      repo: built.repo,
      liveCase: live,
      triage: false,
      rollout: false,
      evidenceSha: built.sourceSha,
      evidenceBlob: built.blobSha,
    });
    const before = await snapshot(roots.stateRoot);

    const run = runCli(argvFor(roots, built.sourceSha), await emptyCwd());
    expect(run.status).toBe(1);
    expect(run.artifact).toMatchObject({
      status: 'failed',
      error: 'refused',
      refusal: 'source-secret-scan-failed',
    });
    expect(withoutLock(await snapshot(roots.stateRoot))).toEqual(before);
  });

  it('refuses the round ceiling with no writes', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.non_canonical;
    const queue = JSON.parse(live.queue_input_canonical) as {
      items: { repair_runs: Record<string, unknown> }[];
    };
    queue.items[0]!.repair_runs['revalidated-previous'] = {
      jobs: ['crq-previous-F1'],
      pin: fixture.repository.source_sha,
      base: fixture.repository.source_sha,
      state: 'done',
    };
    const roots = await makeState({
      repo,
      liveCase: live,
      triage: false,
      rollout: false,
      maxRounds: 1,
      queue: `${JSON.stringify(queue, null, 2)}\n`,
    });
    const before = await snapshot(roots.stateRoot);

    const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
    expect(run.status).toBe(1);
    expect(run.artifact).toMatchObject({
      status: 'failed',
      error: 'refused',
      refusal: 'round-ceiling',
    });
    expect(withoutLock(await snapshot(roots.stateRoot))).toEqual(before);
  });

  it.skipIf(process.getuid?.() === 0)(
    'leaves the prepared job inert when the queue write fails last',
    async () => {
      const repo = await fixtureRepository();
      const live = fixture.cases.canonical;
      const roots = await makeState({ repo, liveCase: live, triage: true, rollout: true });
      const queuePath = join(roots.stateRoot, 'queue.json');
      const queueBefore = await readFile(queuePath, 'utf8');
      await writeFile(join(roots.stateRoot, 'tick.lock'), '');
      await chmod(roots.stateRoot, 0o555);
      try {
        const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
        expect(run.status).toBe(1);
        expect(run.artifact).toMatchObject({
          status: 'indeterminate',
          detail: 'effect-failed',
          step: 'write-queue',
        });
        expect(
          await readFile(join(roots.stateRoot, 'repair', 'inbox', `${live.job_id}.json`), 'utf8'),
        ).toBe(live.job_canonical);
        expect(await readFile(queuePath, 'utf8')).toBe(queueBefore);
        const triage = JSON.parse(
          await readFile(
            join(roots.stateRoot, 'backfill', 'findings', 'triage', `${CANONICAL}.json`),
            'utf8',
          ),
        ) as { receipt: { repair_task: string }; status: string };
        expect(triage).toMatchObject({
          status: 'delivered',
          receipt: { repair_task: live.job_id },
        });
        // No `state: queued` run record exists, so the Python drain classifies
        // the job skip: it requires both the queued state and the job id.
        const queue = JSON.parse(queueBefore) as {
          items: { repair_runs: Record<string, { jobs?: string[]; state?: string }> }[];
        };
        const runs = Object.values(queue.items[0]?.repair_runs ?? {});
        expect(runs.some((run) => run.state === 'queued' && run.jobs?.includes(live.job_id))).toBe(
          false,
        );
      } finally {
        await chmod(roots.stateRoot, 0o755);
      }
    },
  );

  it('exits non-zero when the handoff lock revalidation finds a foreign owner', async () => {
    const repo = await fixtureRepository();
    const live = fixture.cases.canonical;
    const roots = await makeState({ repo, liveCase: live, triage: true, rollout: true });
    const findingsRoot = join(roots.stateRoot, 'backfill', 'findings');
    const lock = join(findingsRoot, 'findings.lock');
    const triagePath = join(findingsRoot, 'triage', `${CANONICAL}.json`);
    const inbox = join(roots.stateRoot, 'repair', 'inbox');
    const queueBefore = await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
    const script = [
      'import fcntl, json, os, sys, time',
      'lock, triage, inbox = sys.argv[1:4]',
      'handle = open(lock, "a+")',
      'fcntl.flock(handle, fcntl.LOCK_EX)',
      'print("ready", flush=True)',
      'names = set(os.listdir(inbox))',
      'deadline = time.time() + 30',
      'while time.time() < deadline:',
      '    if set(os.listdir(inbox)) - names:',
      '        row = json.load(open(triage))',
      '        row.setdefault("receipt", {})["repair_task"] = "crq-foreign-F1"',
      '        with open(triage, "w") as out:',
      '            json.dump(row, out)',
      '        break',
      '    time.sleep(0.01)',
      'fcntl.flock(handle, fcntl.LOCK_UN)',
      'handle.close()',
    ].join('\n');
    const child = spawn('python3', ['-u', '-c', script, lock, triagePath, inbox], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await once(child.stdout!, 'data');

    const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
    expect(run.status).toBe(1);
    expect(run.artifact).toMatchObject({
      status: 'failed',
      error: 'effect-failed',
      refusal: 'canonical-handoff-mismatch',
    });
    expect(await readFile(join(inbox, `${live.job_id}.json`), 'utf8')).toBe(live.job_canonical);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(queueBefore);
    await stopChild(child);
  });

  it('exits 2 on usage errors and writes nothing', async () => {
    const repo = await fixtureRepository();
    const roots = await makeState({
      repo,
      liveCase: fixture.cases.non_canonical,
      triage: false,
      rollout: false,
    });
    const before = await snapshot(roots.stateRoot);
    const missing = runCli([fixture.state.old_job_id], await emptyCwd());
    expect(missing.status).toBe(2);
    expect(missing.artifact).toMatchObject({
      error: { kind: 'usage', subcommand: 'repair-prepare', exitCode: 2 },
    });
    const unknown = runCli(
      argvFor(roots, fixture.repository.source_sha, ['--bogus', 'x']),
      await emptyCwd(),
    );
    expect(unknown.status).toBe(2);
    expect(unknown.artifact).toMatchObject({ error: { kind: 'usage', exitCode: 2 } });
    expect(await snapshot(roots.stateRoot)).toEqual(before);
  });

  it('refuses a config without a clone and writes nothing', async () => {
    const repo = await fixtureRepository();
    const roots = await makeState({
      repo,
      liveCase: fixture.cases.non_canonical,
      triage: false,
      rollout: false,
    });
    await writeFile(
      join(roots.runnerRoot, 'config.json'),
      `${JSON.stringify({ repair: {} }, null, 2)}\n`,
    );
    const before = await snapshot(roots.stateRoot);
    const run = runCli(argvFor(roots, fixture.repository.source_sha), await emptyCwd());
    expect(run.status).toBe(1);
    expect(run.artifact).toEqual({ status: 'failed', error: 'clone-missing' });
    expect(await snapshot(roots.stateRoot)).toEqual(before);
  });
});
