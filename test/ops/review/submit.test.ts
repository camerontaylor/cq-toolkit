import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, mkdir, access } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeSubmit } from '../../../src/ops/review/submit.js';
import { SnapshotSchema } from '../../../src/ops/review/internal/reviewOperation.js';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(hostname).mockReset();
});
const run = promisify(execFile);
let cwd: string;
const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const caps = {
  v: 1,
  command: 'review-v1',
  operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
  features: ['original-commit-snapshot-v1', 'chunked-result-v1'],
  limits: {
    max_request_bytes: 6291456,
    max_snapshot_bytes: 5242880,
    max_content_bytes: 3145728,
    max_objects: 4096,
    chunk_bytes: 3072,
  },
};
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cq-submit-'));
  await git('init', '-q', '--template=');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, '.gitignore'), '/.cq/\n');
  await writeFile(join(cwd, 'file'), 'base');
  await git('add', 'file', '.gitignore');
  await git('commit', '-qm', 'base');
  await git('branch', 'target');
});
test('submission sends the hostname-derived notification destination on the wire', async () => {
  const agent = '12345678-1234-1234-1234-123456789abc';
  vi.stubEnv('PASEO_AGENT_ID', agent);
  vi.stubEnv('CQ_REVIEW_NOTIFY_HOST', undefined);
  vi.mocked(hostname).mockReturnValue('triton');
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const submissions: unknown[] = [];
  const result = await makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as { op: string };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    submissions.push(wire);
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  })({ cwd, repo: 'owner/repo', target: 'target', reachable: true });
  expect(result.status).toBe('ok');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    op: 'submit',
    notify: { paseo_agent_id: agent, paseo_host: 'triton:6767' },
  });
});
test('empty committed diff avoids all network calls and reports exclusions', async () => {
  await writeFile(join(cwd, 'file'), 'staged');
  await git('add', 'file');
  await writeFile(join(cwd, 'file'), 'unstaged');
  const result = await makeSubmit(async () => {
    throw new Error('network forbidden');
  })({ cwd, repo: 'owner/repo', target: 'target' });
  expect(result).toMatchObject({
    status: 'ok',
    value: { action: 'no-changes', exclusions: { staged: 'file', unstaged: 'file' } },
  });
});
test('A-2 lost response retries the durable original request despite checkout movement; A-9 names reviewed head', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const head = await git('rev-parse', 'HEAD');
  let lost = true;
  const submissions: unknown[] = [];
  const op = makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as { op: string; request_id: string };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    const record = JSON.parse(
      await readFile(join(cwd, '.cq/queue-evidence/requests/request-one.json'), 'utf8'),
    ) as { wire: unknown };
    expect(record.wire).toEqual(wire);
    submissions.push(wire);
    if (lost) throw new Error('response lost');
    return JSON.stringify({ v: 1, action: 'joined', state: 'queued', request_id: wire.request_id });
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'request-one',
    reachable: true,
  };
  expect(await op(input)).toMatchObject({
    status: 'indeterminate',
    detail: expect.stringContaining('request-one') as unknown,
  });
  await git('commit', '--allow-empty', '-qm', 'moved');
  lost = false;
  const retry = { cwd, repo: input.repo, target: input.target, requestId: input.requestId };
  expect(await op(retry)).toMatchObject({
    status: 'ok',
    value: { reviewedHead: head, message: expect.stringContaining(head) as unknown },
  });
  expect(submissions[0]).toEqual(submissions[1]);
  expect(
    (await readdir(join(cwd, '.cq/queue-evidence/requests'))).filter(
      (x) => !x.includes('.response.'),
    ),
  ).toEqual(['request-one.json']);
});
test('snapshot contains the original commit, its parents and complete outgoing objects', async () => {
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(cwd, 'file'), 'middle');
  await git('add', 'file');
  await git('commit', '-qm', 'middle');
  const middle = await git('rev-parse', 'HEAD');
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const head = await git('rev-parse', 'HEAD');
  const scanner = join(cwd, 'scan');
  await writeFile(scanner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const op = makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as {
      op: string;
      inputs: { head_commit: string };
      snapshot: unknown;
    };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    const snapshot = SnapshotSchema.parse(wire.snapshot);
    expect(wire.inputs.head_commit).toBe(head);
    expect(
      snapshot.objects
        .filter((x) => x.type === 'commit')
        .map((x) => x.oid)
        .sort(),
    ).toEqual([head, middle].sort());
    expect(snapshot.objects.map((x) => x.oid)).not.toContain(base);
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  });
  const subdir = join(cwd, 'pkg');
  await mkdir(subdir);
  expect(
    await op({ cwd: subdir, repo: 'owner/repo', target: 'target', scanner, requestId: 'nested' }),
  ).toMatchObject({
    status: 'ok',
  });
  await expect(
    access(join(cwd, '.cq/queue-evidence/requests/nested.json')),
  ).resolves.toBeUndefined();
  await expect(access(join(subdir, '.cq'))).rejects.toThrow();
  expect(await git('status', '--porcelain', '--untracked-files=all')).not.toContain('.cq');
  expect(
    await op({ cwd, repo: 'owner/repo', target: 'target', requestId: 'nested' }),
  ).toMatchObject({ status: 'ok' });
});

test('persisted request exists before discovery, and conflicting key reuse makes no network call', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const op = makeSubmit(async (raw) => {
    const req = JSON.parse(raw) as { op: string };
    const saved = JSON.parse(
      await readFile(join(cwd, '.cq/queue-evidence/requests/discover.json'), 'utf8'),
    ) as { key: string };
    expect(saved.key).toBe('discover');
    return JSON.stringify(
      req.op === 'capabilities' ? caps : { v: 1, action: 'created', state: 'queued' },
    );
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'discover',
    reachable: true,
  };
  expect(await op(input)).toMatchObject({ status: 'ok' });
  expect(
    await makeSubmit(async () => {
      throw new Error('network forbidden');
    })({ ...input, repo: 'other/repo' }),
  ).toMatchObject({ status: 'failed' });
});

for (const refusal of ['oversize', 'scanner'])
  test(`local snapshot ${refusal} refusal is failed without reconciliation advice`, async () => {
    await writeFile(
      join(cwd, 'file'),
      refusal === 'oversize' ? Buffer.alloc(5 * 1024 * 1024, 120) : 'changed',
    );
    await git('add', 'file');
    await git('commit', '-qm', 'head');
    const scanner = join(cwd, 'refusing-scanner');
    await writeFile(scanner, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const calls: string[] = [];
    const result = await makeSubmit(async (raw) => {
      calls.push((JSON.parse(raw) as { op: string }).op);
      return JSON.stringify(caps);
    })({ cwd, repo: 'owner/repo', target: 'target', scanner });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(
        refusal === 'oversize'
          ? 'snapshot content exceeds bound'
          : 'snapshot pre-upload scan refused',
      );
      expect(result.error).not.toContain('reconcile');
    }
    expect(calls).toEqual(['capabilities']);
  });
describe('snapshot scanner selection (explicit input, then CQ_AUTHOR_SNAPSHOT_SCANNER)', () => {
  // Each scanner records its argv to its own marker so the test proves which one ran.
  const recordingScanner = async (name: string, exit: number) => {
    const path = join(cwd, name);
    const marker = join(cwd, name + '.argv');
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nexit ${exit}\n`, {
      mode: 0o700,
    });
    return { path, marker };
  };
  const ran = (marker: string) =>
    access(marker).then(
      () => true,
      () => false,
    );
  const commitChange = async () => {
    await writeFile(join(cwd, 'file'), 'changed');
    await git('add', 'file');
    await git('commit', '-qm', 'head');
  };
  const submitWith = async (input: Record<string, unknown>) => {
    const calls: string[] = [];
    const result = await makeSubmit(async (raw) => {
      const wire = JSON.parse(raw) as { op: string };
      calls.push(wire.op);
      if (wire.op === 'capabilities') return JSON.stringify(caps);
      return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
    })({ cwd, repo: 'owner/repo', target: 'target', ...input });
    return { result, calls };
  };

  test('environment scanner is used when no explicit scanner is given', async () => {
    await commitChange();
    const env = await recordingScanner('env-scan', 0);
    vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', env.path);
    const { result, calls } = await submitWith({});
    expect(result.status).toBe('ok');
    expect(calls).toEqual(['capabilities', 'submit']);
    const argv = (await readFile(env.marker, 'utf8')).trim().split('\n');
    // argv is exactly repo, base, original head: no shell, no extra arguments.
    expect(argv).toEqual([
      await git('rev-parse', '--show-toplevel'),
      await git('rev-parse', 'target'),
      await git('rev-parse', 'HEAD'),
    ]);
  });

  test('explicit scanner wins over the environment scanner', async () => {
    await commitChange();
    const env = await recordingScanner('env-refusing-scan', 1);
    const explicit = await recordingScanner('explicit-scan', 0);
    vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', env.path);
    const { result, calls } = await submitWith({ scanner: explicit.path });
    expect(result.status).toBe('ok');
    expect(calls).toEqual(['capabilities', 'submit']);
    expect(await ran(explicit.marker)).toBe(true);
    expect(await ran(env.marker)).toBe(false);
  });

  test('an explicit invalid scanner is not replaced by the environment scanner', async () => {
    await commitChange();
    const env = await recordingScanner('env-scan', 0);
    vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', env.path);
    const { result, calls } = await submitWith({ scanner: 'relative-scan' });
    expect(result.status).toBe('needs-human');
    expect(calls).toEqual(['capabilities']);
    expect(await ran(env.marker)).toBe(false);
  });

  test('no explicit and no environment scanner fails closed as configuration, sending nothing', async () => {
    await commitChange();
    vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', undefined);
    const { result, calls } = await submitWith({});
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('absolute snapshot scanner');
    expect(calls).toEqual(['capabilities']);
  });

  for (const [label, value] of [
    ['relative', 'scan'],
    ['missing', '/nonexistent/cq-snapshot-scan'],
  ] as const)
    test(`a ${label} environment scanner fails closed as configuration`, async () => {
      await commitChange();
      vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', value);
      const { result, calls } = await submitWith({});
      expect(result.status).toBe('needs-human');
      expect(calls).toEqual(['capabilities']);
    });

  test('a refusing environment scanner refuses the submission, sending nothing', async () => {
    await commitChange();
    const env = await recordingScanner('env-refusing-scan', 1);
    vi.stubEnv('CQ_AUTHOR_SNAPSHOT_SCANNER', env.path);
    const { result, calls } = await submitWith({});
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toContain('snapshot pre-upload scan refused');
    expect(calls).toEqual(['capabilities']);
    expect(await ran(env.marker)).toBe(true);
  });
});
for (const action of ['created', 'joined'])
  test(`submit wait preserves ${action} admission action and returns observed state`, async () => {
    await writeFile(join(cwd, 'file'), 'head');
    await git('add', 'file');
    await git('commit', '-qm', 'head');
    const result = await makeSubmit(async (raw) => {
      const req = JSON.parse(raw) as { op: string };
      return JSON.stringify(
        req.op === 'capabilities'
          ? caps
          : req.op === 'submit'
            ? { v: 1, action, state: 'queued' }
            : { v: 1, action: 'observed', state: 'completed' },
      );
    })({ cwd, repo: 'owner/repo', target: 'target', reachable: true, waitMs: 100 });
    expect(result).toMatchObject({
      status: 'ok',
      value: { action, state: 'completed', waitOutcome: 'terminal' },
    });
  });

for (const options of [
  { repeat: true },
  { supersedes: 'prior-request' },
  { repeat: true, supersedes: 'prior-request' },
])
  test(`lost response restores omitted admission options ${JSON.stringify(options)}`, async () => {
    await writeFile(join(cwd, 'file'), 'head');
    await git('add', 'file');
    await git('commit', '-qm', 'head');
    const input = {
      cwd,
      repo: 'owner/repo',
      target: 'target',
      requestId: 'recover-options',
      reachable: true,
    };
    let lost = true;
    const submissions: string[] = [];
    const op = makeSubmit(async (raw) => {
      if ((JSON.parse(raw) as { op: string }).op === 'capabilities') return JSON.stringify(caps);
      submissions.push(raw);
      if (lost) throw new Error('response lost');
      return JSON.stringify({
        v: 1,
        action: 'joined',
        state: 'queued',
        request_id: input.requestId,
      });
    });
    const first = await op({ ...input, ...options });
    expect(first.status).toBe('indeterminate');
    lost = false;
    expect(
      await op({ cwd, repo: input.repo, target: input.target, requestId: input.requestId }),
    ).toMatchObject({ status: 'ok', value: { action: 'joined' } });
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toBe(submissions[0]);
    expect(await readdir(join(cwd, '.cq/queue-evidence/requests'))).toEqual([
      'recover-options.json',
    ]);
  });
for (const [original, conflict] of [
  [{ repeat: true }, { repeat: false }],
  [{ supersedes: 'prior-request' }, { supersedes: 'different-request' }],
  [{}, { repeat: true }],
  [{}, { supersedes: 'new-predecessor' }],
] as const)
  test(`explicitly conflicting retry options are refused ${JSON.stringify(original)} -> ${JSON.stringify(conflict)}`, async () => {
    await writeFile(join(cwd, 'file'), 'head');
    await git('add', 'file');
    await git('commit', '-qm', 'head');
    const input = {
      cwd,
      repo: 'owner/repo',
      target: 'target',
      requestId: 'conflict-options',
      reachable: true,
    };
    let calls = 0;
    const op = makeSubmit(async (raw) => {
      calls++;
      return JSON.stringify(
        (JSON.parse(raw) as { op: string }).op === 'capabilities'
          ? caps
          : { v: 1, action: 'created', state: 'queued' },
      );
    });
    expect((await op({ ...input, ...original })).status).toBe('ok');
    const before = calls;
    expect(await op({ ...input, ...conflict })).toMatchObject({
      status: 'failed',
      error: 'requestId is already bound to different inputs',
    });
    expect(calls).toBe(before);
  });
test('explicit repeat=false on retry matches an omitted persisted repeat default', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const submissions: string[] = [];
  const op = makeSubmit(async (raw) => {
    if ((JSON.parse(raw) as { op: string }).op === 'capabilities') return JSON.stringify(caps);
    submissions.push(raw);
    return JSON.stringify({ v: 1, action: 'joined', state: 'queued' });
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'default-options',
    reachable: true,
  };
  expect((await op(input)).status).toBe('ok');
  expect((await op({ ...input, repeat: false })).status).toBe('ok');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toBe(submissions[0]);
});

test('cached snapshots exceeding the decoded limit are refused before submit dispatch', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const calls: string[] = [];
  const op = makeSubmit(async (raw) => {
    const { op } = JSON.parse(raw) as { op: string };
    calls.push(op);
    return JSON.stringify(
      op === 'capabilities' ? caps : { v: 1, action: 'created', state: 'queued' },
    );
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'cached-bound',
    reachable: true,
  };
  expect(await op(input)).toMatchObject({ status: 'ok' });
  const path = join(cwd, '.cq/queue-evidence/requests/cached-bound.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as { wire: { snapshot?: unknown } };
  const snapshot = {
    v: 1,
    tree: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    objects: [
      { oid: 'c'.repeat(40), type: 'blob', data: Buffer.alloc(3145729, 120).toString('base64') },
    ],
  };
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(caps.limits.max_snapshot_bytes);
  record.wire.snapshot = snapshot;
  await writeFile(path, JSON.stringify(record));
  calls.length = 0;
  expect(await op(input)).toMatchObject({
    status: 'failed',
    error: 'snapshot content exceeds bound',
  });
  expect(calls).toEqual(['capabilities']);
});

async function commitContent(content: string) {
  await writeFile(join(cwd, 'file'), content);
  await git('add', 'file');
  await git('commit', '-qm', content);
  return git('rev-parse', 'HEAD');
}
function reachableSubmit() {
  const wires: { inputs: { base_commit: string } }[] = [];
  const op = makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as { op: string; inputs: { base_commit: string } };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    wires.push(wire);
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  });
  return { op, wires };
}
test('stale local target reports upstream divergence without moving the base', async () => {
  const local = await git('rev-parse', 'target');
  const upstream = await commitContent('upstream');
  await git('update-ref', 'refs/remotes/origin/target', upstream);
  await git('config', 'remote.origin.url', '.');
  await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await git('config', 'branch.target.remote', 'origin');
  await git('config', 'branch.target.merge', 'refs/heads/target');
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  const input = { cwd, repo: 'owner/repo', target: 'target', reachable: true, requestId: 'stale' };
  expect(await op(input)).toMatchObject({
    status: 'ok',
    value: { targetFreshness: { local, upstream, ahead: 0, behind: 1 } },
  });
  expect(wires[0]?.inputs.base_commit).toBe(local);
  const newer = await commitContent('newer');
  await git('update-ref', 'refs/remotes/origin/target', newer);
  await git('update-ref', 'refs/heads/target', newer);
  expect(await op(input)).toMatchObject({
    status: 'ok',
    value: { targetFreshness: { local, upstream, ahead: 0, behind: 1 } },
  });
  expect(wires[1]).toEqual(wires[0]);
  expect(wires[0]).not.toHaveProperty('targetFreshness');
});
test('explicit base selects an ancestor and refuses a different base on retry', async () => {
  const base = await commitContent('middle');
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    reachable: true,
    requestId: 'explicit-base',
    base,
  };
  expect(await op(input)).toMatchObject({ status: 'ok' });
  expect(wires[0]?.inputs.base_commit).toBe(base);
  expect(await op({ ...input, base: 'target' })).toMatchObject({ status: 'failed' });
  expect(wires).toHaveLength(1);
});
test('explicit base must be an ancestor of HEAD before any network call', async () => {
  await git('checkout', '-qb', 'other');
  const base = await commitContent('other');
  await git('checkout', '-q', 'target');
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  expect(
    await op({ cwd, repo: 'owner/repo', target: 'target', base, reachable: true }),
  ).toMatchObject({ status: 'failed', error: expect.stringContaining('ancestor') as unknown });
  expect(wires).toHaveLength(0);
});
test('remote-only target resolves a unique origin tracking ref', async () => {
  const base = await git('rev-parse', 'target');
  await git('update-ref', 'refs/remotes/origin/remote-target', base);
  await git('update-ref', 'refs/remotes/origin/topic/remote-target', base);
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  expect(
    await op({ cwd, repo: 'owner/repo', target: 'remote-target', reachable: true }),
  ).toMatchObject({
    status: 'ok',
  });
  expect(wires[0]?.inputs.base_commit).toBe(base);
});
test('remote-only target refuses multiple remotes, but explicit remote ref works', async () => {
  const base = await git('rev-parse', 'target');
  await git('update-ref', 'refs/remotes/origin/remote-target', base);
  await git('update-ref', 'refs/remotes/other/remote-target', base);
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  expect(
    await op({ cwd, repo: 'owner/repo', target: 'remote-target', reachable: true }),
  ).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('ambiguous') as unknown,
  });
  expect(wires).toHaveLength(0);
  expect(
    await op({
      cwd,
      repo: 'owner/repo',
      target: 'refs/remotes/origin/remote-target',
      reachable: true,
    }),
  ).toMatchObject({ status: 'ok' });
});
test('target branch and tag collision is refused even when commits coincide', async () => {
  await git('tag', 'target');
  await commitContent('feature');
  const { op, wires } = reachableSubmit();
  expect(await op({ cwd, repo: 'owner/repo', target: 'target', reachable: true })).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('ambiguous') as unknown,
  });
  expect(wires).toHaveLength(0);
});
